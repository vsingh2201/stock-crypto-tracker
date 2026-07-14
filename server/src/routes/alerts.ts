import http from 'http';
import { pool } from '../db';
import type { AlertEngine } from '../alertEngine';
import type { Alert } from '../types';

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

/**
 * Handles /api/alerts routes. Returns true if the request was handled.
 * CORS headers are set upstream in index.ts via res.setHeader().
 */
export async function handleAlerts(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  alertEngine: AlertEngine,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (!pathname.startsWith('/api/alerts')) return false;

  const sessionId = req.headers['x-session-id'];
  if (!sessionId || typeof sessionId !== 'string') {
    json(res, 400, { error: 'Missing x-session-id header' });
    return true;
  }

  try {
    // GET /api/alerts
    if (pathname === '/api/alerts' && method === 'GET') {
      const result = await pool.query<Alert>(
        `SELECT id, session_id, symbol, condition,
                CAST(target_price AS float8) AS target_price,
                triggered_at, created_at
         FROM alerts
         WHERE session_id = $1 AND triggered_at IS NULL
         ORDER BY created_at DESC`,
        [sessionId],
      );
      json(res, 200, { alerts: result.rows });
      return true;
    }

    // POST /api/alerts
    if (pathname === '/api/alerts' && method === 'POST') {
      let body: unknown;
      try { body = await readBody(req); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return true; }

      const b = body as Record<string, unknown>;
      const { symbol, condition, target_price } = b;

      if (!symbol || typeof symbol !== 'string') {
        json(res, 400, { error: 'Missing symbol' }); return true;
      }
      if (condition !== 'above' && condition !== 'below') {
        json(res, 400, { error: 'condition must be "above" or "below"' }); return true;
      }
      const targetPrice = Number(target_price);
      if (Number.isNaN(targetPrice) || targetPrice <= 0) {
        json(res, 400, { error: 'Invalid target_price' }); return true;
      }

      const result = await pool.query<Alert>(
        `INSERT INTO alerts (session_id, symbol, condition, target_price)
         VALUES ($1, $2, $3, $4)
         RETURNING id, session_id, symbol, condition,
                   CAST(target_price AS float8) AS target_price,
                   triggered_at, created_at`,
        [sessionId, symbol, condition, targetPrice],
      );
      const alert = result.rows[0];
      alertEngine.add(alert);
      console.log(`[alerts] created: ${symbol} ${condition} ${targetPrice} for session ${sessionId}`);
      json(res, 201, alert);
      return true;
    }

    // DELETE /api/alerts/:id
    const deleteMatch = pathname.match(/^\/api\/alerts\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      const id = deleteMatch[1];
      const result = await pool.query(
        'DELETE FROM alerts WHERE id = $1 AND session_id = $2',
        [id, sessionId],
      );
      if ((result.rowCount ?? 0) === 0) {
        json(res, 404, { error: 'Alert not found' }); return true;
      }
      alertEngine.remove(id);
      json(res, 200, { id });
      return true;
    }
  } catch (err) {
    console.error('[alerts] error:', err);
    json(res, 500, { error: 'Internal server error' });
    return true;
  }

  return false;
}
