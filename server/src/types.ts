// ── Messages: browser client → relay server ─────────────────────────────────

export interface ClientSubscribeMsg {
  type: 'subscribe';
  symbol: string;
}

export interface ClientUnsubscribeMsg {
  type: 'unsubscribe';
  symbol: string;
}

export type ClientMessage = ClientSubscribeMsg | ClientUnsubscribeMsg;

// ── Messages: relay server → browser client ─────────────────────────────────

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

// ── Finnhub wire format (upstream) ──────────────────────────────────────────

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

// ── Internal ────────────────────────────────────────────────────────────────

export interface PriceTick {
  symbol: string;
  price: number;
  timestamp: number;
  volume: number;
}
