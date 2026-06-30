export type InstrumentType = 'crypto' | 'stock';

export interface Instrument {
  symbol: string;
  name: string;
  exchange: string;
  type: InstrumentType;
}

export interface Quote extends Instrument {
  price: number;
  changePct: number;
}

export interface WatchlistItem extends Quote {
  spark: number[];
  source: 'live' | 'mock';
}

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = '1D' | '1W' | '1M';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export interface AlertCondition {
  symbol: string;
  direction: 'above' | 'below';
  target: number;
}
