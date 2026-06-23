import type { Instrument } from '../types';

export const UNIVERSE: (Instrument & { seedPrice: number })[] = [
  { symbol: 'BTC-USD', name: 'Bitcoin', exchange: 'COINBASE', type: 'crypto', seedPrice: 64182.4 },
  { symbol: 'ETH-USD', name: 'Ethereum', exchange: 'COINBASE', type: 'crypto', seedPrice: 3389.12 },
  { symbol: 'SOL-USD', name: 'Solana', exchange: 'COINBASE', type: 'crypto', seedPrice: 148.73 },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NASDAQ', type: 'stock', seedPrice: 124.88 },
  { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', type: 'stock', seedPrice: 212.49 },
  { symbol: 'TSLA', name: 'Tesla, Inc.', exchange: 'NASDAQ', type: 'stock', seedPrice: 183.01 },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF', exchange: 'NYSE', type: 'stock', seedPrice: 548.22 },
  { symbol: 'AVAX-USD', name: 'Avalanche', exchange: 'COINBASE', type: 'crypto', seedPrice: 27.41 },
  { symbol: 'DOGE-USD', name: 'Dogecoin', exchange: 'COINBASE', type: 'crypto', seedPrice: 0.1623 },
  { symbol: 'LINK-USD', name: 'Chainlink', exchange: 'COINBASE', type: 'crypto', seedPrice: 13.88 },
  { symbol: 'XRP-USD', name: 'XRP', exchange: 'COINBASE', type: 'crypto', seedPrice: 0.4821 },
  { symbol: 'AMD', name: 'Advanced Micro Devices', exchange: 'NASDAQ', type: 'stock', seedPrice: 158.22 },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', exchange: 'NASDAQ', type: 'stock', seedPrice: 178.35 },
  { symbol: 'AMZN', name: 'Amazon.com, Inc.', exchange: 'NASDAQ', type: 'stock', seedPrice: 184.7 },
  { symbol: 'MSFT', name: 'Microsoft Corporation', exchange: 'NASDAQ', type: 'stock', seedPrice: 449.78 },
  { symbol: 'META', name: 'Meta Platforms, Inc.', exchange: 'NASDAQ', type: 'stock', seedPrice: 504.22 },
  { symbol: 'COIN', name: 'Coinbase Global, Inc.', exchange: 'NASDAQ', type: 'stock', seedPrice: 241.1 },
];

export const SEED_WATCHLIST: { symbol: string; changePct: number }[] = [
  { symbol: 'BTC-USD', changePct: 2.41 },
  { symbol: 'ETH-USD', changePct: 1.18 },
  { symbol: 'SOL-USD', changePct: -3.42 },
  { symbol: 'NVDA', changePct: 0.94 },
  { symbol: 'AAPL', changePct: -0.37 },
  { symbol: 'TSLA', changePct: 4.12 },
  { symbol: 'SPY', changePct: 0.21 },
];
