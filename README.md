# Lecture Bets — Live Micro-Betting (v1 prototype)

Students bet play-money points on live lecture micro-events using parimutuel pools.
See `CLAUDE.md` for the product and domain spec.

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

## Neutral Referee rules

- New users start with **1,000 pts**.
- Each market has at most one **Referee**, who alone may settle it. You can claim Referee only
  while betting is open and only if you have **no bets** on that market. A Referee can't bet on it.
- When the betting timer ends the market **locks**. With no Referee it **auto-voids**; otherwise the
  Referee has **60s** to declare the winner, or it auto-voids.
- **Settle:** each winner gets `wager × (total pool / winning pool)` (rounded down). The Referee gets
  a bounty of **5% of the total pool**, minted on top (it doesn't reduce winners' payouts).
  If nobody backed the winning option, the market is voided instead.
- **Void:** every wager is refunded in full.

## Layout

| Path | Purpose |
| --- | --- |
| `server.js` | Socket.io engine: users, markets, pools, bets, timers |
| `lib/types.ts` | Shared wire types and typed Socket.io event maps |
| `lib/socket.ts` | Socket singleton + client actions (create, bet, claim, settle) |
| `hooks/useSocket.ts` | Connection lifecycle; mirrors server broadcasts into the store |
| `store/useBettingStore.ts` | Zustand store: user, markets with live odds, my bets |
| `components/` | `Navbar`, `MarketCard`, `CreateMarketModal`, `Toasts` |
| `app/page.tsx` | Join screen + feed of live and recently resolved markets |

## Socket events

Client → server (all acknowledged with `{ ok, data } | { ok: false, error }`):
`REGISTER_USER`, `CREATE_MARKET`, `PLACE_BET`, `CLAIM_REFEREE`, `SETTLE_MARKET`.

Server → client: `MARKET_CREATED`, `MARKET_UPDATED`, `ODDS_UPDATE` (on every bet),
`MARKET_SETTLED`, `MARKET_VOIDED`, `BALANCE_UPDATE`, `PAYOUT`.
