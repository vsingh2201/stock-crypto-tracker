import { useCallback, useEffect, useRef, useState } from 'react';
import { SEED_WATCHLIST, UNIVERSE } from '../data/universe';
import { genCandles, genSpark } from '../lib/marketMath';
import type { Candle, ConnectionStatus, Timeframe, WatchlistItem } from '../types';

// Configurable via client/.env: VITE_WS_URL=ws://localhost:8080
const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? 'ws://localhost:8080';
const RECONNECT_DELAY_MS = 3_000;

// Mirror the relay server's outbound message shapes (server/src/types.ts ServerMessage).
interface TickMessage {
  type: 'tick';
  symbol: string;
  price: number;
  timestamp: number;
  volume: number;
  source: 'live' | 'mock';
}

interface StatusMessage {
  type: 'status';
  status: ConnectionStatus;
}

type RelayMessage = TickMessage | StatusMessage;

/**
 * Connects to the Node.js relay server at WS_URL and wires live Finnhub
 * price ticks into the watchlist + active chart.
 *
 * What changed from the mock:
 *   - setInterval random-walk removed; replaced by ws.onmessage
 *   - candle history is still synthesised by genCandles (WebSocket gives you
 *     live trades, not historical OHLC — that needs a REST call to fill in)
 *   - connection state is driven by ws lifecycle / relay status frames
 *   - selectSymbol and addSymbol send subscribe frames to the relay
 *
 * The return shape is identical to the old mock hook, so Dashboard and every
 * downstream component continue to work without any changes.
 */
export function useMarketFeed(initialSymbol: string, initialTimeframe: Timeframe) {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>(() =>
    // changePct starts at 0 for all symbols — the real value is computed once
    // the first tick arrives and sets the session baseline for that symbol.
    SEED_WATCHLIST.map(({ symbol }) => {
      const u = UNIVERSE.find((x) => x.symbol === symbol)!;
      return { symbol: u.symbol, name: u.name, exchange: u.exchange, type: u.type, price: u.seedPrice, changePct: 0, spark: genSpark(false), source: 'live' as const };
    }),
  );
  const [connection, setConnection] = useState<ConnectionStatus>('reconnecting');
  const [selected, setSelected] = useState(initialSymbol);
  const [timeframe, setTimeframeState] = useState<Timeframe>(initialTimeframe);
  const [candles, setCandles] = useState<Candle[]>(() => {
    const u = UNIVERSE.find((x) => x.symbol === initialSymbol)!;
    return genCandles(u.seedPrice, 0, initialTimeframe);
  });

  // Refs let event handlers always read the latest value without being
  // recreated (avoids stale closures in ws.onmessage / reconnect timers).
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  const watchlistRef = useRef(watchlist);
  watchlistRef.current = watchlist;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // First tick received per symbol after each (re)connect anchors changePct.
  // Cleared in ws.onopen so a server restart — which resets the mock fallback's
  // price state to DEFAULT_SEED_PRICES — never mixes with a baseline that was
  // set by real ticks from a previous connection at a very different price level.
  const sessionBaseline = useRef(new Map<string, number>());

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const destroyedRef = useRef(false);

  const send = useCallback((payload: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  // Re-subscribe every watchlist symbol after a (re)connect.
  const subscribeAll = useCallback(() => {
    for (const item of watchlistRef.current) {
      send({ type: 'subscribe', symbol: item.symbol });
    }
  }, [send]);

  useEffect(() => {
    destroyedRef.current = false;

    function connect() {
      if (destroyedRef.current) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnection('connected');
        // A new connection may be talking to a freshly restarted server whose
        // mock fallback has no lastPrice state and will emit DEFAULT_SEED_PRICES.
        // Stale baselines from the previous connection would produce nonsensical
        // changePct values, so reset here and let the first tick re-anchor.
        sessionBaseline.current.clear();
        subscribeAll();
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        let msg: RelayMessage;
        try {
          msg = JSON.parse(event.data) as RelayMessage;
        } catch {
          return;
        }

        if (msg.type === 'status') {
          setConnection(msg.status);
          return;
        }

        if (msg.type === 'tick') {
          const { symbol, price, source } = msg;

          // Record the first tick for this symbol as the session baseline.
          // changePct is then always (currentPrice - sessionOpen) / sessionOpen,
          // not a rolling accumulation from the mock seed price.
          const baseline = sessionBaseline.current;
          if (!baseline.has(symbol)) {
            baseline.set(symbol, price);
          }
          const sessionOpen = baseline.get(symbol)!;
          const changePct = ((price - sessionOpen) / sessionOpen) * 100;

          setWatchlist((prev) => {
            const idx = prev.findIndex((w) => w.symbol === symbol);
            if (idx === -1) return prev;
            const next = [...prev];
            next[idx] = { ...prev[idx], price, changePct, source };
            return next;
          });

          // Merge tick into the last candle of the active chart.
          if (symbol === selectedRef.current) {
            setCandles((prev) => {
              const next = prev.map((c) => ({ ...c }));
              const last = next[next.length - 1];
              last.close = price;
              last.high = Math.max(last.high, price);
              last.low = Math.min(last.low, price);
              return next;
            });
          }
        }
      };

      ws.onerror = () => {
        // 'error' always fires before 'close'; let onclose own the reconnect loop.
        setConnection('disconnected');
      };

      ws.onclose = () => {
        if (destroyedRef.current) return;
        setConnection('reconnecting');
        reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    }

    connect();

    return () => {
      destroyedRef.current = true;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [subscribeAll]);

  const selectSymbol = useCallback((symbol: string) => {
    setSelected(symbol);
    // Seed the chart with synthesised history at the current price.
    const w = watchlistRef.current.find((x) => x.symbol === symbol);
    if (w) setCandles(genCandles(w.price, w.changePct, timeframeRef.current));
    // Tell the relay to start forwarding ticks for this symbol.
    send({ type: 'subscribe', symbol });
  }, [send]);

  const setTimeframe = useCallback((tf: Timeframe) => {
    setTimeframeState(tf);
    const w = watchlistRef.current.find((x) => x.symbol === selected);
    if (w) setCandles(genCandles(w.price, w.changePct, tf));
  }, [selected]);

  const addSymbol = useCallback((symbol: string) => {
    setWatchlist((prev) => {
      if (prev.some((w) => w.symbol === symbol)) return prev;
      const u = UNIVERSE.find((x) => x.symbol === symbol);
      if (!u) return prev;
      // changePct will be set correctly on the first tick from the relay.
      return [...prev, { symbol: u.symbol, name: u.name, exchange: u.exchange, type: u.type, price: u.seedPrice, changePct: 0, spark: genSpark(false), source: 'live' as const }];
    });
    send({ type: 'subscribe', symbol });
  }, [send]);

  return { watchlist, connection, selected, timeframe, candles, selectSymbol, setTimeframe, addSymbol };
}
