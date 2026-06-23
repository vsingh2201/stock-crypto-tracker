import type { Candle, Timeframe } from '../types';

export function formatPrice(n: number): string {
  const decimals = Math.abs(n) < 1 ? 4 : 2;
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function genSpark(up: boolean): number[] {
  const pts: number[] = [];
  let v = 12;
  for (let i = 0; i < 16; i++) {
    v += (Math.random() - 0.5) * 4 + (up ? 0.28 : -0.28);
    v = Math.max(3, Math.min(21, v));
    pts.push(v);
  }
  return pts;
}

export function sparkToPoints(pts: number[]): string {
  const step = 56 / (pts.length - 1);
  return pts.map((p, i) => `${(i * step).toFixed(1)},${(24 - p).toFixed(1)}`).join(' ');
}

const TIMEFRAME_COUNTS: Record<Timeframe, number> = { '1D': 48, '1W': 44, '1M': 30 };
const TIMEFRAME_VOL_FACTOR: Record<Timeframe, number> = { '1D': 0.0035, '1W': 0.008, '1M': 0.013 };
export const TIMEFRAME_TICK_VOL_FACTOR: Record<Timeframe, number> = { '1D': 0.0009, '1W': 0.0016, '1M': 0.0026 };

export const TIMEFRAME_X_LABELS: Record<Timeframe, string[]> = {
  '1D': ['09:30', '11:00', '12:30', '14:00', '15:30', '16:00'],
  '1W': ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  '1M': ['May 20', 'May 27', 'Jun 3', 'Jun 10', 'Jun 17'],
};

export function genCandles(endPrice: number, changePct: number, timeframe: Timeframe): Candle[] {
  const n = TIMEFRAME_COUNTS[timeframe];
  const start = endPrice / (1 + changePct / 100);
  const volFactor = TIMEFRAME_VOL_FACTOR[timeframe];
  const vol = endPrice * volFactor;

  const closes: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 1;
    const baseP = start + (endPrice - start) * t;
    const noise = i === n - 1 ? 0 : (Math.random() - 0.5) * vol * 2;
    closes.push(baseP + noise);
  }
  closes[n - 1] = endPrice;

  const candles: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const open = i === 0 ? closes[0] * (1 - Math.random() * 0.002) : closes[i - 1];
    const close = closes[i];
    const high = Math.max(open, close) + Math.random() * vol;
    const low = Math.min(open, close) - Math.random() * vol;
    candles.push({ open, high, low, close, volume: 0.22 + Math.random() * 0.78 });
  }
  return candles;
}
