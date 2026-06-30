import { formatPrice, sparkToPoints } from '../lib/marketMath';
import type { WatchlistItem } from '../types';
import './Watchlist.css';

interface WatchlistProps {
  items: WatchlistItem[];
  selected: string;
  gainColor: string;
  lossColor: string;
  onSelect: (symbol: string) => void;
}

export function Watchlist({ items, selected, gainColor, lossColor, onSelect }: WatchlistProps) {
  return (
    <div className="watchlist">
      {items.map((w) => {
        const up = w.changePct >= 0;
        const color = up ? gainColor : lossColor;
        const isSelected = w.symbol === selected;
        return (
          <div
            key={w.symbol}
            className="watchlist__row"
            onClick={() => onSelect(w.symbol)}
            style={{ background: isSelected ? 'rgba(255,255,255,.05)' : 'transparent' }}
          >
            <div className="watchlist__bar" style={{ background: isSelected ? gainColor : 'transparent' }} />
            <div className="watchlist__info">
              <div className="watchlist__symbol">
                {w.symbol}
                {w.source === 'mock' && (
                  <span className="watchlist__sim-dot" title="Simulated data" />
                )}
              </div>
              <div className="watchlist__name">{w.name}</div>
            </div>
            <svg width="58" height="24" viewBox="0 0 56 24" fill="none" preserveAspectRatio="none" className="watchlist__spark">
              <polyline points={sparkToPoints(w.spark)} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
            </svg>
            <div className="watchlist__price-col">
              <div className="watchlist__price">${formatPrice(w.price)}</div>
              <div className="watchlist__change" style={{ color }}>
                {up ? '▲' : '▼'} {Math.abs(w.changePct).toFixed(2)}%
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
