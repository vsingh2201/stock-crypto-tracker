import { pool } from './db';
import type { Alert } from './types';

type AlertCallback = (alert: Alert, triggeredPrice: number) => void;

/**
 * In-memory alert engine.
 *
 * Alerts are indexed by symbol so checkTick is O(alerts for that symbol),
 * not O(all alerts). The DB is only touched when an alert is created,
 * deleted, or triggered — never on the hot tick path.
 *
 * Invariant: only live Finnhub ticks are checked. Mock ticks are random
 * walks that can temporarily cross thresholds, producing false fires.
 */
export class AlertEngine {
  private readonly bySymbol = new Map<string, Alert[]>();
  private readonly byId = new Map<string, Alert>();

  constructor(private readonly onAlert: AlertCallback) {}

  /** Load all untriggered alerts from the DB into the in-memory index. */
  async load(): Promise<void> {
    const result = await pool.query<Alert>(
      `SELECT id, session_id, symbol, condition,
              CAST(target_price AS float8) AS target_price,
              triggered_at, created_at
       FROM alerts WHERE triggered_at IS NULL`,
    );
    for (const row of result.rows) {
      this.index(row);
    }
    console.log(`[alerts] loaded ${result.rowCount ?? 0} active alert(s)`);
  }

  /** Call after a REST POST creates a new alert. */
  add(alert: Alert): void {
    this.index(alert);
  }

  /** Call after a REST DELETE removes an alert. */
  remove(id: string): void {
    const alert = this.byId.get(id);
    if (!alert) return;
    this.byId.delete(id);
    const list = this.bySymbol.get(alert.symbol);
    if (!list) return;
    const filtered = list.filter((a) => a.id !== id);
    if (filtered.length === 0) {
      this.bySymbol.delete(alert.symbol);
    } else {
      this.bySymbol.set(alert.symbol, filtered);
    }
  }

  /**
   * Called on every incoming tick. Only processes live ticks — mock prices
   * are excluded to prevent false alert fires during after-hours simulation.
   */
  checkTick(symbol: string, price: number, source: 'live' | 'mock'): void {
    if (source !== 'live') return;

    const alerts = this.bySymbol.get(symbol);
    if (!alerts?.length) return;

    for (const alert of [...alerts]) {
      const hit =
        (alert.condition === 'above' && price >= alert.target_price) ||
        (alert.condition === 'below' && price <= alert.target_price);

      if (hit) {
        this.remove(alert.id);
        pool
          .query('UPDATE alerts SET triggered_at = NOW() WHERE id = $1', [alert.id])
          .catch((err) => console.error('[alerts] DB mark-triggered failed:', err));
        this.onAlert(alert, price);
      }
    }
  }

  private index(alert: Alert): void {
    this.byId.set(alert.id, alert);
    const list = this.bySymbol.get(alert.symbol) ?? [];
    list.push(alert);
    this.bySymbol.set(alert.symbol, list);
  }
}
