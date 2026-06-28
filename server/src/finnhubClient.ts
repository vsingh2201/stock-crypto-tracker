import WebSocket from 'ws';
import type { FinnhubMessage, PriceTick } from './types';

const FINNHUB_WS_URL = 'wss://ws.finnhub.io';
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

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
 */
export class FinnhubClient {
  private ws: WebSocket | null = null;
  private subscribedSymbols = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private readonly options: FinnhubClientOptions) {}

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
        this.options.onTick({
          symbol: trade.s,
          price: trade.p,
          timestamp: trade.t,
          volume: trade.v,
        });
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
  }

  unsubscribe(symbol: string): void {
    if (!this.subscribedSymbols.has(symbol)) return;
    this.subscribedSymbols.delete(symbol);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendFrame({ type: 'unsubscribe', symbol });
      console.log(`[finnhub] unsubscribed ${symbol}`);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
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
