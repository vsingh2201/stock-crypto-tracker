import { useCallback, useEffect, useRef, useState } from 'react';
import { SEED_WATCHLIST, UNIVERSE } from '../data/universe';
import { genCandles, genSpark } from '../lib/marketMath';
import type { AlertItem, AlertTriggeredMsg, Candle, ConnectionStatus, Timeframe, WatchlistItem } from '../types';

const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? 'ws://localhost:8080';
const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8080';
const RECONNECT_DELAY_MS = 3_000;

// Get or create a stable session ID for this browser.
const SESSION_ID: string = (() => {
  let id = localStorage.getItem('pulse_session_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('pulse_session_id', id);
  }
  return id;
})();

// ── Notification helpers ──────────────────────────────────────────────────────

function playAlertBeep(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880; // A5
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
  } catch {
    // AudioContext not available (SSR, restricted context, etc.)
  }
}

function showBrowserNotification(msg: AlertTriggeredMsg): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const dir = msg.condition === 'above' ? 'above' : 'below';
  new Notification(`${msg.symbol} alert triggered`, {
    body: `${msg.symbol} crossed ${dir} $${msg.targetPrice.toLocaleString()} — now $${msg.triggeredPrice.toLocaleString()}`,
    icon: '/favicon.ico',
  });
}

// ── Message types ─────────────────────────────────────────────────────────────

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

type RelayMessage = TickMessage | StatusMessage | AlertTriggeredMsg;

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildItem(symbol: string): WatchlistItem | null {
  const u = UNIVERSE.find((x) => x.symbol === symbol);
  if (!u) return null;
  return { symbol: u.symbol, name: u.name, exchange: u.exchange, type: u.type, price: u.seedPrice, changePct: 0, spark: genSpark(false), source: 'live' as const };
}

function rowToAlertItem(r: Record<string, unknown>): AlertItem {
  return {
    id: r.id as string,
    symbol: r.symbol as string,
    condition: r.condition as 'above' | 'below',
    targetPrice: Number(r.target_price),
    createdAt: r.created_at as string,
  };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMarketFeed(initialSymbol: string, initialTimeframe: Timeframe) {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>(() =>
    SEED_WATCHLIST.map(({ symbol }) => buildItem(symbol)!),
  );
  const [connection, setConnection] = useState<ConnectionStatus>('reconnecting');
  const [selected, setSelected] = useState(initialSymbol);
  const [timeframe, setTimeframeState] = useState<Timeframe>(initialTimeframe);
  const [candles, setCandles] = useState<Candle[]>(() => {
    const u = UNIVERSE.find((x) => x.symbol === initialSymbol)!;
    return genCandles(u.seedPrice, 0, initialTimeframe);
  });
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [lastTriggered, setLastTriggered] = useState<AlertTriggeredMsg | null>(null);

  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  const watchlistRef = useRef(watchlist);
  watchlistRef.current = watchlist;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const sessionBaseline = useRef(new Map<string, number>());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const destroyedRef = useRef(false);

  const send = useCallback((payload: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const subscribeAll = useCallback(() => {
    for (const item of watchlistRef.current) {
      send({ type: 'subscribe', symbol: item.symbol });
    }
  }, [send]);

  // Load persisted watchlist from the REST API on mount.
  useEffect(() => {
    console.log('[api] REST base URL:', API_URL);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      console.warn('[api] watchlist fetch timed out — keeping seed data');
    }, 5_000);

    fetch(`${API_URL}/api/watchlist`, {
      headers: { 'x-session-id': SESSION_ID },
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then(({ symbols }: { symbols: string[] }) => {
        const items = symbols.map(buildItem).filter((x): x is WatchlistItem => x !== null);
        if (items.length === 0) return;

        setWatchlist(items);

        if (!items.some((w) => w.symbol === selectedRef.current)) {
          const first = items[0];
          setSelected(first.symbol);
          setCandles(genCandles(first.price, first.changePct, timeframeRef.current));
        }

        for (const { symbol } of items) {
          send({ type: 'subscribe', symbol });
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') console.error('[api] failed to load watchlist:', err);
      })
      .finally(() => clearTimeout(timeout));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load active alerts from the REST API on mount.
  useEffect(() => {
    fetch(`${API_URL}/api/alerts`, { headers: { 'x-session-id': SESSION_ID } })
      .then((r) => r.json())
      .then(({ alerts: rows }: { alerts: Record<string, unknown>[] }) => {
        setAlerts(rows.map(rowToAlertItem));
      })
      .catch((err) => console.error('[api] failed to load alerts:', err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // WebSocket connection + message handling.
  useEffect(() => {
    destroyedRef.current = false;

    function connect() {
      if (destroyedRef.current) return;
      // Pass the session ID as a query param — browsers can't send custom
      // headers during WebSocket upgrades.
      const ws = new WebSocket(`${WS_URL}?sessionId=${SESSION_ID}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnection('connected');
        // Clear before subscribeAll so stale baselines from the previous
        // connection never mix with prices emitted by a freshly restarted server.
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

        if (msg.type === 'alert_triggered') {
          setAlerts((prev) => prev.filter((a) => a.id !== msg.alertId));
          setLastTriggered(msg);
          playAlertBeep();
          showBrowserNotification(msg);
          return;
        }

        if (msg.type === 'tick') {
          const { symbol, price, source } = msg;

          // Baseline is only ever anchored from a live Finnhub tick, never from
          // mock data. Mock seed prices can be far from market price, producing
          // wildly wrong changePct values the moment real ticks arrive.
          const baseline = sessionBaseline.current;
          if (source === 'live' && !baseline.has(symbol)) {
            baseline.set(symbol, price);
          }
          const sessionOpen = baseline.get(symbol);
          const changePct = sessionOpen !== undefined
            ? ((price - sessionOpen) / sessionOpen) * 100
            : 0;

          setWatchlist((prev) => {
            const idx = prev.findIndex((w) => w.symbol === symbol);
            if (idx === -1) return prev;
            const next = [...prev];
            next[idx] = { ...prev[idx], price, changePct, source };
            return next;
          });

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
    const w = watchlistRef.current.find((x) => x.symbol === symbol);
    if (w) setCandles(genCandles(w.price, w.changePct, timeframeRef.current));
    send({ type: 'subscribe', symbol });
  }, [send]);

  const setTimeframe = useCallback((tf: Timeframe) => {
    setTimeframeState(tf);
    const w = watchlistRef.current.find((x) => x.symbol === selected);
    if (w) setCandles(genCandles(w.price, w.changePct, tf));
  }, [selected]);

  const addSymbol = useCallback(async (symbol: string) => {
    if (watchlistRef.current.some((w) => w.symbol === symbol)) return;
    const item = buildItem(symbol);
    if (!item) return;

    const res = await fetch(`${API_URL}/api/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': SESSION_ID },
      body: JSON.stringify({ symbol }),
    });

    if (res.status === 409) return;
    if (!res.ok) { console.error('[api] failed to add symbol', symbol); return; }

    setWatchlist((prev) => (prev.some((w) => w.symbol === symbol) ? prev : [...prev, item]));
    send({ type: 'subscribe', symbol });
  }, [send]);

  const removeSymbol = useCallback(async (symbol: string) => {
    const remaining = watchlistRef.current.filter((w) => w.symbol !== symbol);

    if (remaining.length === 0) {
      const fallback = buildItem(SEED_WATCHLIST[0].symbol)!;
      setWatchlist([fallback]);
      setSelected(fallback.symbol);
      setCandles(genCandles(fallback.price, 0, timeframeRef.current));
    } else {
      setWatchlist(remaining);
      if (selectedRef.current === symbol) {
        const next = remaining[0];
        setSelected(next.symbol);
        setCandles(genCandles(next.price, next.changePct, timeframeRef.current));
      }
    }

    await fetch(`${API_URL}/api/watchlist/${encodeURIComponent(symbol)}`, {
      method: 'DELETE',
      headers: { 'x-session-id': SESSION_ID },
    }).catch((err) => console.error('[api] failed to remove symbol', symbol, err));

    send({ type: 'unsubscribe', symbol });
  }, [send]);

  const createAlert = useCallback(async (
    symbol: string,
    condition: 'above' | 'below',
    targetPrice: number,
  ): Promise<boolean> => {
    // Request notification permission the first time an alert is created.
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }

    const res = await fetch(`${API_URL}/api/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': SESSION_ID },
      body: JSON.stringify({ symbol, condition, target_price: targetPrice }),
    });
    if (!res.ok) { console.error('[api] failed to create alert'); return false; }

    const row: Record<string, unknown> = await res.json();
    setAlerts((prev) => [rowToAlertItem(row), ...prev]);
    return true;
  }, []);

  const deleteAlert = useCallback(async (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    await fetch(`${API_URL}/api/alerts/${id}`, {
      method: 'DELETE',
      headers: { 'x-session-id': SESSION_ID },
    }).catch((err) => console.error('[api] failed to delete alert', id, err));
  }, []);

  return {
    watchlist, connection, selected, timeframe, candles,
    alerts, lastTriggered,
    selectSymbol, setTimeframe, addSymbol, removeSymbol, createAlert, deleteAlert,
  };
}
