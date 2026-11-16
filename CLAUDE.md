# Project: Live Micro-Betting Platform for University Lectures

## 1. Product & Domain Context
- **Purpose**: A real-time, low-latency in-class betting application where students predict live micro-events occurring during a university lecture (e.g., "Prof reaches Slide 15 by 10:30", "Prof says 'essentially' 5+ times").
- **Target Audience**: Students in lecture halls (high concurrency per room, mobile/laptop screens).
- **Primary Mechanism**: Fast-paced fixed-odds betting. The market creator sets the starting odds; each bet is locked at the odds current when it is placed, and every bet moves the odds for later bettors. Points are minted/burned freely (no conservation), so payouts may exceed stakes.
- **Currency**: Play-money / point balances only (no real currency processing).

## 2. Tech Stack & Architecture Overview
- **Framework**: Next.js 16 (App Router) + React 19 + TypeScript.
- **Styling & UI**: Tailwind CSS (Dark mode).
- **Real-Time Layer**: Standalone Node.js HTTP Server using `socket.io` (running on port 4000).
- **Client State**: Zustand (`useBettingStore`) synchronized with WebSocket events.
- **Utility & Helpers**: `uuid` for client/session generation.

## 3. Data Storage & State Map (Where Stuff Lives)

### A. Real-Time Engine (Node.js In-Memory - `server.js`)
*Primary source of truth during an active lecture session:*
- **Room State**: `Map<roomCode, LectureRoom>` — active lecture rooms mapped by short room code.
- **Markets**: `Map<marketId, Market>` — active and settled micro-markets within a room.
- **Pool Allocations**: `Map<marketId, Map<optionId, number>>` — total real points staked per option (drives the odds).
- **User Ledger**: `Map<userId, number>` — active point balances for connected sockets.

### B. Client-Side State (Zustand Store - `@/store/useBettingStore.ts`)
*Transient local state driven by WebSocket broadcasts:*
- `currentUser`: `{ id, username, balance }`
- `activeRoom`: `{ roomCode, title, hostSocketId }`
- `markets`: List of active/settled markets with their current odds.
- `myBets`: `Record<marketId, PlacedBet[]>` — the current user's individual bets, each with its locked odds.

### C. Persistent Storage (optional snapshot to Postgres)
- The in-memory maps in `server.js` remain the source of truth while running.
- If `DATABASE_URL` is set (production: Neon Postgres), `persistence.js` saves a JSON snapshot of users, markets, pools and bets to a single `engine_state` row (debounced ~2s, plus a final flush on SIGTERM) and restores it on startup, re-arming market timers.
- Without `DATABASE_URL`, nothing is persisted and restarting the server resets the lecture state.

## 4. Key Rules & Calculations
- **Starting odds**: the creator picks a probability `p` for option A (integer 1–99%). It splits a virtual seed of `ODDS_SEED = 500` pts: `seedA = 500·p`, `seedB = 500·(1−p)`.
- **Current odds** (2 decimals, min 1.01):
  `Odds(X) = (ODDS_SEED + total staked) / (seedX + staked on X)`
- **Locking**: a bet gets the odds current just *before* it is added; then its stake updates the pools and thus the odds for everyone after.
- **One side per market**: a user may bet several times but only on one option per market (otherwise betting both sides in sequence is a risk-free profit).
- **Payout Formula** (per winning bet, minted): `floor(Stake * LockedOdds)`, computed in integer hundredths (`betPayout` in `server.js`, `payoutAt` in `lib/format.ts` must match). Losing stakes are gone, even if nobody backed the winner.
- **Market Lifecycle**: `OPEN` -> `LOCKED` (betting disabled) -> `SETTLED` (payouts distributed) or `VOID` (refunds).

## 5. Development Commands
- Start Next.js App: `npm run dev` (Port 3000)
- Start WebSocket Engine: `node server.js` (Port 4000)
- Production (single port, used by the Render deploy in `render.yaml`): `pnpm build && pnpm start` — `app-server.js` serves Next.js and the Socket.io engine together on `$PORT`

## 6. Implementation Notes (verified against the code — read before changing things)
- **No rooms yet**: the spec above mentions `roomCode` / `LectureRoom` / `activeRoom`, but the code has a single global lobby. Every market is broadcast to everyone with `io.emit`; per-user messages go to the Socket.io room `user:<userId>`. The store has no `activeRoom`.
- **Actual engine state** (`server.js`): `users: Map<userId, User>`, `markets: Map<id, MarketRecord>`, `pools: Map<id, Map<"A"|"B", number>>`, `bets: Map<id, Map<userId, PlacedBet[]>>`, `timers: Map<id, Timeout>`. Markets are always binary (options `A`/`B`). Only the 50 most recent resolved markets are kept.
- **Referee model**: the market creator is its Referee — the only one who can settle, can never bet on it, and gets a 5% bounty of the total points staked minted on top of payouts. They also set the starting probability (odds) at creation. They may optionally keep a live event counter (`COUNT_EVENT`, +1 only, OPEN/LOCKED only, referee-only, display-only; `eventCount` is null until first used, and the card hides it from bettors until then).
- **Admin**: enabled only when `ADMIN_PASSWORD` is set. `ADMIN_LOGIN` returns a token `HMAC(ADMIN_PASSWORD, "admin:"+userId)`, which the client keeps in localStorage (`live-betting:admin-token`) and re-sends in `REGISTER_USER`; the server sets `socket.data.isAdmin`. Admin handlers live in `registerAdminHandlers` in `server.js`; `CLOSE_BETTING`/`SETTLE_MARKET` also accept an admin on any market. Admin can't touch SETTLED/VOID markets. Removing a user deletes them from `users` (bets in unresolved markets are dropped from the pools without refund; resolved history stays). An existing user keeps the server's username on `REGISTER_USER` (so admin renames stick); the client syncs its stored name. Admin state isn't persisted, so the snapshot shape (and `SNAPSHOT_VERSION`) is unchanged.
- **Snapshot versions**: `SNAPSHOT_VERSION = 3` (v2 = fixed odds, v3 adds `MarketRecord.eventCount`). A v2 snapshot is upgraded by `migrateV2` (`eventCount: null`). A v1 (parimutuel) snapshot is upgraded on load by `migrateV1`: unresolved markets are voided and refunded, settled history is kept with each old stake shown as one bet at its final parimutuel odds. Bump the version and add a migration whenever the snapshot shape changes.
- **Timers / limits** live in the Config block at the top of `server.js` (`BETTING_CLOSE_FRACTION` = 0.8: a timed market locks at `bettingClosesAt` = 80% of its duration, derived in `bettingClosesAt()` and sent on the wire, while `expiresAt` is the full end; `REFEREE_SETTLE_WINDOW_MS` = 1 hour settle window counted from `expiresAt`, `NO_LIMIT_AUTO_VOID_MS` = 3h cap for no-limit markets, `MIN/MAX_DURATION_SEC`). When you change one, also update the user-facing copy that hard-codes it: `components/CreateMarketModal.tsx`, `HOW_TO_PLAY.md`, `README.md` (and the `restoreTimers` doc comment). Countdowns in `components/MarketCard.tsx` are computed from `settleDeadline`, so they need no change.
- **Wire contract**: all socket event names and payload types are in `lib/types.ts` (`ClientToServerEvents` / `ServerToClientEvents`); `server.js` is `// @ts-check` JS that imports those types via JSDoc. Client emits go through `lib/socket.ts` (5s ack timeout).
- **Verification**: there is no test suite. Run `pnpm install`, then `npx next typegen` (otherwise `tsc` fails on the generated `LayoutProps` type), then `npx tsc --noEmit -p .` and `pnpm lint`. To smoke-test the engine, start `PORT=4123 node server.js` and drive it with `socket.io-client` (`REGISTER_USER` needs both `userId` and `username`; `CREATE_MARKET` accepts `durationSec` ≥ 15 or `null`).
- `AGENTS.md` is (re)written by `next dev`; commit it as-is rather than editing it.
