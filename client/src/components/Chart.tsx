import { useMemo } from 'react';
import { formatPrice, TIMEFRAME_X_LABELS } from '../lib/marketMath';
import type { Candle, Timeframe } from '../types';
import './Chart.css';

interface ChartProps {
  candles: Candle[];
  timeframe: Timeframe;
  gainColor: string;
  lossColor: string;
  lastPriceColor: string;
  showVolume: boolean;
}

export function Chart({ candles, timeframe, gainColor, lossColor, lastPriceColor, showVolume }: ChartProps) {
  const geometry = useMemo(() => {
    let hi = -Infinity;
    let lo = Infinity;
    candles.forEach((c) => {
      hi = Math.max(hi, c.high);
      lo = Math.min(lo, c.low);
    });
    const pad = (hi - lo) * 0.08 || 1;
    const max = hi + pad;
    const min = lo - pad;
    const range = max - min || 1;
    const topOf = (p: number) => ((max - p) / range) * 100;

    const bars = candles.map((c) => {
      const up = c.close >= c.open;
      const color = up ? gainColor : lossColor;
      const bodyTop = topOf(Math.max(c.open, c.close));
      const bodyBottom = topOf(Math.min(c.open, c.close));
      return {
        wickTop: topOf(c.high),
        wickHeight: Math.max(topOf(c.low) - topOf(c.high), 0.4),
        bodyTop,
        bodyHeight: Math.max(bodyBottom - bodyTop, 0.6),
        color,
        volumeHeight: c.volume * 100,
        volumeColor: up ? 'rgba(22,199,132,.42)' : 'rgba(246,70,93,.42)',
      };
    });

    const yLabels = Array.from({ length: 5 }, (_, i) => {
      const v = max - (range * i) / 4;
      return { top: (i / 4) * 100, label: `$${formatPrice(v)}` };
    });

    const last = candles[candles.length - 1];

    return { bars, yLabels, lastTop: topOf(last.close), lastTag: formatPrice(last.close) };
  }, [candles, gainColor, lossColor]);

  const xLabels = TIMEFRAME_X_LABELS[timeframe];

  return (
    <div className="chart">
      <div className="chart__price-pane">
        <div className="chart__inset">
          {geometry.yLabels.map((y, i) => (
            <div key={i} className="chart__grid-row" style={{ top: `${y.top}%` }}>
              <div className="chart__grid-line" />
              <div className="chart__y-label">{y.label}</div>
            </div>
          ))}

          <div className="chart__candles">
            {geometry.bars.map((bar, i) => (
              <div key={i} className="chart__candle">
                <div
                  className="chart__wick"
                  style={{ top: `${bar.wickTop}%`, height: `${bar.wickHeight}%`, background: bar.color }}
                />
                <div
                  className="chart__body"
                  style={{ top: `${bar.bodyTop}%`, height: `${bar.bodyHeight}%`, background: bar.color }}
                />
              </div>
            ))}
          </div>

          <div
            className="chart__last-line"
            style={{ top: `${geometry.lastTop}%`, background: `repeating-linear-gradient(90deg, ${lastPriceColor} 0 5px, transparent 5px 10px)` }}
          />
          <div className="chart__last-tag" style={{ top: `${geometry.lastTop}%`, background: lastPriceColor }}>
            {geometry.lastTag}
          </div>
        </div>
      </div>

      {showVolume && (
        <div className="chart__volume">
          <div className="chart__volume-bars">
            {geometry.bars.map((bar, i) => (
              <div key={i} className="chart__volume-col">
                <div className="chart__volume-bar" style={{ height: `${bar.volumeHeight}%`, background: bar.volumeColor }} />
              </div>
            ))}
          </div>
          <div className="chart__volume-label">VOL</div>
        </div>
      )}

      <div className="chart__x-labels">
        {xLabels.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}
