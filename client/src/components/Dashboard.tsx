import { useEffect, useRef, useState } from 'react';
import { useMarketFeed } from '../hooks/useMarketFeed';
import { formatPrice } from '../lib/marketMath';
import type { Timeframe } from '../types';
import { TopBar } from './TopBar';
import { Chart } from './Chart';
import { Watchlist } from './Watchlist';
import { Search } from './Search';
import { AlertModal } from './AlertModal';
import { Toast } from './Toast';
import './Dashboard.css';

const GAIN = '#16c784';
const LOSS = '#f6465d';
const TIMEFRAMES: Timeframe[] = ['1D', '1W', '1M'];

export function Dashboard() {
  const feed = useMarketFeed('BTC-USD', '1D');
  const [alertOpen, setAlertOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const showToast = (msg: string) => {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };

  const selectedQuote = feed.watchlist.find((w) => w.symbol === feed.selected);
  if (!selectedQuote) return null;

  const up = selectedQuote.changePct >= 0;
  const headerColor = up ? GAIN : LOSS;
  const dollarChange = selectedQuote.price - selectedQuote.price / (1 + selectedQuote.changePct / 100);

  const connMap = {
    connected: { color: GAIN, label: 'Live', bg: 'rgba(22,199,132,.1)' },
    reconnecting: { color: '#f5a623', label: 'Reconnecting…', bg: 'rgba(245,166,35,.1)' },
    disconnected: { color: LOSS, label: 'Disconnected', bg: 'rgba(246,70,93,.1)' },
  } as const;
  const conn = connMap[feed.connection];

  return (
    <div className="dashboard">
      <TopBar />
      <div className="dashboard__content">
        <div className="dashboard__chart-panel">
          <div className="dashboard__chart-header">
            <div>
              <div className="dashboard__symbol-row">
                <span className="dashboard__symbol">{selectedQuote.symbol}</span>
                <span className="dashboard__symbol-name">
                  {selectedQuote.name} · {selectedQuote.exchange.charAt(0) + selectedQuote.exchange.slice(1).toLowerCase()}
                </span>
              </div>
              <div className="dashboard__price-row">
                <span className="dashboard__price">${formatPrice(selectedQuote.price)}</span>
                <span
                  className="dashboard__change"
                  style={{ color: headerColor, background: up ? 'rgba(22,199,132,.12)' : 'rgba(246,70,93,.12)' }}
                >
                  <span className="dashboard__change-arrow">{up ? '▲' : '▼'}</span>
                  {Math.abs(selectedQuote.changePct).toFixed(2)}% ({up ? '+' : '−'}${formatPrice(Math.abs(dollarChange))})
                </span>
              </div>
            </div>
            <div className="dashboard__chart-controls">
              <div className="dashboard__timeframes">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    className="dashboard__timeframe-btn"
                    onClick={() => feed.setTimeframe(tf)}
                    style={{
                      color: feed.timeframe === tf ? '#e6e9ef' : '#8b93a3',
                      background: feed.timeframe === tf ? 'rgba(255,255,255,.08)' : 'transparent',
                    }}
                  >
                    {tf}
                  </button>
                ))}
              </div>
              <button className="dashboard__alert-btn" onClick={() => setAlertOpen(true)}>
                <span className="dashboard__alert-dot" />
                Set alert
              </button>
            </div>
          </div>

          <Chart candles={feed.candles} timeframe={feed.timeframe} gainColor={GAIN} lossColor={LOSS} lastPriceColor={headerColor} showVolume />
        </div>

        <div className="dashboard__watchlist-panel">
          <div className="dashboard__watchlist-header">
            <div className="dashboard__watchlist-title-row">
              <div className="dashboard__watchlist-title">
                <span>Watchlist</span>
                <span className="dashboard__watchlist-count">{feed.watchlist.length}</span>
              </div>
              <div className="dashboard__conn" style={{ color: conn.color, background: conn.bg }}>
                <span className="dashboard__conn-dot" style={{ background: conn.color }} />
                {conn.label}
              </div>
            </div>
            <Search
              watchlist={feed.watchlist}
              onAdd={(symbol) => {
                feed.addSymbol(symbol);
                showToast(`${symbol} added to watchlist`);
              }}
            />
          </div>
          <Watchlist items={feed.watchlist} selected={feed.selected} gainColor={GAIN} lossColor={LOSS} onSelect={feed.selectSymbol} />
        </div>
      </div>

      {alertOpen && (
        <AlertModal
          quote={selectedQuote}
          onClose={() => setAlertOpen(false)}
          onCreate={(direction, target) => {
            setAlertOpen(false);
            showToast(`Alert set · ${selectedQuote.symbol} crosses ${direction} $${target}`);
          }}
        />
      )}

      {toast && <Toast message={toast} />}
    </div>
  );
}
