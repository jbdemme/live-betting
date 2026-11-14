# Lecture Bets — Live Micro-Betting (v1 prototype)

Students bet play-money points on live lecture micro-events using parimutuel pools.
New players: see [How to Play](HOW_TO_PLAY.md). See `CLAUDE.md` for the product and domain spec.

## Run

```bash
pnpm install
```

```bash
node server.js   # Socket.io engine on :4000 (in-memory; restart = reset)
```

```bash
pnpm dev         # Next.js app on :3000
```

Open several browser windows (or private windows) to play as different users.
Set `NEXT_PUBLIC_SOCKET_URL` to point the client at another engine URL, and `CLIENT_ORIGIN`
(comma-separated) on the server to restrict CORS.

### Production (single port)

```bash
pnpm build
```

```bash
pnpm start       # app-server.js: Next.js + Socket.io engine together on $PORT (default 3000)
```

In production the client connects to the engine on the same origin as the page.

## Deploy (Render free tier)

`render.yaml` is a Render Blueprint for one free web service that builds from `main`.

1. Sign in at render.com with GitHub and allow Render access to this repo.
2. **New → Blueprint**, pick this repo, and apply. Render builds and gives you an `onrender.com` URL.
3. Every merge to `main` redeploys automatically.

Free-tier caveat: the service sleeps after ~15 minutes without traffic and takes about a minute
to wake on the next visit.

### Keeping data across deploys (Neon Postgres)

Without a database, a sleep, restart or redeploy resets every balance and market. To keep them:

1. Create a free project at neon.tech and copy its connection string (`postgresql://…`).
2. In Render, open the service → **Environment** → add `DATABASE_URL` with that string → save.

The engine still runs in memory; `persistence.js` writes a snapshot of all users, markets and bets
to one Postgres row (within 2 seconds of any change, and once more on shutdown) and restores it on
startup, including market timers. During a deploy the new instance takes ownership of the row, so the
old one can't overwrite newer data; anything done on the old instance in the few seconds of the
hand-over is dropped (bets are simply not charged). Only the 50 most recently resolved markets are kept.
Locally, set `DATABASE_URL` too (append `?sslmode=disable` for a local Postgres without TLS), or leave
it unset for in-memory only.

## Referee rules

- New users start with **1,000 pts**.
- Whoever **creates** a market is its **Referee**. They can't bet on it, and only they can declare the outcome.
- **Timed markets** (30s–10m): when the timer ends the market **locks**, and the Referee has **60s**
  to declare the winner, or it auto-voids.
- **No-limit markets** (e.g. "Prof says 'essentially' 10+ times in the rest of the lecture"): betting
  stays open until the Referee taps **Close betting**; they then declare the outcome whenever it's known.
  If it isn't settled within **3 hours** of creation, it auto-voids.
- The Referee can settle at any time, which also ends betting immediately.
- **Settle:** each winner gets `wager × (total pool / winning pool)` (rounded down). The Referee gets
  a bounty of **5% of the total pool**, minted on top (it doesn't reduce winners' payouts).
  If nobody backed the winning option, the market is voided instead.
- **Void:** every wager is refunded in full.

## Layout

| Path | Purpose |
| --- | --- |
| `server.js` | Socket.io engine: users, markets, pools, bets, timers |
| `lib/types.ts` | Shared wire types and typed Socket.io event maps |
| `lib/socket.ts` | Socket singleton + client actions (create, bet, close betting, settle) |
| `hooks/useSocket.ts` | Connection lifecycle; mirrors server broadcasts into the store |
| `store/useBettingStore.ts` | Zustand store: user, markets with live odds, my bets |
| `components/` | `Navbar`, `MarketCard`, `CreateMarketModal`, `Leaderboard`, `Toasts` |
| `app/page.tsx` | Join screen + feed of live and recently resolved markets |

## Socket events

Client → server (all acknowledged with `{ ok, data } | { ok: false, error }`):
`REGISTER_USER`, `CREATE_MARKET`, `PLACE_BET`, `CLOSE_BETTING`, `SETTLE_MARKET`.

Server → client: `MARKET_CREATED`, `MARKET_UPDATED`, `ODDS_UPDATE` (on every bet),
`MARKET_SETTLED`, `MARKET_VOIDED`, `BALANCE_UPDATE`, `PAYOUT`, `LEADERBOARD_UPDATE`
(debounced; all users ranked by balance + points in open bets).
