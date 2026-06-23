import { useEffect, useState } from 'react';
import { formatPrice } from '../lib/marketMath';
import { iconFor } from '../lib/iconFor';
import type { Quote } from '../types';
import './AlertModal.css';

interface AlertModalProps {
  quote: Quote;
  onClose: () => void;
  onCreate: (direction: 'above' | 'below', target: number) => void;
}

export function AlertModal({ quote, onClose, onCreate }: AlertModalProps) {
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [target, setTarget] = useState(() => formatPrice(quote.price * 1.03).replace(/,/g, ''));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const above = direction === 'above';
  const ic = iconFor(quote);
  const presets = [
    { label: '−5%', value: () => formatPrice(quote.price * 0.95).replace(/,/g, '') },
    { label: 'Current', value: () => formatPrice(quote.price).replace(/,/g, '') },
    { label: '+5%', value: () => formatPrice(quote.price * 1.05).replace(/,/g, '') },
  ];

  return (
    <div className="alert-modal-overlay">
      <div className="alert-modal-overlay__catcher" onClick={onClose} />
      <div className="alert-modal">
        <div className="alert-modal__header">
          <span className="alert-modal__title">Create price alert</span>
          <button className="alert-modal__close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="alert-modal__symbol-field">
          <div className="alert-modal__icon" style={{ background: ic.bg, color: ic.color }}>
            {ic.text}
          </div>
          <div className="alert-modal__symbol-info">
            <div className="alert-modal__symbol">{quote.symbol}</div>
            <div className="alert-modal__symbol-name">{quote.name}</div>
          </div>
          <div className="alert-modal__current">
            <div className="alert-modal__current-label">Current</div>
            <div className="alert-modal__current-value">${formatPrice(quote.price)}</div>
          </div>
        </div>

        <div className="alert-modal__section-label">Condition</div>
        <div className="alert-modal__condition-grid">
          <button
            className="alert-modal__condition-btn"
            onClick={() => setDirection('above')}
            style={{
              borderColor: above ? 'rgba(22,199,132,.5)' : 'rgba(255,255,255,.08)',
              background: above ? 'rgba(22,199,132,.12)' : 'transparent',
              color: above ? 'var(--gain)' : 'var(--text-secondary)',
            }}
          >
            ▲ Crosses above
          </button>
          <button
            className="alert-modal__condition-btn"
            onClick={() => setDirection('below')}
            style={{
              borderColor: !above ? 'rgba(246,70,93,.5)' : 'rgba(255,255,255,.08)',
              background: !above ? 'rgba(246,70,93,.12)' : 'transparent',
              color: !above ? 'var(--loss)' : 'var(--text-secondary)',
            }}
          >
            ▼ Crosses below
          </button>
        </div>

        <div className="alert-modal__target-header">
          <span className="alert-modal__section-label">Target price</span>
          <div className="alert-modal__presets">
            {presets.map((p) => (
              <button key={p.label} className="alert-modal__preset-btn" onClick={() => setTarget(p.value())}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="alert-modal__target-field">
          <span className="alert-modal__dollar">$</span>
          <input
            className="alert-modal__target-input"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            inputMode="decimal"
          />
        </div>

        <div className="alert-modal__preview">
          Notify me when {quote.symbol}{' '}
          <span style={{ color: above ? 'var(--gain)' : 'var(--loss)', fontWeight: 600 }}>
            {above ? 'rises above' : 'falls below'} ${target || '—'}
          </span>
          .
        </div>

        <div className="alert-modal__footer">
          <button className="alert-modal__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="alert-modal__create"
            onClick={() => onCreate(direction, parseFloat(target))}
            disabled={!target || Number.isNaN(parseFloat(target))}
          >
            Create alert
          </button>
        </div>
      </div>
    </div>
  );
}
