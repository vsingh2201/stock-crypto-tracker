import WebSocket from 'ws';
import type { PriceTick } from './types';

/**
 * Tracks all connected browser clients, their symbol subscriptions, and their
 * session IDs.
 *
 * Three mirrored maps provide O(1) lookups in every direction:
 *   clientSymbols   ws → symbols it wants
 *   symbolClients   symbol → ws set that wants it
 *   sessionClients  session_id → ws set for that session (for alert routing)
 */
export class ClientManager {
  private clientSymbols = new Map<WebSocket, Set<string>>();
  private symbolClients = new Map<string, Set<WebSocket>>();
  // One session can have multiple WebSocket connections (multiple tabs).
  private sessionClients = new Map<string, Set<WebSocket>>();
  private clientSession = new Map<WebSocket, string>();

  addClient(ws: WebSocket, sessionId: string): void {
    this.clientSymbols.set(ws, new Set());
    this.clientSession.set(ws, sessionId);
    if (!this.sessionClients.has(sessionId)) {
      this.sessionClients.set(sessionId, new Set());
    }
    this.sessionClients.get(sessionId)!.add(ws);
  }

  /**
   * Remove a client and return every symbol that now has zero watchers.
   * The caller uses this list to send Finnhub unsubscribe frames.
   */
  removeClient(ws: WebSocket): string[] {
    // Clean up session mapping.
    const sessionId = this.clientSession.get(ws);
    if (sessionId) {
      const sessionWs = this.sessionClients.get(sessionId);
      if (sessionWs) {
        sessionWs.delete(ws);
        if (sessionWs.size === 0) this.sessionClients.delete(sessionId);
      }
      this.clientSession.delete(ws);
    }

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

  /**
   * Add a symbol subscription for a client.
   * Returns true when this client is the *first* subscriber for the symbol —
   * the caller should then forward the subscription upstream to Finnhub.
   */
  subscribe(ws: WebSocket, symbol: string): boolean {
    const symSet = this.clientSymbols.get(ws);
    if (!symSet) return false;
    symSet.add(symbol);

    if (!this.symbolClients.has(symbol)) {
      this.symbolClients.set(symbol, new Set());
    }
    const clients = this.symbolClients.get(symbol)!;
    const isFirst = clients.size === 0;
    clients.add(ws);
    return isFirst;
  }

  /**
   * Remove a symbol subscription for a client.
   * Returns true when this symbol now has zero subscribers —
   * the caller should then send an unsubscribe frame to Finnhub.
   */
  unsubscribe(ws: WebSocket, symbol: string): boolean {
    const symSet = this.clientSymbols.get(ws);
    if (symSet) symSet.delete(symbol);

    const clients = this.symbolClients.get(symbol);
    if (!clients) return true;
    clients.delete(ws);
    if (clients.size === 0) {
      this.symbolClients.delete(symbol);
      return true;
    }
    return false;
  }

  /** Send a price tick to every client watching that symbol. */
  broadcast(tick: PriceTick): void {
    const clients = this.symbolClients.get(tick.symbol);
    if (!clients || clients.size === 0) return;

    const payload = JSON.stringify({
      type: 'tick',
      symbol: tick.symbol,
      price: tick.price,
      timestamp: tick.timestamp,
      volume: tick.volume,
      source: tick.source,
    } satisfies import('./types').TickMessage);

    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /** Send a raw JSON string to every connected client (e.g. status changes). */
  broadcastAll(payload: string): void {
    for (const ws of this.clientSymbols.keys()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /** Send a raw JSON string to all WebSocket connections owned by a session. */
  sendToSession(sessionId: string, payload: string): void {
    const clients = this.sessionClients.get(sessionId);
    if (!clients) return;
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  get clientCount(): number {
    return this.clientSymbols.size;
  }

  get subscribedSymbols(): ReadonlySet<string> {
    return new Set(this.symbolClients.keys());
  }
}
