import { useEffect, useMemo, useState } from 'react';
import { UNIVERSE } from '../data/universe';
import { iconFor } from '../lib/iconFor';
import type { WatchlistItem } from '../types';
import './Search.css';

interface SearchProps {
  watchlist: WatchlistItem[];
  onAdd: (symbol: string) => void;
}

export function Search({ watchlist, onAdd }: SearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return UNIVERSE.filter((u) => !q || u.symbol.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)).slice(0, 7);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="search">
      <div className="search__field">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5b6373" strokeWidth={2} className="search__icon">
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" strokeLinecap="round" />
        </svg>
        <input
          className="search__input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search symbols to add…"
          style={{ borderColor: open ? 'rgba(22,199,132,.5)' : 'rgba(255,255,255,.08)' }}
        />
      </div>

      {open && (
        <>
          <div className="search__catcher" onClick={() => setOpen(false)} />
          <div className="search__dropdown">
            <div className="search__heading">{query ? `Results for "${query}"` : 'Popular symbols'}</div>
            <div className="search__list">
              {matched.map((u) => {
                const added = watchlist.some((w) => w.symbol === u.symbol);
                const ic = iconFor(u);
                return (
                  <div key={u.symbol} className="search__row">
                    <div className="search__row-icon" style={{ background: ic.bg, color: ic.color }}>
                      {ic.text}
                    </div>
                    <div className="search__row-info">
                      <div className="search__row-top">
                        <span className="search__row-symbol">{u.symbol}</span>
                        <span className="search__row-ex">{u.exchange}</span>
                      </div>
                      <div className="search__row-name">{u.name}</div>
                    </div>
                    <button
                      className="search__add-btn"
                      disabled={added}
                      style={{
                        cursor: added ? 'default' : 'pointer',
                        color: added ? '#8b93a3' : '#06241a',
                        background: added ? 'rgba(255,255,255,.05)' : 'var(--gain)',
                      }}
                      onClick={() => !added && onAdd(u.symbol)}
                    >
                      {added ? '✓ Added' : '+ Add'}
                    </button>
                  </div>
                );
              })}
              {matched.length === 0 && <div className="search__empty">No symbols match "{query}"</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
