# Pulse — Real-Time Stock & Crypto Price Tracker

![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-WS_Relay-339933?logo=node.js&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Watchlist_DB-4169E1?logo=postgresql&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5.4-646CFF?logo=vite&logoColor=white)
![Railway](https://img.shields.io/badge/Railway-Deployed-0B0D0E?logo=railway&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-Deployed-000000?logo=vercel&logoColor=white)

---

## Live Demo

**[stock-crypto-tracker-sage.vercel.app](https://stock-crypto-tracker-sage.vercel.app)**

> Markets open Mon–Fri 9:30 am–4:00 pm ET for live data. Outside market hours, a per-symbol mock tick fallback activates automatically — each symbol independently switches to simulated prices and is tagged with an amber "Simulated" indicator.

---

## What is Pulse?

Pulse is a real-time financial dashboard that streams live stock and crypto prices from the [Finnhub](https://finnhub.io) WebSocket API through a Node.js relay server to a React frontend. It supports per-session watchlists backed by PostgreSQL, server-side price alerts with WebSocket push delivery, and a custom SVG candlestick chart — all without a login flow.

This is an original project built to explore full-stack real-time architecture, not a tutorial clone.

---

## Architecture

The central design choice is a **WebSocket relay** — the Node.js server sits between Finnhub and the browser, acting simultaneously as a WebSocket client (upstream) and a WebSocket server (downstream).

```
Finnhub WS API
      ↓  (real-time trade ticks)
Node.js Relay Server  ←→  PostgreSQL
      ↓  (broadcast to subscribers only)
React Clients (Browser)
```

**Why a relay instead of a direct browser → Finnhub connection:**

- The Finnhub API key never touches the browser — it lives only in a Railway environment variable.
- A single upstream Finnhub connection is shared across all connected browser clients. Ten users watching BTC-USD produce one upstream subscription, not ten.
- The relay can tag ticks with `source: 'live' | 'mock'`, apply server-side alert logic, and route notifications to specific sessions — none of which is possible in a purely client-side setup.

**REST alongside WebSockets:** WebSockets handle live price streaming (push, continuous, low latency). REST handles watchlist CRUD and alert management (request/response, persisted state, session-scoped). Each protocol does the job it's suited for.

---

## Features

| Feature                  | Description                                                                             | Tech                                                                |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Live price streaming     | Real trade ticks via Finnhub WebSocket, broadcast only to subscribed clients            | `ws` library, Node.js                                               |
| Watchlist persistence    | Symbols saved per browser session — survive hard refreshes                              | PostgreSQL, REST API                                                |
| Price alerts             | Server-side threshold detection, WebSocket push to owning session on trigger            | `AlertEngine` (in-memory Map), Web Notifications API, Web Audio API |
| Per-symbol mock fallback | After-hours simulation with amber "Simulated" badge; activates independently per symbol | `setInterval`, `source` tagging                                     |
| Session isolation        | Independent watchlists per browser without requiring a login                            | `localStorage` UUID, `pg` `UNIQUE` constraint                       |
| Connection status pill   | Live / Reconnecting / Disconnected indicator with auto-reconnect                        | `ws` event lifecycle                                                |
| Custom candlestick chart | SVG candlestick + volume chart with 1D / 1W / 1M timeframes                             | Custom React component                                              |

---

## Tech Stack

|                         | Client                                                | Server                            |
| ----------------------- | ----------------------------------------------------- | --------------------------------- |
| **Language**            | TypeScript 5.5                                        | TypeScript 6                      |
| **Runtime / Framework** | React 18, Vite 5.4                                    | Node.js                           |
| **WebSocket**           | Browser `WebSocket` API                               | `ws` 8                            |
| **Database**            | —                                                     | PostgreSQL (`pg` 8)               |
| **Chart**               | Custom SVG candlestick (no third-party chart library) | —                                 |
| **Notifications**       | Web Notifications API, Web Audio API                  | —                                 |
| **Dev tooling**         | `vite`, `tsc`                                         | `ts-node`, `nodemon`              |
| **Deployment**          | Vercel                                                | Railway (server + PostgreSQL)     |
| **Data source**         | —                                                     | Finnhub WebSocket API (free tier) |

---

## Project Structure

```
stock-crypto-tracker/
├── client/                   # Vite + React + TypeScript frontend
│   └── src/
│       ├── components/       # Dashboard, Watchlist, AlertModal, AlertList, Chart
│       ├── hooks/            # useMarketFeed.ts — WebSocket + REST + alert state
│       ├── lib/              # marketMath, iconFor utilities
│       ├── data/             # UNIVERSE and SEED_WATCHLIST definitions
│       └── types.ts          # Shared TypeScript types
├── server/                   # Node.js relay server
│   └── src/
│       ├── index.ts          # HTTP + WebSocket server entrypoint
│       ├── finnhubClient.ts  # Upstream WS connection + mock tick fallback
│       ├── clientManager.ts  # Browser client registry (symbol + session maps)
│       ├── alertEngine.ts    # In-memory alert checking — O(1) per tick
│       ├── routes/           # REST endpoints (watchlist, alerts)
│       └── db/               # PostgreSQL pool + SQL migrations
└── docs/
    ├── frontend-explained.md # Component tree, hook design, TypeScript, interview Q&A
    └── backend-explained.md  # Relay pattern, ClientManager, AlertEngine, interview Q&A
```

---

## Key Engineering Decisions

**WebSocket relay over direct browser connection.** Finnhub requires an API key on every WebSocket connection. Connecting directly from the browser would expose that key in network tab. Beyond security, the relay enables server-side fanout: one upstream subscription feeds N browser clients watching the same symbol, and the relay can apply logic (alert checking, source tagging, session routing) that has no equivalent on the client side.

**REST for watchlist and alerts; WebSockets for prices.** WebSockets are push-based and stateless from the application's perspective — they're the right channel for price ticks that arrive continuously whether or not the client asked. Watchlist mutations and alert CRUD are request/response interactions with durable state that need to survive reconnects. Using REST for those keeps them simple, cacheable, and independently testable with `curl`.

**In-memory Map for alert checking.** The server receives price ticks at high frequency across many symbols. Querying PostgreSQL on every tick would saturate the connection pool. `AlertEngine` maintains two Maps — `bySymbol` for O(1) per-tick lookup and `byId` for O(1) REST delete — loaded from the DB on startup. The DB is only written when an alert fires. A server restart re-reads untriggered alerts, so the system is durable without being DB-bound on the hot path.

**Session-based isolation without auth.** A UUID is generated in `localStorage` on first visit and sent with every request (`x-session-id` header for REST, `?sessionId=` for WebSocket upgrades, since browsers can't send custom headers during a WebSocket handshake). This gives independent, persistent watchlists per browser without registration friction. It's a deliberate tradeoff: the session is tied to the browser, not a person. For a production product you'd add auth; for a dashboard focused on real-time architecture, the UUID approach keeps the demo immediately usable.

---

## Local Development

```bash
# Prerequisites: Node.js 18+, PostgreSQL running locally

# 1. Clone
git clone https://github.com/vsingh2201/stock-crypto-tracker
cd stock-crypto-tracker

# 2. Server setup
cd server
cp .env.example .env
# Edit .env — add your Finnhub API key and local DATABASE_URL
npm install
npm run dev

# 3. Client setup (new terminal)
cd client
npm install
npm run dev

# 4. Open http://localhost:5174
```

**Finnhub API key:** Sign up free at [finnhub.io](https://finnhub.io). The free tier allows the symbols used in this project. Without a key the server exits on startup with a clear error message; the app will still run against mock ticks if you bypass that check.

---

## Environment Variables

**`server/.env`**

| Variable          | Description                          | Example                                  |
| ----------------- | ------------------------------------ | ---------------------------------------- |
| `FINNHUB_API_KEY` | Finnhub API key (required)           | `c9abc123xyz`                            |
| `PORT`            | HTTP / WS server port                | `8080`                                   |
| `DATABASE_URL`    | PostgreSQL connection string         | `postgresql://user:pass@host:5432/pulse` |
| `CLIENT_ORIGIN`   | Allowed CORS origin for the frontend | `https://your-app.vercel.app`            |

**`client/.env`**

| Variable       | Description                       | Example                           |
| -------------- | --------------------------------- | --------------------------------- |
| `VITE_WS_URL`  | WebSocket URL of the relay server | `wss://your-server.railway.app`   |
| `VITE_API_URL` | REST base URL of the relay server | `https://your-server.railway.app` |

Both variables default to `localhost:8080` when unset, so no `.env` is needed for local development.

---
