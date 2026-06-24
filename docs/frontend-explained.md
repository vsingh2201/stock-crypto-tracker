# Pulse Dashboard Frontend — Implementation Walkthrough

This document explains the React frontend in `client/src` in enough depth to
understand the implementation without opening the source files. It covers the
component tree, the chart implementation, the mock data layer, state
management, the WebSocket-shaped data hook, the TypeScript type model, named
design patterns, and a set of interview-style Q&A about the codebase.

## Component Tree

```
App
└── Dashboard                    (container — owns state)
    ├── TopBar                   (static, no props)
    ├── Chart                    (presentational)
    ├── Watchlist                (presentational, list + selection)
    ├── Search                   (semi-controlled, owns query/open state)
    ├── AlertModal (conditional) (semi-controlled, owns direction/target state)
    └── Toast (conditional)      (dumb, one prop)
```

`Dashboard.tsx` is the only component that calls the data hook
(`useMarketFeed`). Everything else is a prop-receiver. This is the classic
**container/presentational split**: one place owns "what is true right now,"
everything downstream just renders it.

Props flow, concretely:

- **`Dashboard` → `Chart`**: `candles`, `timeframe`, `gainColor`, `lossColor`,
  `lastPriceColor`, `showVolume`
- **`Dashboard` → `Watchlist`**: `items` (the full `WatchlistItem[]`),
  `selected` (symbol string), `gainColor`/`lossColor`, and `onSelect` — which
  is literally `feed.selectSymbol` passed straight through, with no wrapper
- **`Dashboard` → `Search`**: `watchlist` (so it can mark "already added")
  and `onAdd`, a closure that calls `feed.addSymbol` *and* triggers the toast
- **`Dashboard` → `AlertModal`**: the resolved `selectedQuote` object, plus
  `onClose`/`onCreate` closures

### Interviewer angles

- *"Why doesn't `Watchlist` call a context or a store instead of taking
  `onSelect` as a prop?"* — The app is small enough that prop-drilling one
  level is simpler and more explicit than Context/Redux; there's only one
  consumer of the state, so lifting further would be premature.
- *"Why does `TopBar` take no props?"* — It's currently 100% static mock UI
  (the "Markets open" indicator and avatar aren't wired to anything real
  yet). A natural follow-up is "how would you wire that up" — it'd need its
  own slice of state, or a prop from `Dashboard`, once there's a real
  session/market-hours source.

## Charting Library

**There isn't one.** The candlestick + volume chart in `Chart.tsx` is built
from scratch using absolutely-positioned `<div>`s — no Recharts, no
`lightweight-charts`, no visx.

### How it's built

A `useMemo` computes "geometry" once per render of `candles`/colors:

1. Find `min`/`max` across all candle highs/lows.
2. Pad the range by 8%.
3. Define `topOf(price) = (max - price) / range * 100`, which converts any
   price into a percentage-from-top of the chart area.
4. Map each candle to `{ wickTop, wickHeight, bodyTop, bodyHeight, color }`.
5. Render two stacked absolutely-positioned divs per candle inside a flex
   item: a 1.5px-wide wick and a wider body.
6. Volume bars are a second flex row, computed the same way from each
   candle's `volume`.
7. Y-axis labels are 5 evenly-spaced gridlines computed from the same
   `min`/`max`/`range`; X-axis labels come from a static lookup table keyed
   by timeframe (`1D`/`1W`/`1M`).

### Why no library

The design spec being implemented (a Claude Design `.dc.html` file) was
itself authored as raw absolutely-positioned divs with inline styles —
porting that 1:1 into divs and CSS was the fastest way to match it
pixel-for-pixel, including a bespoke design system (specific corner radii, a
dashed last-price line, a colored price tag that follows the latest close).

A library like Recharts or `lightweight-charts` would have fought that:

- Recharts has **no native OHLC/candlestick chart type** — you fake one with
  custom shape components, which ends up being roughly as much code as the
  hand-rolled version, without the layout control.
- `lightweight-charts` renders to `<canvas>`, which means losing CSS-level
  control over the specific gradients/box-shadows/animations this design
  uses elsewhere on the page, and needing a second styling system just for
  the chart.

For a fixed, non-zoomable, non-pannable view with no crosshair/tooltip
requirement, hand-rolled divs were simpler and avoided a dependency.

### Interviewer angle

*"What would make you reach for a real charting library instead?"* — The
moment the chart needs zoom/pan, a hover-crosshair-with-tooltip, log-scale
axes, or has to render thousands of candles. Divs don't virtualize the way a
canvas surface does, so `lightweight-charts` (purpose-built for OHLC,
canvas-based, handles 10k+ points fine) would be the natural switch.

## Mock Data Structure

Two pieces make up the mock data layer:

- **`data/universe.ts`** — a static array `UNIVERSE` of
  `Instrument & { seedPrice }` (17 hardcoded symbols spanning crypto/stock),
  plus `SEED_WATCHLIST`, a small array of `{ symbol, changePct }` declaring
  which 7 symbols start in the watchlist and at what change percentage. This
  stands in for what would eventually be a symbol-search/lookup API.
- **`lib/marketMath.ts`** — `genCandles(endPrice, changePct, timeframe)`
  synthesizes an OHLCV array: it interpolates a price path from a
  back-computed `start` price to `endPrice`, adds randomized noise scaled by
  a per-timeframe volatility factor, then derives `open`/`high`/`low`/`close`/
  `volume` per candle from consecutive closes.

### There is no separate "tick" type

The thing that actually *changes* over time isn't represented as a discrete
event object passed around the app. It's produced inside `useMarketFeed`'s
`setInterval`: every 1300ms, the hook mutates a copy of the *last* candle's
`close`/`high`/`low` with a small random walk, and nudges every watchlist
item's `price`/`changePct` the same way. That mutated state is what flows
into `Chart` as `candles` and into `Watchlist` as `items`.

### Interviewer angle

*"Why didn't you model a `Tick` type separately from `Candle`?"* — Because
the mock only ever updates the most recent candle in place; there's no
discrete tick event being passed around, so a separate type would have no
use yet. That changes the moment a real feed sends one trade message at a
time — see the WebSocket Hook section below.

## State Management

State lives in exactly two places:

1. **`useMarketFeed`** (called once, in `Dashboard`) owns the "market" state:
   `watchlist`, `connection`, `selected`, `timeframe`, `candles`. This is the
   state multiple components need to read, so it's lifted to the one common
   ancestor.
2. **Local component state** for anything UI-local and not needed elsewhere:
   `Search` owns `query`/`open`; `AlertModal` owns `direction`/`target`;
   `Dashboard` itself owns `alertOpen` (modal visibility) and `toast`
   (message text plus a `setTimeout` ref used to auto-dismiss it).

### Selecting a new watchlist symbol → chart update, step by step

1. User clicks a row in `Watchlist` → `onClick` fires `onSelect(w.symbol)`,
   which is `feed.selectSymbol` (passed through unchanged from `Dashboard`).
2. `selectSymbol` (inside `useMarketFeed`) does two things: calls
   `setSelected(symbol)`, and looks up that symbol's current
   `price`/`changePct` from `watchlistRef.current` — a ref mirroring the
   watchlist, used specifically to avoid stale-closure bugs — then calls
   `setCandles(genCandles(price, changePct, timeframeRef.current))`, seeding
   a fresh candle series at that symbol's current price.
3. Both state updates cause `Dashboard` to re-render: `selectedQuote` is
   recomputed (`feed.watchlist.find(w => w.symbol === feed.selected)`), and
   `feed.candles` (now the new series) is the value passed into
   `<Chart candles={feed.candles} .../>`.
4. `Chart`'s `useMemo` depends on `[candles, gainColor, lossColor]`, so it
   recomputes geometry and re-renders the new candle set.

### Interviewer angle

*"Why use refs (`watchlistRef`, `timeframeRef`, `candlesRef`) instead of just
reading state directly in `selectSymbol`?"* — `selectSymbol`/`setTimeframe`
are `useCallback`s with an empty or minimal dependency array, used inside a
`setInterval` closure that's set up once in a `useEffect`. Without refs, the
closure would capture stale values from whenever the effect last ran,
producing wrong calculations after the first watchlist tick. Refs let the
code read the *current* value without re-creating the interval or widening
the callback's dependency list (which would otherwise force `selectSymbol` to
change identity every render, breaking memoization downstream).

## WebSocket Hook

Despite the name, there's no `WebSocket` object anywhere yet —
`useMarketFeed` in `src/hooks/useMarketFeed.ts` is the seam where one will
go. Today it:

- Seeds `watchlist` and `candles` from the static mock data on mount.
- Runs a `setInterval` every 1300ms that:
  - has a 3.5% chance to flip `connection` to `'reconnecting'` and snap back
    next tick,
  - randomly walks the last candle's close/high/low,
  - randomly walks every watchlist item's price within a type-dependent
    drift band (crypto drifts more than stocks),
  - syncs the selected symbol's displayed price to match the candle close so
    the header and the chart never disagree.
- Exposes the same shape a real feed would:
  `{ watchlist, connection, selected, timeframe, candles, selectSymbol, setTimeframe, addSymbol }`.

### What changes when the real backend connects

The `setInterval` body gets replaced by a `ws.onmessage` handler that parses
whatever the relay server forwards from Finnhub (trade prints, or aggregated
bars) and applies the *same* state-shape updates (`setWatchlist`,
`setCandles`). `connection` becomes driven by the socket's
`onopen`/`onclose`/`onerror` instead of `Math.random()`. Crucially, because
the hook's **return shape doesn't change**, none of `Dashboard`, `Chart`, or
`Watchlist` need to be touched — that's the entire point of isolating this
behavior behind a hook.

### Interviewer angle

*"How would you handle backpressure if Finnhub sends ticks faster than React
can re-render?"* — Batch incoming messages in a ref/buffer and flush them on
a `requestAnimationFrame` or fixed interval rather than calling `setState`
per message. This is actually exactly what the current mock already does
(batches per-interval rather than per-event), so it's a closer model of the
real constraint than it might first appear.

## TypeScript Types

The full contents of `src/types.ts`:

```ts
export type InstrumentType = 'crypto' | 'stock';

export interface Instrument {
  symbol: string;
  name: string;
  exchange: string;
  type: InstrumentType;
}

export interface Quote extends Instrument {
  price: number;
  changePct: number;
}

export interface WatchlistItem extends Quote {
  spark: number[];
}

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = '1D' | '1W' | '1M';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export interface AlertCondition {
  symbol: string;
  direction: 'above' | 'below';
  target: number;
}
```

### The hierarchy

The `Instrument → Quote → WatchlistItem` chain is deliberate:

- `Instrument` is static identity (`symbol`/`name`/`exchange`/`type`) — it
  never changes once an instrument exists.
- `Quote` adds the live numbers (`price`, `changePct`).
- `WatchlistItem` adds `spark` — the 16-point sparkline series rendered in
  each watchlist row.

This mirrors reality: a search result is an `Instrument`, a watchlist row is
a `WatchlistItem`, and the header / alert modal both only need a `Quote`.

There is **no `Tick` or `PriceTick` type** — see the Mock Data Structure
section above for why. There's also no discriminated union on
`AlertCondition.direction` beyond the literal `'above' | 'below'` string
union, which is enough for the current single-condition-type alert UI. If
alerts grew more condition types (e.g. percent change, volume spike), that
field would be a natural place to introduce a tagged union.

### Interviewer angle

*"Why `extends` instead of composing with intersection types
(`Instrument & {price...}`)?"* — Both work; `extends` reads better in an
interface-only codebase and gives cleaner error messages on excess-property
checks. Intersections become more idiomatic once utility types like
`Pick`/`Omit` are mixed in — which `lib/iconFor.ts` actually does, taking
`Pick<Instrument, 'symbol' | 'type'>` as its parameter type, a good example
of narrowing a function's contract to only the fields it actually needs.

## Notable Patterns

- **Custom hook as a data-access seam** (`useMarketFeed`) — isolates "where
  does data come from" from "how is it displayed," so swapping mock → real
  WebSocket is a one-file change.
- **Container/presentational split** — `Dashboard` is the only
  stateful/connected component; `Chart`, `Watchlist`, `Toast` are pure
  functions of their props.
- **Derived state via `useMemo`, not stored state** — `Chart`'s geometry
  (pixel/percentage positions) is computed from `candles` on every relevant
  change rather than stored in `useState`, avoiding a second source of truth
  that could drift from the candles themselves.
- **Refs for "latest value in a stable closure"** — the
  `candlesRef`/`timeframeRef`/`watchlistRef` pattern in `useMarketFeed`, a
  recognized React idiom for escaping the stale-closure trap in
  intervals/event listeners without growing `useEffect` dependency arrays.
- **Pure utility functions separated from components**
  (`lib/marketMath.ts`, `lib/iconFor.ts`) — none of these touch React; they
  are independently testable and reused across `Chart`/`Watchlist`/`Search`/
  `AlertModal`.
- **Local-vs-lifted state by audience, not by convention** — state is
  colocated with the component that owns it unless two or more components
  need it, rather than defaulting everything into one global store.

## Interview Q&A

### Q1: "Walk me through what happens, end to end, when I click a different symbol in the watchlist."

Click fires `Watchlist`'s `onClick` → calls `onSelect(symbol)`, which is
`feed.selectSymbol` passed down from `Dashboard`. Inside `useMarketFeed`,
`selectSymbol` updates `selected` state and looks up that symbol's current
price/changePct from a ref (to avoid stale closures), then regenerates a
fresh `Candle[]` via `genCandles` seeded at that price. Both state changes
propagate back up through `Dashboard`'s re-render, which recomputes
`selectedQuote` and passes the new `candles` array into `Chart`, whose
`useMemo` recalculates pixel geometry and re-renders.

### Q2: "Why is `connection` status currently random instead of tied to anything real?"

Because there's no socket yet — `connection` is a placeholder that exercises
the same UI states (`connected`/`reconnecting`/`disconnected`) a real
WebSocket would produce via `onopen`/`onerror`/`onclose`, so the
`Dashboard`'s status pill and its styling are already correct and won't need
rework — only the *source* of the state transition changes.

### Q3: "Your chart is built from divs, not canvas or SVG. What are the performance implications, and when would that become a problem?"

Each candle is 2 DOM nodes (wick + body) plus a volume bar — fine at dozens
of candles (this app caps at 48), but it'd degrade with thousands, since the
browser has to layout/paint that many elements vs. a canvas chart drawing
pixels directly. The fix would be switching to a canvas-based library like
`lightweight-charts` if the timeframe needed to show, say, a full year of
1-minute candles.

### Q4: "How would you avoid prop-drilling if this app grew to have a sidebar, a portfolio page, and this dashboard, all needing the watchlist?"

Lift `useMarketFeed`'s state into a Context provider wrapping the app (or a
small store like Zustand/Jotai) once more than one route/page needs it —
right now `Dashboard` is the sole consumer, so Context would just be
indirection without benefit. The threshold for introducing it is "more than
one branch of the tree needs this," not "more than one component."

### Q5: "Your `useMarketFeed` hook does a lot — watchlist, candles, connection, selection, timeframe. Would you split it up?"

Split it once those concerns start changing for different reasons — e.g. if
"connection status" needs reconnect/backoff logic independent of tick
cadence, that's a `useConnectionStatus` hook on its own. Right now they're
coupled because the mock's `setInterval` updates them together, but the real
implementation will likely separate "socket lifecycle" from "applying a
message to state," which is a natural seam to split the hook along.
