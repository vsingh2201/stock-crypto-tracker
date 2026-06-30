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

/**
 * Watches the real-tick stream for silence. If no real tick arrives within
 * SILENCE_THRESHOLD_MS, enters mock mode and emits simulated ticks every
 * MOCK_INTERVAL_MS using a ±0.05%–0.15% random walk from the last known price.
 *
 * Mock ticks are routed through the same onTick callback as real ticks, so
 * index.ts, ClientManager, and browser clients are unaware of the difference.
 *
 * Real data always takes priority: the first real tick received while in mock
 * mode immediately exits mock mode and restarts the silence watchdog.
 */
class MockFallback {
  private readonly lastPrices = new Map<string, number>();
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private mockInterval: ReturnType<typeof setInterval> | null = null;
  private active = false;

  /**
   * @param getSubscribed - Returns the live subscribed-symbol set from
   *   FinnhubClient. Reading via a getter (not a snapshot) means mock ticks
   *   always reflect the current subscription state, even after mid-session
   *   subscribe/unsubscribe calls.
   * @param onTick - Identical callback used for real ticks in FinnhubClient.
   */
  constructor(
    private readonly getSubscribed: () => ReadonlySet<string>,
    private readonly onTick: (tick: PriceTick) => void,
  ) {}

  /**
   * Call whenever a real Finnhub trade tick is received.
   * Records the price as the new random-walk anchor and resets the silence
   * watchdog. If mock mode was active, exits it immediately.
   */
  onRealTick(symbol: string, price: number): void {
    this.lastPrices.set(symbol, price);

    if (this.active) {
      console.log('[mock] exiting mock mode — real tick received');
      this.active = false;
      this.stopMockInterval();
    }

    this.resetSilenceTimer();
  }

  /**
   * Call after a symbol is added to the subscription set.
   * Starts the silence watchdog if it is not already running.
   */
  onSubscribe(): void {
    if (!this.silenceTimer && !this.active) {
      this.resetSilenceTimer();
    }
  }

  /**
   * Call after a symbol is removed from the subscription set.
   * Stops all timers if no subscriptions remain.
   */
  onUnsubscribe(): void {
    if (this.getSubscribed().size === 0) {
      this.stopSilenceTimer();
      if (this.active) {
        this.active = false;
        this.stopMockInterval();
      }
    }
  }

  /** Stop all timers — must be called from FinnhubClient.destroy(). */
  destroy(): void {
    this.stopSilenceTimer();
    this.stopMockInterval();
  }

  // ── private ───────────────────────────────────────────────────────────────

  private resetSilenceTimer(): void {
    this.stopSilenceTimer();
    if (this.getSubscribed().size === 0) return;

    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.enterMockMode();
    }, SILENCE_THRESHOLD_MS);
  }

  private stopSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private enterMockMode(): void {
    if (this.active) return;
    this.active = true;
    console.log(
      `[mock] entering mock mode — no real ticks for ${SILENCE_THRESHOLD_MS / 1000}s`,
    );
    // Fire immediately so clients see movement at once, then every interval.
    this.emitMockTicks();
    this.mockInterval = setInterval(() => this.emitMockTicks(), MOCK_INTERVAL_MS);
  }

  private stopMockInterval(): void {
    if (this.mockInterval !== null) {
      clearInterval(this.mockInterval);
      this.mockInterval = null;
    }
  }

  private emitMockTicks(): void {
    const now = Date.now();
    const symbols = this.getSubscribed();

    for (const symbol of symbols) {
      const base = this.lastPrices.get(symbol) ?? DEFAULT_SEED_PRICES[symbol] ?? 100;
      const magnitude = MOCK_MIN_DRIFT + Math.random() * (MOCK_MAX_DRIFT - MOCK_MIN_DRIFT);
      const sign = Math.random() < 0.5 ? 1 : -1;
      const rawPrice = base * (1 + sign * magnitude);
      // Preserve meaningful decimal places: 4 for sub-dollar assets, 2 otherwise.
      const price = +rawPrice.toFixed(rawPrice < 1 ? 4 : 2);
      this.lastPrices.set(symbol, price);

      this.onTick({ symbol, price, timestamp: now, volume: 0 });
    }

    if (symbols.size > 0) {
      console.log(`[mock] emitted ${symbols.size} tick(s) for: ${[...symbols].join(', ')}`);
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
 * `subscribedSymbols` is the source of truth for what Finnhub should be
 * streaming. On reconnect every symbol is re-subscribed automatically because
 * Finnhub does not persist subscriptions across connections.
 *
 * A MockFallback instance watches for real-tick silence and automatically
 * emits simulated ticks when no real data has arrived for SILENCE_THRESHOLD_MS.
 * Mock ticks flow through the same onTick callback as real ticks, so
 * index.ts and ClientManager need no changes.
 */
export class FinnhubClient {
  private ws: WebSocket | null = null;
  private subscribedSymbols = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly mock: MockFallback;

  constructor(private readonly options: FinnhubClientOptions) {
    this.mock = new MockFallback(
      () => this.subscribedSymbols,
      options.onTick,
    );
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
        };

        this.options.onTick(tick);
        // Inform MockFallback — updates its last-price anchor and resets the
        // silence watchdog (exits mock mode if it was active).
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
    // Start the silence watchdog for this symbol if it isn't already running.
    this.mock.onSubscribe();
  }

  unsubscribe(symbol: string): void {
    if (!this.subscribedSymbols.has(symbol)) return;
    this.subscribedSymbols.delete(symbol);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendFrame({ type: 'unsubscribe', symbol });
      console.log(`[finnhub] unsubscribed ${symbol}`);
    }
    // Stop mock machinery if no symbols remain.
    this.mock.onUnsubscribe();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.mock.destroy(); // clears silence timer and mock interval
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
