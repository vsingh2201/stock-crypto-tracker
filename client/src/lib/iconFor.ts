import type { Instrument } from '../types';

export function iconFor(instrument: Pick<Instrument, 'symbol' | 'type'> | undefined) {
  if (!instrument) return { bg: 'rgba(255,255,255,.06)', color: '#b8c0cf', text: '•' };
  const text = instrument.symbol.replace('-USD', '').slice(0, 4);
  if (instrument.type === 'crypto') return { bg: 'rgba(247,147,26,.14)', color: '#f7931a', text };
  return { bg: 'rgba(77,139,255,.14)', color: '#6f9bff', text };
}
