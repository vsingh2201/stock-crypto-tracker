import "dotenv/config";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { FinnhubClient } from "./finnhubClient";
import { ClientManager } from "./clientManager";
import { runMigrations } from "./db";
import { handleWatchlist } from "./routes/watchlist";
import type { ClientMessage, StatusMessage } from "./types";

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const API_KEY = process.env.FINNHUB_API_KEY;

const ALLOWED_ORIGINS = new Set([
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  ...(process.env.CLIENT_ORIGIN ? [process.env.CLIENT_ORIGIN] : []),
]);

// Single source-of-truth for the HTTP CORS origin header.
// In production CLIENT_ORIGIN is the Vercel URL; locally it falls back to *.
const CORS_ORIGIN = process.env.CLIENT_ORIGIN ?? '*';

if (!API_KEY) {
  console.error("[relay] FINNHUB_API_KEY is not set in server/.env — exiting");
  process.exit(1);
}

// ── Core objects ─────────────────────────────────────────────────────────────

const clientManager = new ClientManager();

const finnhub = new FinnhubClient({
  apiKey: API_KEY,

  // Every Finnhub trade tick → broadcast to the clients watching that symbol.
  onTick: (tick) => clientManager.broadcast(tick),

  // Finnhub connection state → notify all browser clients so they can show
  // the live/reconnecting/disconnected pill in the UI.
  onStatusChange: (status) => {
    console.log(`[relay] finnhub → ${status}`);
    const msg: StatusMessage = { type: "status", status };
    clientManager.broadcastAll(JSON.stringify(msg));
  },
});

// ── HTTP server (needed to inspect the Upgrade request for CORS) ─────────────

const server = http.createServer(async (req, res) => {
  // Set CORS headers on every HTTP response before any routing.
  // res.setHeader values are merged into the final response; they are NOT
  // overridden by later res.writeHead calls unless writeHead repeats the same key.
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-id');

  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');

  // OPTIONS preflight — browsers send this before cross-origin POST/DELETE.
  // Must respond 200 with the CORS headers (already set above) or the real
  // request never fires.
  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (url.pathname === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Watchlist REST API
  const handled = await handleWatchlist(req, res, finnhub);
  if (handled) return;

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Pulse relay — WebSocket endpoint");
});

// ── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server,
  verifyClient: (info: {
    origin: string;
    req: http.IncomingMessage;
    secure: boolean;
  }) => {
    // Browser WebSocket connections include an Origin header. Allow the React
    // dev server and also connections with no origin (curl / test clients).
    const origin = info.origin;
    return !origin || ALLOWED_ORIGINS.has(origin);
  },
});

wss.on("connection", (ws: WebSocket, req) => {
  const ip = req.socket.remoteAddress ?? "unknown";
  clientManager.addClient(ws);
  console.log(
    `[relay] client connected from ${ip} (total: ${clientManager.clientCount})`,
  );

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return; // ignore malformed frames
    }

    const { type, symbol } = msg;
    if (!symbol || typeof symbol !== "string") return;

    if (type === "subscribe") {
      const isFirst = clientManager.subscribe(ws, symbol);
      // Only subscribe upstream when this is the first client wanting this symbol.
      if (isFirst) finnhub.subscribe(symbol);
      console.log(`[relay] subscribe   ${symbol}  isFirst=${isFirst}`);
    } else if (type === "unsubscribe") {
      const isEmpty = clientManager.unsubscribe(ws, symbol);
      // Only unsubscribe upstream when no clients are watching this symbol any more.
      if (isEmpty) finnhub.unsubscribe(symbol);
      console.log(`[relay] unsubscribe ${symbol}  isEmpty=${isEmpty}`);
    }
  });

  ws.on("close", () => {
    // removeClient returns every symbol that now has zero watchers.
    const freed = clientManager.removeClient(ws);
    for (const sym of freed) {
      finnhub.unsubscribe(sym);
      console.log(`[relay] auto-unsubscribe ${sym} (no more watchers)`);
    }
    console.log(
      `[relay] client disconnected from ${ip} (total: ${clientManager.clientCount})`,
    );
  });

  ws.on("error", (err) => {
    console.error(`[relay] client error from ${ip}:`, err.message);
  });
});

// ── Start ────────────────────────────────────────────────────────────────────

runMigrations()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[relay] listening on ws://localhost:${PORT}`);
      finnhub.connect();
    });
  })
  .catch((err) => {
    console.error('[db] failed to connect or migrate:', err);
    process.exit(1);
  });

// ── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown() {
  console.log("[relay] shutting down…");
  finnhub.destroy();
  wss.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
