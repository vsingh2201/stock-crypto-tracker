import type { AlertItem } from '../types';
import './AlertList.css';

interface AlertListProps {
  alerts: AlertItem[];
  onDelete: (id: string) => void;
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2 3.5h10M5 3.5V2.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1M5.5 6v4M8.5 6v4M3 3.5l.7 7.2A.5.5 0 0 0 4.2 11h5.6a.5.5 0 0 0 .5-.3L11 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatTarget(price: number): string {
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(2);
  return price.toPrecision(4);
}

export function AlertList({ alerts, onDelete }: AlertListProps) {
  if (alerts.length === 0) return null;

  return (
    <div className="alert-list">
      <div className="alert-list__header">
        <span className="alert-list__title">Active alerts</span>
        <span className="alert-list__count">{alerts.length}</span>
      </div>
      <ul className="alert-list__items">
        {alerts.map((a) => {
          const above = a.condition === 'above';
          return (
            <li key={a.id} className="alert-list__item">
              <div className="alert-list__symbol">{a.symbol}</div>
              <div className="alert-list__condition" style={{ color: above ? '#16c784' : '#f6465d' }}>
                {above ? '▲ above' : '▼ below'}
              </div>
              <div className="alert-list__price">${formatTarget(a.targetPrice)}</div>
              <button
                className="alert-list__delete"
                onClick={() => onDelete(a.id)}
                title="Delete alert"
              >
                <TrashIcon />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
