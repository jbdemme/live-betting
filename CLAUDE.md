# Project: Live Micro-Betting Platform for University Lectures

## 1. Product & Domain Context
- **Purpose**: A real-time, low-latency in-class betting application where students predict live micro-events occurring during a university lecture (e.g., "Prof reaches Slide 15 by 10:30", "Prof says 'essentially' 5+ times").
- **Target Audience**: Students in lecture halls (high concurrency per room, mobile/laptop screens).
- **Primary Mechanism**: Fast-paced Parimutuel pool betting (no fixed house odds; odds auto-adjust based on student consensus and total point pools).
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
- **Pool Allocations**: `Map<marketId, Map<optionId, number>>` — total wager points per option.
- **User Ledger**: `Map<userId, number>` — active point balances for connected sockets.

### B. Client-Side State (Zustand Store - `@/store/useBettingStore.ts`)
*Transient local state driven by WebSocket broadcasts:*
- `currentUser`: `{ id, username, balance }`
- `activeRoom`: `{ roomCode, title, hostSocketId }`
- `markets`: List of active/settled markets with calculated live parimutuel odds.
- `myBets`: Map of current user's active stakes per market option.

### C. Persistent Storage (optional snapshot to Postgres)
- The in-memory maps in `server.js` remain the source of truth while running.
- If `DATABASE_URL` is set (production: Neon Postgres), `persistence.js` saves a JSON snapshot of users, markets, pools and bets to a single `engine_state` row (debounced ~2s, plus a final flush on SIGTERM) and restores it on startup, re-arming market timers.
- Without `DATABASE_URL`, nothing is persisted and restarting the server resets the lecture state.

## 4. Key Rules & Calculations
- **Parimutuel Odds Formula**:
  `Implied Odds (Option A) = Total Market Pool / Option A Pool`
- **Payout Formula**:
  `User Payout = User Wager * (Total Market Pool / Winning Option Pool)`
- **Market Lifecycle**: `OPEN` -> `LOCKED` (betting disabled) -> `SETTLED` (payouts distributed) or `VOID` (refunds).

## 5. Development Commands
- Start Next.js App: `npm run dev` (Port 3000)
- Start WebSocket Engine: `node server.js` (Port 4000)
- Production (single port, used by the Render deploy in `render.yaml`): `pnpm build && pnpm start` — `app-server.js` serves Next.js and the Socket.io engine together on `$PORT`

## 6. Implementation Notes (verified against the code — read before changing things)
- **No rooms yet**: the spec above mentions `roomCode` / `LectureRoom` / `activeRoom`, but the code has a single global lobby. Every market is broadcast to everyone with `io.emit`; per-user messages go to the Socket.io room `user:<userId>`. The store has no `activeRoom`.
- **Actual engine state** (`server.js`): `users: Map<userId, User>`, `markets: Map<id, MarketRecord>`, `pools: Map<id, Map<"A"|"B", number>>`, `bets: Map<id, Map<userId, Stake>>`, `timers: Map<id, Timeout>`. Markets are always binary (options `A`/`B`). Only the 50 most recent resolved markets are kept.
- **Referee model**: the market creator is its Referee — the only one who can settle, can never bet on it, and gets a 5% bounty of the total pool minted on top of payouts. If nobody backed the winning option, settling voids (refunds) instead.
- **Timers / limits** live in the Config block at the top of `server.js` (`REFEREE_SETTLE_WINDOW_MS` = 1 hour settle window after a timed market locks, `NO_LIMIT_AUTO_VOID_MS` = 3h cap for no-limit markets, `MIN/MAX_DURATION_SEC`). When you change one, also update the user-facing copy that hard-codes it: `components/CreateMarketModal.tsx`, `HOW_TO_PLAY.md`, `README.md` (and the `restoreTimers` doc comment). Countdowns in `components/MarketCard.tsx` are computed from `settleDeadline`, so they need no change.
- **Wire contract**: all socket event names and payload types are in `lib/types.ts` (`ClientToServerEvents` / `ServerToClientEvents`); `server.js` is `// @ts-check` JS that imports those types via JSDoc. Client emits go through `lib/socket.ts` (5s ack timeout).
- **Verification**: there is no test suite. Run `pnpm install`, then `npx next typegen` (otherwise `tsc` fails on the generated `LayoutProps` type), then `npx tsc --noEmit -p .` and `pnpm lint`. To smoke-test the engine, start `PORT=4123 node server.js` and drive it with `socket.io-client` (`REGISTER_USER` needs both `userId` and `username`; `CREATE_MARKET` accepts `durationSec` ≥ 15 or `null`).
- `AGENTS.md` is (re)written by `next dev`; commit it as-is rather than editing it.
