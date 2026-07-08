import http from 'http';
import { pool } from '../db';
import type { FinnhubClient } from '../finnhubClient';

const SEED_SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'NVDA', 'AAPL', 'TSLA', 'SPY'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'x-session-id, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handles /api/watchlist routes. Returns true if the request was handled.
 * Pass finnhub to manage upstream subscriptions when DB entries change.
 */
export async function handleWatchlist(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  finnhub: FinnhubClient,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;
  const method = req.method ?? 'GET';

  // CORS preflight
  if (method === 'OPTIONS' && pathname.startsWith('/api/watchlist')) {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }

  if (!pathname.startsWith('/api/watchlist')) return false;

  const sessionId = req.headers['x-session-id'];
  if (!sessionId || typeof sessionId !== 'string') {
    json(res, 400, { error: 'Missing x-session-id header' });
    return true;
  }

  try {
    // GET /api/watchlist
    if (pathname === '/api/watchlist' && method === 'GET') {
      const result = await pool.query<{ symbol: string }>(
        'SELECT symbol FROM watchlists WHERE session_id = $1 ORDER BY added_at',
        [sessionId],
      );
      const symbols = result.rows.map((r) => r.symbol);
      json(res, 200, { symbols: symbols.length > 0 ? symbols : SEED_SYMBOLS });
      return true;
    }

    // POST /api/watchlist
    if (pathname === '/api/watchlist' && method === 'POST') {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return true;
      }

      const symbol = (body as Record<string, unknown>)?.symbol;
      if (!symbol || typeof symbol !== 'string') {
        json(res, 400, { error: 'Missing symbol' });
        return true;
      }

      try {
        await pool.query(
          'INSERT INTO watchlists (session_id, symbol) VALUES ($1, $2)',
          [sessionId, symbol],
        );
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          json(res, 409, { error: 'Symbol already in watchlist' });
          return true;
        }
        throw err;
      }

      // Subscribe on Finnhub — idempotent if already subscribed by another session.
      finnhub.subscribe(symbol);
      json(res, 201, { symbol });
      return true;
    }

    // DELETE /api/watchlist/:symbol
    const deleteMatch = pathname.match(/^\/api\/watchlist\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      const symbol = decodeURIComponent(deleteMatch[1]);
      const result = await pool.query(
        'DELETE FROM watchlists WHERE session_id = $1 AND symbol = $2',
        [sessionId, symbol],
      );

      if ((result.rowCount ?? 0) === 0) {
        json(res, 404, { error: 'Symbol not found in watchlist' });
        return true;
      }

      // Unsubscribe from Finnhub only if no other session is still watching.
      const others = await pool.query<{ symbol: string }>(
        'SELECT 1 FROM watchlists WHERE symbol = $1 LIMIT 1',
        [symbol],
      );
      if ((others.rowCount ?? 0) === 0) {
        finnhub.unsubscribe(symbol);
      }

      json(res, 200, { symbol });
      return true;
    }
  } catch (err) {
    console.error('[watchlist] error:', err);
    json(res, 500, { error: 'Internal server error' });
    return true;
  }

  return false;
}
