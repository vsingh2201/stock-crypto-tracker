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
  source: 'live' | 'mock';
}

export interface StatusMessage {
  type: 'status';
  status: 'connected' | 'reconnecting' | 'disconnected';
}

export interface AlertTriggeredMessage {
  type: 'alert_triggered';
  alertId: string;
  symbol: string;
  condition: 'above' | 'below';
  targetPrice: number;
  triggeredPrice: number;
  triggeredAt: string;
}

export type ServerMessage = TickMessage | StatusMessage | AlertTriggeredMessage;

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

// ── DB entities ─────────────────────────────────────────────────────────────

export interface Alert {
  id: string;
  session_id: string;
  symbol: string;
  condition: 'above' | 'below';
  target_price: number; // pg DECIMAL returns as number after CAST(…AS float8)
  triggered_at: string | null;
  created_at: string;
}

// ── Internal ────────────────────────────────────────────────────────────────

export interface PriceTick {
  symbol: string;
  price: number;
  timestamp: number;
  volume: number;
  source: 'live' | 'mock';
}
