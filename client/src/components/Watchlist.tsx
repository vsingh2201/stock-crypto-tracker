import { useState } from 'react';
import { formatPrice, sparkToPoints } from '../lib/marketMath';
import type { WatchlistItem } from '../types';
import './Watchlist.css';

interface WatchlistProps {
  items: WatchlistItem[];
  selected: string;
  gainColor: string;
  lossColor: string;
  onSelect: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path
        d="M1.5 3.25h10M4.75 3.25V2.5A.75.75 0 015.5 1.75h2a.75.75 0 01.75.75v.75M5.25 5.75v3.5M7.75 5.75v3.5M2.5 3.25l.65 6.3a.75.75 0 00.75.7h5.2a.75.75 0 00.75-.7l.65-6.3"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Watchlist({ items, selected, gainColor, lossColor, onSelect, onRemove }: WatchlistProps) {
  // Tracks symbols whose rows are currently playing the fade-out animation.
  // The actual onRemove callback fires via onAnimationEnd, not on click,
  // so the row disappears smoothly before state updates.
  const [removing, setRemoving] = useState<Set<string>>(new Set());

  const startRemove = (e: React.MouseEvent, symbol: string) => {
    e.stopPropagation(); // don't trigger row selection
    setRemoving((prev) => new Set(prev).add(symbol));
  };

  const finishRemove = (symbol: string) => {
    setRemoving((prev) => {
      const next = new Set(prev);
      next.delete(symbol);
      return next;
    });
    onRemove(symbol);
  };

  return (
    <div className="watchlist">
      {items.map((w) => {
        const up = w.changePct >= 0;
        const color = up ? gainColor : lossColor;
        const isSelected = w.symbol === selected;
        const isRemoving = removing.has(w.symbol);

        return (
          <div
            key={w.symbol}
            className={`watchlist__row${isRemoving ? ' watchlist__row--removing' : ''}`}
            onClick={() => onSelect(w.symbol)}
            onAnimationEnd={() => { if (isRemoving) finishRemove(w.symbol); }}
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
            <button
              className="watchlist__remove"
              onClick={(e) => startRemove(e, w.symbol)}
              aria-label={`Remove ${w.symbol} from watchlist`}
              title={`Remove ${w.symbol}`}
            >
              <TrashIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}
