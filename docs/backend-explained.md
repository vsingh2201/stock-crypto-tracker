# Pulse Relay Server — Backend Implementation Walkthrough

This document explains the Node.js WebSocket relay server in `server/src/` in
enough depth to walk into a technical interview and talk confidently about every
decision. All explanations are grounded in the actual code — file names, line
numbers, and method signatures are exact.

---

## 1. Architecture Overview

### The relay / proxy pattern

The server sits between two WebSocket connections it owns simultaneously:

```
Browser clients          Relay server (port 8080)       Finnhub
──────────────           ────────────────────────       ───────
React frontend  ←──ws──→  clientManager                ←──ws──→  wss://ws.finnhub.io
React frontend  ←──ws──→  (N downstream connections)
React frontend  ←──ws──→
```

The relay pattern solves two distinct problems:

**Problem 1 — API key security.** Finnhub requires a secret API key to
authenticate the WebSocket connection. If the browser connected directly to
Finnhub, that key would be visible in DevTools to any user. By running the
relay server, the key lives only in `server/.env`, which is gitignored and
never sent to the browser.

**Problem 2 — Connection efficiency.** Finnhub's free tier limits the number
of concurrent connections and subscriptions. If 50 browser tabs all connected
directly to Finnhub and subscribed to AAPL, you'd consume 50 upstream
connections and 50 subscription slots for one symbol. The relay collapses all
of those into a **single upstream connection** and a **single AAPL
subscription**, regardless of how many browsers are watching it. The relay
fans the one incoming tick out to all interested clients.

### How the three files divide responsibility

The design follows the **single-responsibility principle** cleanly across
three files:

| File | Responsibility |
|---|---|
| `finnhubClient.ts` | Owns the one upstream connection to Finnhub — its lifecycle, reconnect logic, and subscription state |
| `clientManager.ts` | Owns all downstream browser connections — tracks who is watching what, routes ticks, handles cleanup |
| `index.ts` | Wiring only — creates the HTTP/WS server, handles the Upgrade handshake, and delegates every event to the two classes above |

`index.ts` is deliberately thin. It contains no business logic; it translates
network events into method calls. This means `FinnhubClient` and
`ClientManager` can be read and tested in isolation without thinking about
HTTP headers or socket events.

---

## 2. `types.ts` — The Message Contract

There are four distinct message shapes in this system, and they flow in
different directions. `types.ts` gives each one a named type.

### Browser → relay: `ClientMessage`

```typescript
export interface ClientSubscribeMsg {
  type: 'subscribe';
  symbol: string;
}

export interface ClientUnsubscribeMsg {
  type: 'unsubscribe';
  symbol: string;
}

export type ClientMessage = ClientSubscribeMsg | ClientUnsubscribeMsg;
```

`ClientMessage` is a **discriminated union** keyed on `type`. In `index.ts`,
when a raw WebSocket frame arrives from a browser, it's parsed and cast to
`ClientMessage`. TypeScript then narrows the type in each branch:

```typescript
if (type === 'subscribe') { /* TypeScript knows: symbol is defined */ }
```

Without the union, `index.ts` would have to defensively check every field and
could silently do the wrong thing with a malformed message.

### Relay → browser: `ServerMessage`

```typescript
export interface TickMessage {
  type: 'tick';
  symbol: string;
  price: number;
  timestamp: number;
  volume: number;
}

export interface StatusMessage {
  type: 'status';
  status: 'connected' | 'reconnecting' | 'disconnected';
}

export type ServerMessage = TickMessage | StatusMessage;
```

The React frontend (`client/src/hooks/useMarketFeed.ts`) mirrors these shapes
and switches on `msg.type` to decide whether to update the chart or the
connection status pill. Having the same union in both codebases means any
change to what the relay sends immediately breaks the frontend types at compile
time — you catch mismatches before runtime.

### Finnhub → relay: `FinnhubMessage`

```typescript
export interface FinnhubTrade {
  p: number; // price
  s: string; // symbol
  t: number; // timestamp (ms epoch)
  v: number; // volume
}

export interface FinnhubTradeMsg {
  type: 'trade';
  data: FinnhubTrade[];
}

export interface FinnhubPingMsg {
  type: 'ping';
}

export type FinnhubMessage = FinnhubTradeMsg | FinnhubPingMsg;
```

Finnhub's wire format uses single-letter field names (`p`, `s`, `t`, `v`) to
minimize payload size — they're transmitting millions of ticks and every byte
counts. The relay doesn't forward this shape to browsers; it translates it into
the more readable `TickMessage` shape. That's why there's a fourth internal
type:

### Internal: `PriceTick`

```typescript
export interface PriceTick {
  symbol: string;
  price: number;
  timestamp: number;
  volume: number;
}
```

`PriceTick` is the normalized form that crosses the boundary between
`FinnhubClient` and `ClientManager`. `FinnhubClient.onTick` emits it;
`ClientManager.broadcast` consumes it. Neither class knows or cares about the
other's wire format — the translation happens at the seam in `index.ts`.

### Why explicit types for each direction matter

In a WebSocket system where everything is `string` over the wire, the types
serve as documentation of the protocol. When something breaks — a Finnhub API
change, a new field, a renamed status — TypeScript narrows the blast radius to
the exact interface that needs updating, rather than requiring a grep through
every `JSON.parse` call in the codebase.

---

## 3. `finnhubClient.ts` — The Upstream Connection

### Class state

```typescript
private ws: WebSocket | null = null;
private subscribedSymbols = new Set<string>();
private reconnectAttempt = 0;
private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
private destroyed = false;
```

- `ws` — the live socket, or `null` between connections.
- `subscribedSymbols` — the **source of truth** for what Finnhub should be
  streaming. This set lives on the class, not on the socket, so it survives
  reconnects. On every fresh `open` event, the entire set is re-subscribed.
- `reconnectAttempt` — the backoff exponent. Resets to `0` on a successful
  open so a recovered connection starts with the minimum delay again.
- `destroyed` — a flag set by `destroy()` that prevents reconnect scheduling
  after a deliberate shutdown. Without it, `connect()` would be re-entered
  after `ws.close()` fires the `close` event.

### Connection lifecycle

```typescript
connect(): void {
  if (this.destroyed) return;
  const url = `${FINNHUB_WS_URL}?token=${this.options.apiKey}`;
  this.ws = new WebSocket(url);
  ...
}
```

The API key goes in the query string — Finnhub's documented authentication
mechanism for WebSocket connections. This URL is only constructed on the server,
never sent to the browser.

**`on('open')`**: resets `reconnectAttempt` to `0`, calls
`onStatusChange('connected')`, then re-fires a `subscribe` frame for every
symbol in `subscribedSymbols`. Finnhub does not persist subscriptions across
connections — when the socket closes and reopens, the server starts fresh with
zero subscriptions. If the relay didn't replay the full set here, every browser
client would silently stop receiving ticks after any reconnect.

**`on('message')`**: parses the raw frame, guards against non-`trade` messages
(Finnhub also sends `ping` frames — the relay ignores them), then iterates
`msg.data`. Note the guard:

```typescript
if (!this.subscribedSymbols.has(trade.s)) continue;
```

This handles a race condition: when the relay sends Finnhub an `unsubscribe`
frame, Finnhub may already have one or more ticks for that symbol in-flight.
Without this check, those orphaned ticks would be forwarded to browsers that
have already unsubscribed.

**`on('error')`**: logs only. In Node.js's `ws` library, an `error` event
always fires immediately before the `close` event on a failed connection. If
reconnection were scheduled here, it would be scheduled twice (once on `error`,
once on `close`). The convention is to let `close` own all reconnection logic.

**`on('close')`**: calls `onStatusChange('reconnecting')` and invokes
`scheduleReconnect()`. Checks `this.destroyed` first so that an intentional
`destroy()` call — which closes the socket — doesn't trigger reconnect.

### Exponential backoff

```typescript
private scheduleReconnect(): void {
  const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS);
  this.reconnectAttempt++;
  this.reconnectTimer = setTimeout(() => this.connect(), delay);
}
```

The delay sequence: 1 s → 2 s → 4 s → 8 s → 16 s → 30 s → 30 s → …

The cap at `MAX_BACKOFF_MS = 30_000` (30 seconds) is deliberate: without a cap,
`2 ** 20` is ~12 days, meaning the server would effectively give up after
enough retries. 30 seconds is aggressive enough to recover quickly from a
transient Finnhub outage while not hammering the API during an extended
incident.

### Why callbacks instead of direct references

`FinnhubClient` calls `options.onTick` and `options.onStatusChange` — it does
**not** import `ClientManager`. This keeps the dependency graph acyclic:
`FinnhubClient` knows nothing about browser clients, and `ClientManager` knows
nothing about Finnhub. `index.ts` is the only file that knows about both.
Swapping either class for a different implementation (e.g., replacing Finnhub
with a different data provider) requires changing only `index.ts`.

---

## 4. `clientManager.ts` — The Subscription Registry

### The two mirrored Maps

```typescript
private clientSymbols = new Map<WebSocket, Set<string>>();
private symbolClients = new Map<string, Set<WebSocket>>();
```

These two Maps are inverses of each other, kept in sync by every mutating
method. To understand why both are needed, consider the two hot paths:

**Hot path 1 — a tick arrives for AAPL.** The question is: *which clients
should receive it?* `symbolClients.get('AAPL')` answers this in O(1). Without
this Map, the relay would have to scan all clients and check each one's symbol
set — O(clients × symbols per client).

**Hot path 2 — a client disconnects.** The question is: *which symbols did
this client care about, and which of those now have zero watchers?*
`clientSymbols.get(ws)` answers the first part in O(1). Without this Map, the
relay would have to scan all symbols to find which ones contained this client.

Having both Maps means every operation is O(1) or O(symbols for that client)
— never a full scan of all connected clients.

### `subscribe(ws, symbol) → boolean`

```typescript
subscribe(ws: WebSocket, symbol: string): boolean {
  const symSet = this.clientSymbols.get(ws);
  if (!symSet) return false;
  symSet.add(symbol);                          // client → symbol

  if (!this.symbolClients.has(symbol)) {
    this.symbolClients.set(symbol, new Set());
  }
  const clients = this.symbolClients.get(symbol)!;
  const isFirst = clients.size === 0;          // is this the first subscriber?
  clients.add(ws);                             // symbol → client
  return isFirst;
}
```

The return value `isFirst` is the mechanism by which the relay avoids
unnecessary upstream subscriptions. In `index.ts`:

```typescript
const isFirst = clientManager.subscribe(ws, symbol);
if (isFirst) finnhub.subscribe(symbol);
```

If 10 clients all subscribe to AAPL, `FinnhubClient.subscribe('AAPL')` is
called exactly once — on the first subscribe call when `isFirst` is `true`. The
other nine calls return `false` and are silent.

### `unsubscribe(ws, symbol) → boolean`

The mirror of `subscribe`. Returns `true` (isEmpty) only when the symbol's
client set hits zero. `index.ts` uses this to decide when to send Finnhub an
unsubscribe frame:

```typescript
const isEmpty = clientManager.unsubscribe(ws, symbol);
if (isEmpty) finnhub.unsubscribe(symbol);
```

Finnhub charges against subscription counts. Keeping unnecessary subscriptions
active wastes quota and means the relay receives ticks it immediately discards,
adding CPU and network overhead.

### `removeClient(ws) → string[]`

```typescript
removeClient(ws: WebSocket): string[] {
  const symbols = this.clientSymbols.get(ws);
  if (!symbols) return [];

  this.clientSymbols.delete(ws);

  const nowEmpty: string[] = [];
  for (const sym of symbols) {
    const clients = this.symbolClients.get(sym);
    if (!clients) continue;
    clients.delete(ws);
    if (clients.size === 0) {
      this.symbolClients.delete(sym);
      nowEmpty.push(sym);
    }
  }
  return nowEmpty;
}
```

Called by `index.ts` on every `ws.on('close')` event. Returns the list of
symbols that hit zero watchers as a result of this disconnect. `index.ts` then
calls `finnhub.unsubscribe(sym)` for each one. This is the automated cleanup
path — the browser client doesn't have to send explicit unsubscribe frames on
disconnect.

### `broadcast(tick: PriceTick)`

```typescript
broadcast(tick: PriceTick): void {
  const clients = this.symbolClients.get(tick.symbol);
  if (!clients || clients.size === 0) return;

  const payload = JSON.stringify({ type: 'tick', ...tick });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
```

Two performance points worth noting:

1. `JSON.stringify` is called **once**, outside the loop. If 50 clients are
   watching AAPL, the tick is serialised once and the same string is sent 50
   times. Serialising inside the loop would be 50× slower.
2. The `readyState === WebSocket.OPEN` check guards against clients that are
   in the process of closing — their socket is in the `CLOSING` state and
   `send()` would throw.

### `broadcastAll(payload: string)`

Iterates `clientSymbols.keys()` (all connected clients) and sends a
pre-serialised string. Used for status changes (`connected`, `reconnecting`,
`disconnected`) — every browser client should know the Finnhub upstream state
regardless of which symbols they're watching.

---

## 5. `index.ts` — The Wiring Layer

### Why an HTTP server is needed at all

A WebSocket connection starts as an HTTP `GET` request with an `Upgrade:
websocket` header. Wrapping the WebSocket server around an HTTP server (rather
than using `WebSocketServer({ port: 8080 })` directly) gives access to the raw
HTTP request during the upgrade — specifically the `Origin` header, which is
what `verifyClient` inspects.

```typescript
const wss = new WebSocketServer({
  server,
  verifyClient: (info: { origin: string; req: http.IncomingMessage; secure: boolean }) => {
    const origin = info.origin;
    return !origin || ALLOWED_ORIGINS.has(origin);
  },
});
```

Browsers always send an `Origin` header on WebSocket upgrades. If a page from
an unexpected origin (e.g., a different domain trying to scrape your relay)
attempts to connect, `verifyClient` returns `false` and the server responds with
`HTTP 401`. The React dev server at `localhost:5174` is in `ALLOWED_ORIGINS`;
`curl` and other non-browser clients send no origin and are allowed through for
testing.

The HTTP server also provides a health endpoint: `GET /` returns `200 Pulse
relay — WebSocket endpoint`, which is useful for monitoring.

### Full browser client lifecycle

**Connect:**
```typescript
wss.on('connection', (ws: WebSocket, req) => {
  clientManager.addClient(ws);
  // ...
});
```
`addClient` registers the client with an empty symbol set. From this point the
relay knows about this client.

**Subscribe/unsubscribe messages:**
```typescript
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString()) as ClientMessage;
  const { type, symbol } = msg;

  if (type === 'subscribe') {
    const isFirst = clientManager.subscribe(ws, symbol);
    if (isFirst) finnhub.subscribe(symbol);
  } else if (type === 'unsubscribe') {
    const isEmpty = clientManager.unsubscribe(ws, symbol);
    if (isEmpty) finnhub.unsubscribe(symbol);
  }
});
```
The `try/catch` around `JSON.parse` silently drops malformed frames. `index.ts`
does not assume the client sends valid JSON.

**Disconnect:**
```typescript
ws.on('close', () => {
  const freed = clientManager.removeClient(ws);
  for (const sym of freed) {
    finnhub.unsubscribe(sym);
  }
});
```
`removeClient` handles all the bookkeeping; `index.ts` only needs to act on
its return value.

### Graceful shutdown

```typescript
function shutdown() {
  finnhub.destroy();   // sets destroyed=true, clears reconnect timer, closes upstream socket
  wss.close();         // stops accepting new connections
  server.close(() => process.exit(0)); // waits for in-flight HTTP requests to complete
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

`SIGINT` is what Ctrl-C sends in the terminal. `SIGTERM` is what `systemd`,
`docker stop`, and most process managers send. Without these handlers, killing
the process abruptly would:
- Leave the Finnhub WebSocket half-open until their server times it out,
  consuming a connection slot.
- Drop connected browser clients without a clean close frame, causing them to
  see an error rather than a graceful disconnect and triggering their reconnect
  loops immediately.

`finnhub.destroy()` is called first, which sets `destroyed = true` — this
prevents the `close` event on the Finnhub socket from scheduling another
reconnect attempt during shutdown.

---

## 6. The Relay Pattern End-to-End

This is the path a single price tick travels through the entire system.

**Setup assumed:** Three browser clients are connected. Clients A and B are
both subscribed to `AAPL`. Client C is subscribed to `TSLA`. The relay has
subscribed to both upstream.

---

**Step 1 — Finnhub emits a trade tick.**

Finnhub's WebSocket pushes a frame:
```json
{
  "type": "trade",
  "data": [
    { "p": 212.49, "s": "AAPL", "t": 1719532800000, "v": 150 }
  ]
}
```
Note that `data` is an array — Finnhub batches multiple trades in a single
frame when they occur close together. There may be trades for multiple symbols
in one frame.

---

**Step 2 — `FinnhubClient.ws.on('message')` fires.**

```typescript
this.ws.on('message', (raw: WebSocket.RawData) => {
  const msg = JSON.parse(raw.toString()) as FinnhubMessage;
  if (msg.type !== 'trade') return;

  for (const trade of msg.data) {
    if (!this.subscribedSymbols.has(trade.s)) continue;
    this.options.onTick({
      symbol: trade.s,  // 'AAPL'
      price: trade.p,   // 212.49
      timestamp: trade.t,
      volume: trade.v,
    });
  }
});
```

The guard `!this.subscribedSymbols.has(trade.s)` filters out any symbols the
relay didn't subscribe to — this can happen briefly during the race between an
unsubscribe frame and an in-flight tick. The Finnhub raw shape (`p`, `s`, `t`,
`v`) is translated here into the internal `PriceTick` shape with readable field
names.

---

**Step 3 — `onTick` callback fires in `index.ts`.**

When `FinnhubClient` was constructed in `index.ts`:
```typescript
const finnhub = new FinnhubClient({
  apiKey: API_KEY,
  onTick: (tick) => clientManager.broadcast(tick),
  ...
});
```
The callback is just one line. `index.ts` passes the `PriceTick` straight
through to `clientManager`.

---

**Step 4 — `ClientManager.broadcast(tick)` is called.**

```typescript
broadcast(tick: PriceTick): void {
  const clients = this.symbolClients.get(tick.symbol); // Set { wsA, wsB }
  const payload = JSON.stringify({
    type: 'tick',
    symbol: 'AAPL',
    price: 212.49,
    timestamp: 1719532800000,
    volume: 150,
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
```

`symbolClients.get('AAPL')` returns `Set { wsA, wsB }`. Client C (`TSLA` only)
is not in this set and receives nothing. The JSON string is serialised once
and sent to both A and B.

---

**Step 5 — Browser clients A and B receive the WebSocket frame.**

Each browser's `useMarketFeed` hook has this handler:
```typescript
ws.onmessage = (event: MessageEvent<string>) => {
  const msg = JSON.parse(event.data) as RelayMessage;
  if (msg.type === 'tick') {
    const { symbol, price } = msg;
    // update watchlist price for AAPL
    setWatchlist((prev) => { ... });
    // if AAPL is the selected chart symbol, update last candle
    if (symbol === selectedRef.current) {
      setCandles((prev) => {
        const last = prev[prev.length - 1];
        last.close = price;
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        return [...prev.slice(0, -1), last];
      });
    }
  }
};
```

---

**Step 6 — React re-renders the chart.**

`setCandles` triggers a re-render of `Dashboard` → `Chart`. `Chart`'s `useMemo`
recomputes the geometry for the updated last candle — specifically the `bodyTop`,
`bodyHeight`, and `wickTop`/`wickHeight` percentage values — and the DOM updates
the wick and body divs for that candle in place.

The entire path from Finnhub emitting the tick to the chart pixel moving takes
a few milliseconds over a local network.

---

## 7. Why This Design — Key Decisions

### `ws` library over native `http.WebSocket` (Node.js built-in)

Node.js gained a native `WebSocket` client in v21.0 (`import { WebSocket }
from 'node:http'`) but the built-in is client-only — it can't create a server.
The `ws` npm package (`^8.x`) provides both client and server, is battle-tested
at high concurrency, and is what most production Node WebSocket servers use.
TypeScript types come from `@types/ws`. If the project were on Node 22+ and
only needed a client (no server), the native client would be a fine choice.

### Two Maps instead of one in `ClientManager`

The alternative would be one Map: `Map<string, Set<WebSocket>>` (symbol to
clients). This supports broadcasting fine, but breaks the disconnect path:
when a client disconnects, you'd have to iterate every symbol in the Map and
check whether that client was in its set — O(total unique symbols). With the
two-Map design, `clientSymbols.get(ws)` immediately gives you only the symbols
that client cared about, and cleanup is O(symbols for that client), which is
typically 5–15.

### Exponential backoff caps at 30 seconds

30 seconds is a balance between two failure modes: reconnecting too quickly
(hammering Finnhub's API during an outage, potentially triggering rate limiting
that makes the outage longer) and reconnecting too slowly (leaving all browser
clients stuck on "Reconnecting…" for minutes during a brief blip). Most
financial data providers have 60-second SLA for reconnect during outages; 30
seconds means the relay recovers before clients start considering the feed
dead.

### Frontend reconnects every 3 seconds (flat, not exponential)

The frontend reconnects to `localhost:8080` — a local Node process, not a
third-party API with rate limits. When the relay server restarts (e.g., during
development with `nodemon`), you want the browser to reconnect as soon as
possible, not after 32 seconds. 3 seconds is short enough to feel fast, long
enough not to spam error logs during a deliberate restart.

### Modular monolith rather than microservices

Splitting `FinnhubClient` into a separate service would mean either a message
broker (Kafka, Redis pub/sub) or an internal WebSocket to distribute ticks to
the relay, adding latency and operational complexity. For a single-host
deployment, the in-process callback from `FinnhubClient` to `ClientManager` (a
direct JavaScript function call) has ~0 µs overhead. Microservices make sense
when independent scaling is needed — e.g., the relay handling 10M clients while
the Finnhub connector stays at one instance — but at that scale the entire
architecture changes (load balancers, sticky sessions, external pub/sub). For
this project's scope, one process is the correct choice.

---

## 8. Interview Questions & Strong Answers

### Q1: "What is a WebSocket relay pattern and why did you use it?"

A WebSocket relay sits between a third-party WebSocket data source and your
browser clients. The relay maintains one upstream connection to the data
provider and any number of downstream connections to browsers, fanning ticks
from one source to many consumers. I used it for two reasons: the Finnhub API
key can't be exposed in the browser because it's visible in DevTools, and the
relay collapses N browser subscriptions to the same symbol into one upstream
subscription, which conserves API quota and reduces the tick volume the relay
processes.

### Q2: "How does your server handle a client disconnecting mid-session?"

When the browser's WebSocket closes, `ws.on('close')` fires in `index.ts`. It
calls `clientManager.removeClient(ws)`, which removes the client from
`clientSymbols` and iterates all symbols the client held, removing it from
`symbolClients` for each one. For any symbol where the subscriber set drops to
zero, `removeClient` returns that symbol in its array, and `index.ts` calls
`finnhub.unsubscribe(sym)` for each — sending Finnhub an explicit unsubscribe
frame so the relay stops receiving ticks for symbols no one is watching. No
browser action is required; the cleanup happens entirely in the `close` handler.

### Q3: "What happens if Finnhub drops the connection?"

`finnhubClient.ts` handles this entirely. When the upstream socket closes,
`on('close')` fires and calls `onStatusChange('reconnecting')` — which causes
`index.ts` to broadcast a `{ type: 'status', status: 'reconnecting' }` frame
to every connected browser, updating their connection pill in the UI. Then
`scheduleReconnect()` sets a `setTimeout` with exponential backoff (1 s, 2 s,
4 s … capped at 30 s). When `connect()` succeeds and `on('open')` fires, the
client iterates its `subscribedSymbols` set and re-fires a subscribe frame for
every symbol — because Finnhub's server starts each connection with a clean
slate. Browser clients don't reconnect to the relay; their downstream
connections stay open throughout.

### Q4: "How would you scale this if 10,000 clients connected simultaneously?"

The current design hits two walls at scale: a single Node.js process has a
file-descriptor limit for concurrent sockets (~65k on Linux but practical limit
is lower), and a single relay serialises `JSON.stringify` sequentially for each
broadcast. Steps to scale:

1. **Horizontal relay replicas behind a load balancer with sticky sessions**
   (WebSocket requires the same connection for its lifetime). Each replica
   maintains its own Finnhub upstream connection, so N replicas means N
   upstream connections — acceptable up to Finnhub's connection limit.
2. **Redis pub/sub as the backbone** instead of direct callbacks: each replica
   subscribes to a Redis channel per symbol; `FinnhubClient.onTick` publishes
   to Redis; each replica fans out to its own local clients. Now ticks
   naturally distribute across replicas without N Finnhub connections.
3. **`uWebSockets.js` instead of `ws`** for the relay layer — it's 10× faster
   at raw broadcast throughput because it's a native C++ binding.
4. **Move JSON serialisation off the hot path** — pre-serialise the tick once
   per symbol and use `Buffer` writes rather than string concatenation.

### Q5: "Why does your server maintain two Maps instead of one?"

The critical operations go in opposite directions. Broadcasting a tick requires:
"given a symbol, find all clients." A single `Map<symbol, Set<WebSocket>>`
answers this in O(1). But when a client disconnects, you need: "given a client,
find all its symbols, then check if any now have zero watchers." Without the
second Map (`clientSymbols`), you'd scan every entry in the symbol Map —
O(unique symbols). With both Maps mirrored, the disconnect path is O(symbols
that client held), which is bounded by user behavior rather than the total
number of active symbols. The cost is keeping both Maps in sync, which every
mutating method (`subscribe`, `unsubscribe`, `removeClient`) does explicitly.

### Q6: "When would you use REST instead of WebSockets?"

REST is the right choice when the client initiates every interaction and
doesn't need the server to push updates. For this app: loading historical OHLC
data for a chart is a one-shot request — the client asks, the server responds,
done. That should be REST (or a Finnhub candles REST call). WebSockets are the
right choice when the server needs to push data the client didn't explicitly
ask for at an arbitrary time — price ticks are the canonical example. Rule of
thumb: if the update cadence is driven by the server (events, ticks, presence),
use WebSockets. If it's driven by the client (user action, page load, form
submit), use REST.

### Q7: "What is the race condition in `finnhubClient.ts` and how is it handled?"

When the relay calls `finnhub.unsubscribe('AAPL')`, it sends an unsubscribe
frame to Finnhub over the network. Finnhub processes that frame
asynchronously — there may be one or more AAPL tick frames already in-flight
from Finnhub to the relay before the unsubscribe takes effect on their end.
The relay would receive those orphaned ticks after it has already removed AAPL
from `subscribedSymbols`. Without a guard, those ticks would be forwarded to
clients that have already unsubscribed. The guard in `on('message')`:

```typescript
if (!this.subscribedSymbols.has(trade.s)) continue;
```

uses the local `subscribedSymbols` set as the filter. Since `unsubscribe()`
removes from this set synchronously before sending the frame, any tick arriving
after the local removal is silently dropped, regardless of whether Finnhub's
server has processed the unsubscribe yet.

### Q8: "Why does `destroyed = true` need to be set before `ws.close()` in the `destroy()` method?"

Because closing a WebSocket triggers its `close` event, and the `close` handler
calls `scheduleReconnect()`. If `destroy()` called `ws.close()` before setting
`destroyed = true`, the `close` event would fire, the handler would see
`destroyed === false`, and it would schedule a reconnect — immediately
undoing the destroy. Setting the flag first means the `close` handler's guard:

```typescript
ws.on('close', (code, reason) => {
  if (this.destroyed) return;
  ...
});
```

sees `true` and exits early. The same flag gates the top of `connect()`, so
even if a race caused `setTimeout`'s callback to fire after `destroy()`, it
would return immediately without opening a new socket.

---

## 9. After-Hours Mock Fallback

### The problem

Finnhub only broadcasts trade ticks during live market hours. Outside US market
hours the upstream WebSocket stays connected but silent — the relay keeps its
`status: connected` message accurate, yet no price updates flow to the browser.
This makes the dashboard useless for demos and manual testing on evenings or
weekends.

### Design goal

Make the app fully demoable 24/7 without adding a second code path in
`index.ts` or `clientManager.ts`. Mock ticks must be transparent — they flow
through the same `onTick` callback as real ticks, so the rest of the system
never knows the difference.

### The `MockFallback` class (`finnhubClient.ts`)

`MockFallback` is a private class defined inside `finnhubClient.ts` and
instantiated by `FinnhubClient` in its constructor. It is not exported — it is
an implementation detail of `FinnhubClient` only.

```
FinnhubClient
├── subscribedSymbols: Set<string>   ← source of truth for subscriptions
├── mock: MockFallback               ← holds a getter into subscribedSymbols
│   ├── lastPrices: Map<string, number>
│   ├── silenceTimer: Timeout | null
│   └── mockInterval: Interval | null
└── options.onTick(tick)             ← used by both real ticks and mock ticks
```

`MockFallback` receives two dependencies:
- `getSubscribed: () => ReadonlySet<string>` — a getter (not a snapshot) so it
  always reads the live subscription set, even after mid-session
  subscribe/unsubscribe calls.
- `onTick: (tick: PriceTick) => void` — the same callback `FinnhubClient` uses
  for real ticks, wired directly to `clientManager.broadcast` in `index.ts`.

### State machine

```
          ┌──────────────────────────────────────────┐
          │              LIVE (default)              │
          │  silenceTimer running (30 s)             │
          └──────────────┬───────────────────────────┘
   no real tick for 30 s │
                         ▼
          ┌──────────────────────────────────────────┐
          │              MOCK MODE                   │
          │  mockInterval fires every 2 s            │
          │  silenceTimer stopped                    │
          └──────────────┬───────────────────────────┘
     real tick received  │
                         ▼
          ┌──────────────────────────────────────────┐
          │              LIVE (reset)                │
          │  silenceTimer restarted from 0           │
          └──────────────────────────────────────────┘
```

### Silence watchdog

`resetSilenceTimer()` clears any existing timer and starts a new `setTimeout`
for `SILENCE_THRESHOLD_MS` (default 30 000 ms). It is called:
- From `onRealTick()` — every real tick resets the 30-second countdown.
- From `onSubscribe()` — when the first symbol is subscribed and no timer is
  running yet.

When the timeout fires (30 s of silence), it calls `enterMockMode()`.

### Entering and exiting mock mode

`enterMockMode()`:
1. Sets `active = true`.
2. Logs `[mock] entering mock mode — no real ticks for 30s`.
3. Calls `emitMockTicks()` immediately (no delay before the first mock tick).
4. Starts a `setInterval` to call `emitMockTicks()` every 2 s.

When `onRealTick()` is called while `active === true`:
1. Sets `active = false`.
2. Logs `[mock] exiting mock mode — real tick received`.
3. Stops the mock interval.
4. Restarts the silence watchdog from 0.

### Random walk formula

For each subscribed symbol on every mock tick:

```
base      = lastPrices.get(symbol) ?? DEFAULT_SEED_PRICES[symbol] ?? 100
magnitude = rand(0.0005, 0.0015)           // 0.05 % – 0.15 % per tick
sign      = rand() < 0.5 ? +1 : -1
rawPrice  = base × (1 + sign × magnitude)
price     = toFixed(rawPrice < 1 ? 4 : 2) // 4 dp for sub-dollar assets
```

`lastPrices` is updated after each emission, so consecutive mock ticks form a
continuous walk rather than oscillating around the seed price.

### Default seed prices

When a symbol has never received a real tick, `lastPrices` has no entry.
`DEFAULT_SEED_PRICES` provides reasonable starting prices for the instruments
in the default watchlist:

| Symbol  | Seed price |
|---------|------------|
| BTC-USD | 67 000     |
| ETH-USD | 3 400      |
| SOL-USD | 150        |
| NVDA    | 195        |
| AAPL    | 213        |
| TSLA    | 183        |
| SPY     | 548        |
| (other) | 100        |

### Log output

| Condition                        | Log line                                                       |
|----------------------------------|----------------------------------------------------------------|
| Enter mock mode                  | `[mock] entering mock mode — no real ticks for 30s`          |
| Exit mock mode                   | `[mock] exiting mock mode — real tick received`              |
| Each 2-second emission cycle     | `[mock] emitted N tick(s) for: SYM1, SYM2, …`               |

Individual per-symbol prices are not logged to avoid flooding the terminal when
7+ symbols are active.

### Integration points in `FinnhubClient`

| `FinnhubClient` method | `MockFallback` call      | Purpose                               |
|------------------------|--------------------------|---------------------------------------|
| `constructor`          | `new MockFallback(...)`  | Wires the getter and the onTick cb    |
| `on('message')`        | `mock.onRealTick(s, p)`  | Updates price anchor, resets watchdog |
| `subscribe()`          | `mock.onSubscribe()`     | Starts watchdog on first subscription |
| `unsubscribe()`        | `mock.onUnsubscribe()`   | Stops everything if no symbols remain |
| `destroy()`            | `mock.destroy()`         | Clears both timers before socket close|

`index.ts` and `clientManager.ts` require zero changes — the mock is entirely
self-contained inside `finnhubClient.ts`.

### Testing without waiting 30 seconds

Set `MOCK_SILENCE_THRESHOLD_MS` in your shell before starting the server:

```bash
# 5-second silence window — mock mode activates quickly for testing
MOCK_SILENCE_THRESHOLD_MS=5000 npm run dev
```

The constant is read once at module load:

```typescript
const SILENCE_THRESHOLD_MS = parseInt(
  process.env.MOCK_SILENCE_THRESHOLD_MS ?? '30000',
  10,
);
```

With the 5-second override, the expected terminal output after startup is:

```
[relay] listening on ws://localhost:8080
[finnhub] connecting (attempt 1)
[finnhub] connected
[relay] client connected from ::1 (total: 1)
[relay] subscribe   BTC-USD  isFirst=true
[relay] subscribe   ETH-USD  isFirst=true
... (remaining symbols)
[finnhub] subscribed BTC-USD
[finnhub] subscribed ETH-USD
... 5 seconds later (or 30 outside market hours) ...
[mock] entering mock mode — no real ticks for 5s
[mock] emitted 7 tick(s) for: BTC-USD, ETH-USD, SOL-USD, NVDA, AAPL, TSLA, SPY
[mock] emitted 7 tick(s) for: BTC-USD, ETH-USD, SOL-USD, NVDA, AAPL, TSLA, SPY
```

When market hours resume and the first real Finnhub tick arrives:

```
[mock] exiting mock mode — real tick received
```

### Interview angles

**Why keep `MockFallback` in the same file as `FinnhubClient` rather than a
separate module?** The class is not exported and has no other consumers — it is
an implementation detail of one class. Separating it would create a module
boundary where there is no semantic boundary, making the code harder to trace.
The file is longer, but the `MockFallback` → `FinnhubClient` relationship is
immediately legible in one scroll.

**Why use a getter `() => this.subscribedSymbols` instead of passing the Set
by value?** A getter always reads the live Set. If you passed
`this.subscribedSymbols` by reference (a Set is a reference type in JS, so
this would actually work), it would also see mutations. But using an explicit
getter documents the intent — "I want current state at call time" — and remains
correct even if `FinnhubClient` ever replaces the Set reference (e.g. on
reconnect). Explicit is better than relying on Set reference identity.

**What happens if a symbol is subscribed while mock mode is active?**
`emitMockTicks()` calls `getSubscribed()` fresh on every tick, so the new
symbol is included in the very next 2-second cycle. Its `lastPrices` entry is
absent, so `DEFAULT_SEED_PRICES` or 100 is used as the starting anchor.

**Why emit immediately (`emitMockTicks()` before `setInterval`) when entering
mock mode?** Without the immediate call, clients would wait up to 2 seconds
after the mode transition before seeing any movement. Emitting right away means
the UI responds at the exact moment the threshold is crossed, not 2 seconds
later.

---

## 10. Price Alerts & AlertEngine

### Overview

The price-alert system lets a browser session set a threshold on any symbol
(e.g. "notify me when BTC-USD crosses above $70,000"). When a live price tick
hits the threshold, the server pushes an `alert_triggered` WebSocket message
directly to the session that owns the alert, marks the alert triggered in the
database, and removes it from the in-memory engine so it fires at most once.

### Data model

```sql
CREATE TABLE alerts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     VARCHAR(64) NOT NULL,
  symbol         VARCHAR(20) NOT NULL,
  condition      VARCHAR(10) NOT NULL CHECK (condition IN ('above', 'below')),
  target_price   DECIMAL(18, 8) NOT NULL,
  triggered_at   TIMESTAMPTZ DEFAULT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
```

`triggered_at IS NULL` is the live/fired discriminator — all hot-path queries
filter on it so triggered alerts are never re-checked.

### In-memory Map pattern (`alertEngine.ts`)

```
AlertEngine
  bySymbol: Map<symbol, Alert[]>   ← O(1) lookup per tick
  byId:     Map<id, Alert>         ← O(1) remove by ID
```

On startup `alertEngine.load()` reads every untriggered alert from the DB into
both maps. After that the DB is never queried on the hot path — only written to
when an alert fires (`UPDATE alerts SET triggered_at = NOW()`).

The two maps are kept in sync by `index()` (insert) and `remove()` (delete).
`remove()` is called both when an alert triggers and when a client DELETEs it
via the REST API.

### Alert checking on tick (`checkTick`)

```typescript
checkTick(symbol: string, price: number, source: 'live' | 'mock'): void {
  if (source !== 'live') return;          // never trigger from mock ticks
  const alerts = this.bySymbol.get(symbol);
  for (const alert of [...alerts]) {
    const hit = (alert.condition === 'above' && price >= alert.target_price)
             || (alert.condition === 'below' && price <= alert.target_price);
    if (hit) { this.remove(alert.id); ... this.onAlert(alert, price); }
  }
}
```

The `[...alerts]` spread is intentional — `remove()` mutates the array stored
in `bySymbol`, so iterating over the original snapshot avoids a mid-loop
mutation.

### Session routing

Alerts are delivered only to the session that created them. This works through
two maps in `ClientManager`:

```
sessionClients: Map<session_id, Set<WebSocket>>
clientSession:  Map<WebSocket, session_id>
```

When a WebSocket connects, its `?sessionId=` query param is recorded in both
maps. `sendToSession(sessionId, payload)` iterates the Set and delivers to
every open tab that shares the session.

Because the browser WebSocket API cannot send custom HTTP headers during an
upgrade request, the session ID is passed as a URL query parameter
(`?sessionId=...`) and extracted on the server via
`new URL(req.url, 'http://localhost').searchParams.get('sessionId')`.

### REST API (`routes/alerts.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/alerts` | Return all untriggered alerts for the session |
| POST   | `/api/alerts` | Create a new alert, add to engine, return the row |
| DELETE | `/api/alerts/:id` | Delete alert (session-scoped), remove from engine |

All responses use `CAST(target_price AS float8)` to avoid the node-postgres
behaviour where `DECIMAL` columns are returned as strings.

### Key invariants

- **Mock ticks never trigger alerts.** `checkTick` returns immediately when
  `source !== 'live'`. This mirrors the sessionBaseline invariant in the client.
- **Each alert fires at most once.** `remove()` is called before `onAlert()`,
  so even if two ticks race, the second finds an empty slot.
- **DB write is fire-and-forget.** The `UPDATE triggered_at` query is
  `.catch()`-logged but not awaited — the in-memory engine is the source of
  truth. A server restart re-reads from the DB, which still shows
  `triggered_at IS NULL` only for unfired alerts.

### FAQ

**Why not query the DB on every tick?** The tick rate can be hundreds per
second across dozens of symbols. A DB query per tick would overwhelm the
connection pool. The in-memory Map brings per-tick cost to O(1) and
amortises the startup `SELECT` across the lifetime of the process.

**What happens if the server restarts mid-session?** `alertEngine.load()`
re-reads all untriggered alerts, so in-flight alerts survive a restart.
The client re-connects via the existing WebSocket reconnect logic.

**Why `byId` in addition to `bySymbol`?** `bySymbol` is the hot path (checked
per tick); `byId` makes the REST DELETE O(1) without scanning every symbol's
list. Both maps are updated together in `index()` and `remove()`.
