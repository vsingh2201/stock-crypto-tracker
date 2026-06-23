import { useCallback, useEffect, useRef, useState } from 'react';
import { SEED_WATCHLIST, UNIVERSE } from '../data/universe';
import { genCandles, genSpark, TIMEFRAME_TICK_VOL_FACTOR } from '../lib/marketMath';
import type { Candle, ConnectionStatus, Timeframe, WatchlistItem } from '../types';

/**
 * Stands in for the live feed today: ticks watchlist prices and the active
 * candle on a timer instead of reading frames off a socket. The relay server
 * (server/) will forward Finnhub trade/agg messages over a WebSocket; once
 * that's wired up, replace the setInterval tick loop below with a `ws.onmessage`
 * handler that applies the same state updates from real messages, and the
 * components consuming this hook's return value won't need to change.
 */
export function useMarketFeed(initialSymbol: string, initialTimeframe: Timeframe) {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>(() =>
    SEED_WATCHLIST.map(({ symbol, changePct }) => {
      const u = UNIVERSE.find((x) => x.symbol === symbol)!;
      return {
        symbol: u.symbol,
        name: u.name,
        exchange: u.exchange,
        type: u.type,
        price: u.seedPrice,
        changePct,
        spark: genSpark(changePct >= 0),
      };
    }),
  );
  const [connection, setConnection] = useState<ConnectionStatus>('connected');
  const [selected, setSelected] = useState(initialSymbol);
  const [timeframe, setTimeframeState] = useState<Timeframe>(initialTimeframe);
  const [candles, setCandles] = useState<Candle[]>(() => {
    const sel = SEED_WATCHLIST.find((w) => w.symbol === initialSymbol)!;
    const u = UNIVERSE.find((x) => x.symbol === initialSymbol)!;
    return genCandles(u.seedPrice, sel.changePct, initialTimeframe);
  });

  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  const watchlistRef = useRef(watchlist);
  watchlistRef.current = watchlist;

  useEffect(() => {
    const timer = setInterval(() => {
      if (Math.random() < 0.035) {
        setConnection((c) => (c === 'reconnecting' ? 'connected' : 'reconnecting'));
      } else {
        setConnection((c) => (c === 'reconnecting' ? 'connected' : c));
      }

      const tickVolFactor = TIMEFRAME_TICK_VOL_FACTOR[timeframeRef.current];
      const raw = candlesRef.current.map((c) => ({ ...c }));
      const last = raw[raw.length - 1];
      last.close = last.close + last.close * (Math.random() - 0.5) * 2 * tickVolFactor;
      last.high = Math.max(last.high, last.close);
      last.low = Math.min(last.low, last.close);
      setCandles(raw);

      setWatchlist((prev) => {
        const next = prev.map((w) => {
          const drift = w.type === 'crypto' ? 0.0009 : 0.0006;
          const price = w.price * (1 + (Math.random() - 0.5) * 2 * drift);
          let changePct = w.changePct + ((price - w.price) / w.price) * 100;
          changePct = Math.max(-9.5, Math.min(9.5, changePct));
          return { ...w, price, changePct };
        });
        const idx = next.findIndex((w) => w.symbol === selected);
        if (idx >= 0) {
          const base = raw[0].open;
          next[idx] = { ...next[idx], price: last.close, changePct: ((last.close - base) / base) * 100 };
        }
        return next;
      });
    }, 1300);
    return () => clearInterval(timer);
  }, [selected]);

  const selectSymbol = useCallback((symbol: string) => {
    setSelected(symbol);
    const w = watchlistRef.current.find((x) => x.symbol === symbol);
    if (w) setCandles(genCandles(w.price, w.changePct, timeframeRef.current));
  }, []);

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
      const changePct = (Math.random() - 0.4) * 5;
      return [...prev, { symbol: u.symbol, name: u.name, exchange: u.exchange, type: u.type, price: u.seedPrice, changePct, spark: genSpark(changePct >= 0) }];
    });
  }, []);

  return { watchlist, connection, selected, timeframe, candles, selectSymbol, setTimeframe, addSymbol };
}
