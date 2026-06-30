import WebSocket from 'ws';
import type { FinnhubMessage, PriceTick } from './types';

// ── Finnhub upstream constants ───────────────────────────────────────────────

const FINNHUB_WS_URL = 'wss://ws.finnhub.io';
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

// ── Mock fallback constants ──────────────────────────────────────────────────

const MOCK_INTERVAL_MS = 2_000;
const MOCK_MIN_DRIFT = 0.0005; // 0.05% per tick
const MOCK_MAX_DRIFT = 0.0015; // 0.15% per tick

// Override via environment to shorten the wait during testing:
//   MOCK_SILENCE_THRESHOLD_MS=5000 npm run dev
const SILENCE_THRESHOLD_MS = parseInt(
  process.env.MOCK_SILENCE_THRESHOLD_MS ?? '30000',
  10,
);

const DEFAULT_SEED_PRICES: Record<string, number> = {
  'BTC-USD': 67_000,
  'ETH-USD': 3_400,
  'SOL-USD': 150,
  'NVDA': 195,
  'AAPL': 213,
  'TSLA': 183,
  'SPY': 548,
};

// ── MockFallback ─────────────────────────────────────────────────────────────

interface SymbolState {
  active: boolean;
  lastPrice: number | undefined;
  silenceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Per-symbol after-hours mock fallback.
 *
 * Each subscribed symbol gets its own 30-second silence watchdog. When a
 * symbol's watchdog fires (no real tick for SILENCE_THRESHOLD_MS), that symbol
 * independently enters mock mode. A single shared setInterval drives all
 * currently-mocked symbols at MOCK_INTERVAL_MS cadence; it starts when the
 * first symbol enters mock mode and stops when the last exits.
 *
 * Real ticks are precise: only the symbol that received a real tick exits mock
 * mode — other symbols may still be mocked.
 *
 * Mock ticks flow through the same onTick callback as real ticks (with
 * source: 'mock'), so index.ts and ClientManager require no changes.
 */
class MockFallback {
  private readonly symbols = new Map<string, SymbolState>();
  private mockInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onTick: (tick: PriceTick) => void) {}

  /**
   * Call when a real Finnhub tick arrives for symbol.
   * Resets that symbol's silence watchdog; exits its mock mode if active.
   */
  onRealTick(symbol: string, price: number): void {
    const state = this.ensure(symbol);
    state.lastPrice = price;

    if (state.active) {
      console.log(`[mock] ${symbol} exiting mock mode — real tick received`);
      state.active = false;
      this.maybeStopInterval();
    }

    this.resetTimer(symbol);
  }

  /**
   * Call when symbol is first subscribed.
   * Starts its silence watchdog if not already running.
   */
  onSubscribe(symbol: string): void {
    const state = this.ensure(symbol);
    if (!state.silenceTimer && !state.active) {
      this.resetTimer(symbol);
    }
  }

  /**
   * Call when symbol is unsubscribed.
   * Clears its watchdog and exits mock mode if it was active.
   */
  onUnsubscribe(symbol: string): void {
    const state = this.symbols.get(symbol);
    if (!state) return;
    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = null;
    }
    if (state.active) {
      state.active = false;
      this.maybeStopInterval();
    }
    this.symbols.delete(symbol);
  }

  /** Clear all per-symbol timers and the global interval. */
  destroy(): void {
    for (const state of this.symbols.values()) {
      if (state.silenceTimer) clearTimeout(state.silenceTimer);
    }
    this.symbols.clear();
    if (this.mockInterval) {
      clearInterval(this.mockInterval);
      this.mockInterval = null;
    }
  }

  // ── private ───────────────────────────────────────────────────────────────

  private ensure(symbol: string): SymbolState {
    if (!this.symbols.has(symbol)) {
      this.symbols.set(symbol, { active: false, lastPrice: undefined, silenceTimer: null });
    }
    return this.symbols.get(symbol)!;
  }

  private resetTimer(symbol: string): void {
    const state = this.ensure(symbol);
    if (state.silenceTimer) clearTimeout(state.silenceTimer);
    state.silenceTimer = setTimeout(() => {
      state.silenceTimer = null;
      this.enterMockMode(symbol);
    }, SILENCE_THRESHOLD_MS);
  }

  private enterMockMode(symbol: string): void {
    const state = this.symbols.get(symbol);
    if (!state || state.active) return;
    state.active = true;
    console.log(
      `[mock] ${symbol} entering mock mode — no real ticks for ${SILENCE_THRESHOLD_MS / 1000}s`,
    );
    // Emit immediately so clients see movement right away.
    this.emitTick(symbol, state);
    // Start the shared interval if nothing else is already running.
    if (!this.mockInterval) {
      this.mockInterval = setInterval(() => this.tickAll(), MOCK_INTERVAL_MS);
    }
  }

  private tickAll(): void {
    const active: string[] = [];
    for (const [symbol, state] of this.symbols) {
      if (state.active) {
        this.emitTick(symbol, state);
        active.push(symbol);
      }
    }
    if (active.length > 0) {
      console.log(`[mock] emitted ${active.length} tick(s) for: ${active.join(', ')}`);
    }
  }

  private emitTick(symbol: string, state: SymbolState): void {
    const base = state.lastPrice ?? DEFAULT_SEED_PRICES[symbol] ?? 100;
    const magnitude = MOCK_MIN_DRIFT + Math.random() * (MOCK_MAX_DRIFT - MOCK_MIN_DRIFT);
    const sign = Math.random() < 0.5 ? 1 : -1;
    const raw = base * (1 + sign * magnitude);
    const price = +raw.toFixed(raw < 1 ? 4 : 2);
    state.lastPrice = price;
    this.onTick({ symbol, price, timestamp: Date.now(), volume: 0, source: 'mock' });
  }

  private maybeStopInterval(): void {
    const anyActive = [...this.symbols.values()].some((s) => s.active);
    if (!anyActive && this.mockInterval) {
      clearInterval(this.mockInterval);
      this.mockInterval = null;
    }
  }
}

// ── FinnhubClient ─────────────────────────────────────────────────────────────

interface FinnhubClientOptions {
  apiKey: string;
  onTick: (tick: PriceTick) => void;
  onStatusChange: (status: 'connected' | 'reconnecting' | 'disconnected') => void;
}

/**
 * Manages the single upstream WebSocket connection to Finnhub.
 *
 * Reconnection uses exponential backoff: 1s → 2s → 4s … capped at 30s.
 * The attempt counter resets on a successful open so recovered connections
 * start fresh.
 *
 * A MockFallback instance watches each subscribed symbol independently for
 * silence. Symbols enter and exit mock mode on their own schedules — a crypto
 * symbol trading 24/7 may be live while a US stock that closed hours ago is
 * being mocked. Mock ticks carry source: 'mock'; real ticks carry source: 'live'.
 */
export class FinnhubClient {
  private ws: WebSocket | null = null;
  private subscribedSymbols = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly mock: MockFallback;

  constructor(private readonly options: FinnhubClientOptions) {
    this.mock = new MockFallback(options.onTick);
  }

  connect(): void {
    if (this.destroyed) return;

    const url = `${FINNHUB_WS_URL}?token=${this.options.apiKey}`;
    console.log(`[finnhub] connecting (attempt ${this.reconnectAttempt + 1})`);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[finnhub] connected');
      this.reconnectAttempt = 0;
      this.options.onStatusChange('connected');

      // Re-subscribe everything — Finnhub forgets subscriptions on disconnect.
      for (const sym of this.subscribedSymbols) {
        this.sendFrame({ type: 'subscribe', symbol: sym });
      }
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      let msg: FinnhubMessage;
      try {
        msg = JSON.parse(raw.toString()) as FinnhubMessage;
      } catch {
        return;
      }

      if (msg.type !== 'trade') return;

      for (const trade of msg.data) {
        // Ignore ticks for symbols we don't care about (Finnhub can send extras
        // briefly after an unsubscribe frame races with an in-flight message).
        if (!this.subscribedSymbols.has(trade.s)) continue;

        const tick: PriceTick = {
          symbol: trade.s,
          price: trade.p,
          timestamp: trade.t,
          volume: trade.v,
          source: 'live',
        };

        this.options.onTick(tick);
        // Tell MockFallback a real tick arrived for this symbol — resets its
        // per-symbol silence watchdog and exits mock mode if it was active.
        this.mock.onRealTick(trade.s, trade.p);
      }
    });

    this.ws.on('error', (err) => {
      // 'error' always fires before 'close' on a failed connection, so just log
      // here and let the 'close' handler drive reconnection.
      console.error('[finnhub] socket error:', err.message);
    });

    this.ws.on('close', (code, reason) => {
      console.warn(`[finnhub] closed (code=${code} reason=${reason.toString() || 'none'})`);
      if (this.destroyed) return;
      this.options.onStatusChange('reconnecting');
      this.scheduleReconnect();
    });
  }

  subscribe(symbol: string): void {
    if (this.subscribedSymbols.has(symbol)) return;
    this.subscribedSymbols.add(symbol);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendFrame({ type: 'subscribe', symbol });
      console.log(`[finnhub] subscribed ${symbol}`);
    }
    // Start this symbol's per-symbol silence watchdog.
    this.mock.onSubscribe(symbol);
  }

  unsubscribe(symbol: string): void {
    if (!this.subscribedSymbols.has(symbol)) return;
    this.subscribedSymbols.delete(symbol);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendFrame({ type: 'unsubscribe', symbol });
      console.log(`[finnhub] unsubscribed ${symbol}`);
    }
    // Clear this symbol's watchdog and remove it from mock state.
    this.mock.onUnsubscribe(symbol);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.mock.destroy();
    this.ws?.close();
    this.ws = null;
  }

  private sendFrame(payload: object): void {
    this.ws?.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS);
    this.reconnectAttempt++;
    console.log(`[finnhub] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
