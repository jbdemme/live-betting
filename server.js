// @ts-check
/**
 * Real-time betting engine for live lecture micro-markets.
 *
 * Runs standalone (`node server.js`, port 4000) for local dev, or inside the combined
 * production server (`app-server.js`) that also serves the Next.js app on one port.
 * All state is in-memory: restarting the process resets every market and balance.
 *
 * Referee rules:
 *  - The user who creates a market is its Referee and the only one who may settle it.
 *  - The Referee may never bet on their own market.
 *  - Timed markets: when betting closes the market LOCKS, and the Referee has
 *    REFEREE_SETTLE_WINDOW_MS to declare the outcome, or the market auto-VOIDs.
 *  - No-time-limit markets: betting stays OPEN until the Referee closes it (LOCKED) or settles.
 *    If unsettled NO_LIMIT_AUTO_VOID_MS after creation, the market auto-VOIDs.
 *  - The Referee may settle at any time while OPEN or LOCKED.
 *  - Settling pays each winning bet `floor(amount * lockedOdds)` and mints a 5% bounty
 *    (of the total points staked) for the Referee on top. Losing stakes are gone.
 *  - VOID refunds every wager in full.
 *
 * Admin (only if the ADMIN_PASSWORD env var is set): ADMIN_LOGIN with the password returns a
 * token (HMAC of the user id) that the client re-sends on REGISTER_USER. An admin may adjust
 * balances, rename/remove users, void markets or single bets, and close/settle any market.
 * Settled markets are final, even for an admin.
 *
 * Pricing (fixed odds, locked per bet):
 *  - The creator sets a starting probability for option A (1–99%). It splits a virtual
 *    seed of ODDS_SEED points: seedA = ODDS_SEED * p, seedB = ODDS_SEED * (1 - p).
 *  - Current odds: odds(X) = (ODDS_SEED + total staked) / (seedX + staked on X), 2 decimals.
 *  - A bet is locked at the odds current just before it is placed; its own stake then
 *    moves the odds for later bettors. Payouts are minted, so they may exceed the stakes.
 *  - A user may back only one option per market (prevents a risk-free two-sided hedge).
 *
 * Handlers run synchronously (no awaits between validation and mutation), so every
 * state transition is atomic with respect to other socket events.
 *
 * Persistence: with DATABASE_URL set, the whole state is snapshotted to Postgres
 * (debounced, plus a final flush on shutdown) and restored on startup — see persistence.js.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const persistence = require("./persistence");

/** @typedef {import("./lib/types").OptionId} OptionId */
/** @typedef {import("./lib/types").MarketStatus} MarketStatus */
/** @typedef {import("./lib/types").User} User */
/** @typedef {import("./lib/types").Market} Market */
/** @typedef {import("./lib/types").MarketOption} MarketOption */
/** @typedef {import("./lib/types").PlacedBet} PlacedBet */
/** @typedef {import("./lib/types").MyBets} MyBets */
/** @typedef {import("./lib/types").OddsMap} OddsMap */
/** @typedef {import("./lib/types").PoolMap} PoolMap */
/** @typedef {import("./lib/types").PayoutNotice} PayoutNotice */
/** @typedef {import("./lib/types").LeaderboardEntry} LeaderboardEntry */
/** @typedef {import("./lib/types").ClientToServerEvents} ClientToServerEvents */
/** @typedef {import("./lib/types").ServerToClientEvents} ServerToClientEvents */
/** @typedef {import("./lib/types").AdminMarketBets} AdminMarketBets */
/** @typedef {{ userId?: string, isAdmin?: boolean, failedAdminLogins?: number }} SocketData */
/** @typedef {import("socket.io").Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>} AppSocket */

/**
 * Market record as stored in memory (pools live in their own map).
 * @typedef {Object} MarketRecord
 * @property {string} id
 * @property {string} title
 * @property {[MarketOption, MarketOption]} options
 * @property {MarketStatus} status
 * @property {string} creatorId
 * @property {number} createdAt
 * @property {number | null} expiresAt
 * @property {number | null} settleDeadline
 * @property {OptionId | null} winningOption
 * @property {number | null} refereeBounty
 * @property {string | null} voidReason
 * @property {number | null} resolvedAt
 * @property {number} initialProbA  Creator's starting probability for option A, percent 1–99.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "*";
const STARTING_BALANCE = 1000;
const REFEREE_BOUNTY_RATE = 0.05;
/** Virtual points split by the starting probability; larger = odds move less per bet. */
const ODDS_SEED = 500;
const MIN_PROB_A = 1;
const MAX_PROB_A = 99;
/** Odds never drop below this, so a winning bet always returns something on top. */
const MIN_ODDS = 1.01;
/** Timed markets: how long the Referee has to settle after betting closes before it auto-voids. */
const REFEREE_SETTLE_WINDOW_MS = 60 * 60 * 1000;
/** No-time-limit markets refund everyone if still unsettled this long after creation. */
const NO_LIMIT_AUTO_VOID_MS = 3 * 60 * 60 * 1000;
/** Debounce for writing snapshots to the database. */
const SAVE_DEBOUNCE_MS = 2000;
/** Only the most recent resolved markets are kept (in memory and in the snapshot). */
const MAX_RESOLVED_KEPT = 50;
/** v1: parimutuel pools + per-user stakes. v2: fixed odds locked per bet. */
const SNAPSHOT_VERSION = 2;
const MIN_DURATION_SEC = 15;
const MAX_DURATION_SEC = 60 * 60;
const MAX_TITLE_LEN = 120;
const MAX_OPTION_LEN = 32;
const MAX_USERNAME_LEN = 24;
/** @type {readonly OptionId[]} */
const OPTION_IDS = ["A", "B"];
/** Unlocks admin rights; admin is disabled when unset. */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
/** Wrong passwords allowed per connection before ADMIN_LOGIN stops answering. */
const MAX_ADMIN_LOGIN_FAILURES = 5;
const MAX_ADMIN_REASON_LEN = 80;
/** Largest single balance adjustment. */
const MAX_ADMIN_DELTA = 1_000_000;

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** User ledger. @type {Map<string, User>} */
const users = new Map();
/** @type {Map<string, MarketRecord>} */
const markets = new Map();
/** Pool allocations: total wagered points per option. @type {Map<string, Map<OptionId, number>>} */
const pools = new Map();
/** Per-market bets: marketId -> userId -> that user's bets (one option each). @type {Map<string, Map<string, PlacedBet[]>>} */
const bets = new Map();
/** Pending lock / referee-timeout timers. @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {string} userId */
const userRoom = (userId) => `user:${userId}`;

/** Admin token for a user: only someone who knows ADMIN_PASSWORD can produce it. @param {string} userId */
const adminToken = (userId) => crypto.createHmac("sha256", ADMIN_PASSWORD).update(`admin:${userId}`).digest("hex");

/** Constant-time string comparison (via hashes, so lengths need not match). @param {string} a @param {string} b */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** @param {string} userId @param {unknown} token */
const isValidAdminToken = (userId, token) =>
  ADMIN_PASSWORD !== "" && typeof token === "string" && safeEqual(token, adminToken(userId));

/**
 * @param {unknown} value
 * @param {number} maxLen
 * @returns {string | null}
 */
function cleanString(value, maxLen) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  return trimmed;
}

/** @param {unknown} value @returns {value is OptionId} */
const isOptionId = (value) => value === "A" || value === "B";

/** @param {string} marketId @returns {PoolMap} */
function getPools(marketId) {
  const pool = pools.get(marketId);
  return { A: pool?.get("A") ?? 0, B: pool?.get("B") ?? 0 };
}

/**
 * Current fixed odds: (seed + total staked) / (option seed + option staked), 2 decimals.
 * @param {MarketRecord} m @param {PoolMap} p @returns {OddsMap}
 */
function computeOdds(m, p) {
  const seedA = (ODDS_SEED * m.initialProbA) / 100;
  const seed = { A: seedA, B: ODDS_SEED - seedA };
  const total = ODDS_SEED + p.A + p.B;
  /** @param {OptionId} o */
  const odds = (o) => Math.max(MIN_ODDS, Math.round((total / (seed[o] + p[o])) * 100) / 100);
  return { A: odds("A"), B: odds("B") };
}

/** Payout of a winning bet; integer math on hundredths avoids float drift (1.15 * 100). @param {PlacedBet} bet */
const betPayout = (bet) => Math.floor((bet.amount * Math.round(bet.odds * 100)) / 100);

/** @param {PlacedBet[]} list */
const sumAmounts = (list) => list.reduce((sum, b) => sum + b.amount, 0);

/** @param {string} marketId */
function bettorCount(marketId) {
  return bets.get(marketId)?.size ?? 0;
}

/** @param {MarketRecord} m @returns {Market} */
function serializeMarket(m) {
  const p = getPools(m.id);
  return {
    id: m.id,
    title: m.title,
    options: m.options,
    status: m.status,
    creatorId: m.creatorId,
    creatorName: users.get(m.creatorId)?.username ?? "unknown",
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
    settleDeadline: m.settleDeadline,
    initialProbA: m.initialProbA,
    pools: p,
    totalPool: p.A + p.B,
    odds: computeOdds(m, p),
    bettorCount: bettorCount(m.id),
    winningOption: m.winningOption,
    refereeBounty: m.refereeBounty,
    voidReason: m.voidReason,
    resolvedAt: m.resolvedAt,
  };
}

/** @param {string} userId @returns {MyBets} */
function myBetsFor(userId) {
  /** @type {MyBets} */
  const result = {};
  for (const [marketId, byUser] of bets) {
    const list = byUser.get(userId);
    if (list) result[marketId] = list.map((b) => ({ ...b }));
  }
  return result;
}

/** @param {string} marketId */
function clearTimer(marketId) {
  const t = timers.get(marketId);
  if (t) clearTimeout(t);
  timers.delete(marketId);
}

/** @param {string} marketId @param {number} delayMs @param {() => void} fn */
function scheduleTimer(marketId, delayMs, fn) {
  clearTimer(marketId);
  timers.set(
    marketId,
    setTimeout(() => {
      timers.delete(marketId);
      fn();
    }, Math.max(0, delayMs)),
  );
}

/** @param {string} userId @param {number} delta */
function creditUser(userId, delta) {
  const user = users.get(userId);
  if (!user) return;
  user.balance += delta;
  io.to(userRoom(userId)).emit("BALANCE_UPDATE", { balance: user.balance });
}

/** All users ranked by balance + points at stake in unresolved markets. @returns {LeaderboardEntry[]} */
function buildLeaderboard() {
  /** @type {Map<string, number>} */
  const atStake = new Map();
  for (const [marketId, byUser] of bets) {
    const status = markets.get(marketId)?.status;
    if (status !== "OPEN" && status !== "LOCKED") continue;
    for (const [userId, list] of byUser) {
      atStake.set(userId, (atStake.get(userId) ?? 0) + sumAmounts(list));
    }
  }
  return [...users.values()]
    .map((u) => {
      const staked = atStake.get(u.id) ?? 0;
      return {
        userId: u.id,
        username: u.username,
        balance: u.balance,
        atStake: staked,
        total: u.balance + staked,
        online: (io.sockets.adapter.rooms.get(userRoom(u.id))?.size ?? 0) > 0,
      };
    })
    .sort((a, b) => b.total - a.total || a.username.localeCompare(b.username));
}

/** Coalesces bursts of changes (e.g. a settlement paying many users) into one broadcast. */
let leaderboardTimer = /** @type {NodeJS.Timeout | null} */ (null);
function scheduleLeaderboard() {
  if (leaderboardTimer) return;
  leaderboardTimer = setTimeout(() => {
    leaderboardTimer = null;
    io.emit("LEADERBOARD_UPDATE", buildLeaderboard());
  }, 250);
}

/** @param {string} userId @param {PayoutNotice} notice */
function notify(userId, notice) {
  io.to(userRoom(userId)).emit("PAYOUT", notice);
}

/** Broadcast a market's current pools and odds. @param {MarketRecord} m */
function emitOdds(m) {
  const p = getPools(m.id);
  io.emit("ODDS_UPDATE", {
    marketId: m.id,
    pools: p,
    totalPool: p.A + p.B,
    odds: computeOdds(m, p),
    bettorCount: bettorCount(m.id),
  });
}

/** Remove bets from a market's pools (when a bet is cancelled). @param {string} marketId @param {PlacedBet[]} list */
function unstake(marketId, list) {
  const pool = pools.get(marketId);
  if (!pool) return;
  for (const b of list) pool.set(b.optionId, Math.max(0, (pool.get(b.optionId) ?? 0) - b.amount));
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

/**
 * VOID: refund every wager in full.
 * @param {string} marketId
 * @param {string} reason
 */
function voidMarket(marketId, reason) {
  const m = markets.get(marketId);
  if (!m || m.status === "SETTLED" || m.status === "VOID") return;
  clearTimer(marketId);

  m.status = "VOID";
  m.voidReason = reason;
  m.resolvedAt = Date.now();

  for (const [userId, list] of bets.get(marketId) ?? []) {
    const refund = sumAmounts(list);
    if (refund > 0) {
      creditUser(userId, refund);
      notify(userId, { marketId, title: m.title, kind: "REFUND", amount: refund });
    }
  }

  io.emit("MARKET_VOIDED", serializeMarket(m));
  scheduleLeaderboard();
  pruneResolved();
  markDirty();
  console.log(`[void] ${marketId} "${m.title}" — ${reason}`);
}

/** Timed betting window closed: lock and start the Referee's settle window. @param {string} marketId */
function lockMarket(marketId) {
  const m = markets.get(marketId);
  if (!m || m.status !== "OPEN") return;

  m.status = "LOCKED";
  m.settleDeadline = Date.now() + REFEREE_SETTLE_WINDOW_MS;
  io.emit("MARKET_UPDATED", serializeMarket(m));
  scheduleSettleDeadline(m);
  markDirty();
}

/** Auto-void the market at its settleDeadline (ruling window or no-limit cap). @param {MarketRecord} m */
function scheduleSettleDeadline(m) {
  if (m.settleDeadline === null) return;
  const reason =
    m.expiresAt === null
      ? `Not settled within ${NO_LIMIT_AUTO_VOID_MS / 3_600_000} hours`
      : `Referee did not settle within ${REFEREE_SETTLE_WINDOW_MS / 60_000} minutes`;
  scheduleTimer(m.id, m.settleDeadline - Date.now(), () => voidMarket(m.id, reason));
}

/**
 * SETTLE: pay each winning bet `floor(amount * lockedOdds)` (minted, so payouts may exceed
 * the stakes), and mint a 5% bounty of the total staked for the Referee (creator).
 * Losing stakes are simply gone, even when nobody backed the winner.
 * @param {MarketRecord} m
 * @param {OptionId} winningOption
 */
function settleMarket(m, winningOption) {
  const p = getPools(m.id);
  const totalPool = p.A + p.B;

  clearTimer(m.id);
  m.status = "SETTLED";
  m.winningOption = winningOption;
  m.resolvedAt = Date.now();

  let paidOut = 0;
  for (const [userId, list] of bets.get(m.id) ?? []) {
    const winners = list.filter((b) => b.optionId === winningOption);
    if (winners.length > 0) {
      const payout = winners.reduce((sum, b) => sum + betPayout(b), 0);
      paidOut += payout;
      creditUser(userId, payout);
      notify(userId, { marketId: m.id, title: m.title, kind: "WIN", amount: payout });
    } else {
      notify(userId, { marketId: m.id, title: m.title, kind: "LOSS", amount: sumAmounts(list) });
    }
  }

  const bounty = Math.round(totalPool * REFEREE_BOUNTY_RATE);
  m.refereeBounty = bounty;
  if (bounty > 0) {
    creditUser(m.creatorId, bounty);
    notify(m.creatorId, { marketId: m.id, title: m.title, kind: "BOUNTY", amount: bounty });
  }

  io.emit("MARKET_SETTLED", serializeMarket(m));
  scheduleLeaderboard();
  pruneResolved();
  markDirty();
  console.log(`[settle] ${m.id} "${m.title}" → ${winningOption}, staked ${totalPool}, paid ${paidOut}, bounty ${bounty}`);
}

// ---------------------------------------------------------------------------
// Persistence (snapshot / restore)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Snapshot
 * @property {number} version
 * @property {number} savedAt
 * @property {User[]} users
 * @property {MarketRecord[]} markets
 * @property {[string, PoolMap][]} pools
 * @property {[string, [string, PlacedBet[]][]][]} bets
 */

/**
 * Snapshot written by the old parimutuel engine: one {A, B} stake per user and market.
 * @typedef {Object} SnapshotV1
 * @property {1} version
 * @property {User[]} users
 * @property {Omit<MarketRecord, "initialProbA">[]} markets
 * @property {[string, PoolMap][]} pools
 * @property {[string, [string, PoolMap][]][]} bets
 */

/** @returns {Snapshot} */
function snapshot() {
  return {
    version: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    users: [...users.values()],
    markets: [...markets.values()],
    pools: [...markets.keys()].map((id) => [id, getPools(id)]),
    bets: [...bets].map(([id, byUser]) => [id, [...byUser]]),
  };
}

/** Replace in-memory state with a stored snapshot. @param {Snapshot} snap */
function restore(snap) {
  users.clear();
  markets.clear();
  pools.clear();
  bets.clear();
  for (const u of snap.users) users.set(u.id, { ...u });
  for (const m of snap.markets) markets.set(m.id, { ...m });
  for (const [id, p] of snap.pools) pools.set(id, new Map(OPTION_IDS.map((o) => [o, p[o] ?? 0])));
  for (const [id, byUser] of snap.bets) {
    bets.set(id, new Map(byUser.map(([uid, list]) => [uid, list.map((b) => ({ ...b }))])));
  }
}

/**
 * Upgrade a v1 (parimutuel) snapshot. Settled/voided history is kept, with each old stake
 * shown as one bet at its final parimutuel odds; markets still OPEN or LOCKED are voided
 * and refunded by the caller, since their stakes have no locked-in odds.
 * @param {SnapshotV1} snap @returns {{ snap: Snapshot, unresolved: string[] }}
 */
function migrateV1(snap) {
  /** @type {Map<string, PoolMap>} */
  const poolById = new Map(snap.pools);
  const createdAt = new Map(snap.markets.map((m) => [m.id, m.createdAt]));
  return {
    snap: {
      version: SNAPSHOT_VERSION,
      savedAt: Date.now(),
      users: snap.users,
      markets: snap.markets.map((m) => ({ ...m, initialProbA: 50 })),
      pools: snap.pools,
      bets: snap.bets.map(([id, byUser]) => {
        const p = poolById.get(id) ?? { A: 0, B: 0 };
        const total = p.A + p.B;
        return [
          id,
          byUser.map(([uid, stake]) => [
            uid,
            OPTION_IDS.filter((o) => stake[o] > 0).map((o) => ({
              id: uuidv4(),
              optionId: o,
              amount: stake[o],
              odds: p[o] > 0 ? Math.floor((total / p[o]) * 100) / 100 : MIN_ODDS,
              placedAt: createdAt.get(id) ?? 0,
            })),
          ]),
        ];
      }),
    },
    unresolved: snap.markets.filter((m) => m.status === "OPEN" || m.status === "LOCKED").map((m) => m.id),
  };
}

/**
 * Re-arm timers for unresolved markets after a restart. Downtime never eats a timed
 * market's 1h ruling window (an expired window restarts); the no-limit 3h cap is absolute.
 */
function restoreTimers() {
  const now = Date.now();
  for (const m of markets.values()) {
    if (m.status === "OPEN" && m.expiresAt !== null) {
      // Overdue markets lock right away (with a fresh ruling window).
      scheduleTimer(m.id, m.expiresAt - now, () => lockMarket(m.id));
    } else if (m.status === "LOCKED" && m.expiresAt !== null) {
      if (m.settleDeadline === null || m.settleDeadline < now) m.settleDeadline = now + REFEREE_SETTLE_WINDOW_MS;
      scheduleSettleDeadline(m);
    } else if (m.status === "OPEN" || m.status === "LOCKED") {
      scheduleSettleDeadline(m); // no-limit market: overdue ones void right away
    }
  }
}

/** Drop all but the MAX_RESOLVED_KEPT most recently resolved markets. */
function pruneResolved() {
  const resolved = [...markets.values()]
    .filter((m) => m.status === "SETTLED" || m.status === "VOID")
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  for (const m of resolved.slice(MAX_RESOLVED_KEPT)) {
    markets.delete(m.id);
    pools.delete(m.id);
    bets.delete(m.id);
  }
}

let dirty = false;
let saveTimer = /** @type {NodeJS.Timeout | null} */ (null);
let savePromise = /** @type {Promise<unknown> | null} */ (null);

/** Note that state changed; a snapshot is written within SAVE_DEBOUNCE_MS. */
function markDirty() {
  if (!persistence.enabled()) return;
  dirty = true;
  if (!saveTimer) saveTimer = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
}

/** Write the current state now (waits for any save already in flight). */
async function flush() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  while (savePromise) await savePromise;
  if (!dirty) return;
  dirty = false;
  savePromise = persistence
    .save(snapshot())
    .catch((/** @type {unknown} */ err) => {
      console.error("[persist] save failed, will retry:", err);
      markDirty();
    })
    .finally(() => {
      savePromise = null;
    });
  await savePromise;
}

/**
 * Load the stored snapshot (if persistence is enabled) and re-arm market timers.
 * Call after `attachEngine` and before the HTTP server starts listening.
 */
async function loadState() {
  if (!persistence.enabled()) {
    console.log("[persist] DATABASE_URL not set: state is in-memory only");
    return;
  }
  const snap = /** @type {Snapshot | SnapshotV1 | null} */ (await persistence.claimAndLoad());
  if (snap && snap.version === SNAPSHOT_VERSION) {
    restore(/** @type {Snapshot} */ (snap));
    console.log(`[persist] restored ${users.size} users and ${markets.size} markets`);
  } else if (snap && snap.version === 1) {
    const { snap: upgraded, unresolved } = migrateV1(/** @type {SnapshotV1} */ (snap));
    restore(upgraded);
    for (const id of unresolved) voidMarket(id, "Pricing system upgraded to fixed odds");
    console.log(`[persist] upgraded v1 state: ${users.size} users, ${markets.size} markets, ${unresolved.length} voided`);
  } else {
    console.log("[persist] no saved state yet: starting fresh");
  }
  restoreTimers();
  markDirty(); // persist any deadlines re-armed above
}

/**
 * On SIGTERM/SIGINT (Render sends SIGTERM on deploys and spin-down): stop accepting
 * connections, write a final snapshot, then exit.
 * @param {http.Server} httpServer
 */
function installShutdownHooks(httpServer) {
  let shuttingDown = false;
  const shutdown = async (/** @type {string} */ signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[engine] ${signal}: saving state and shutting down`);
    httpServer.close();
    for (const t of timers.values()) clearTimeout(t);
    try {
      await flush();
      await persistence.close();
    } catch (err) {
      console.error("[persist] final save failed:", err);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** @typedef {import("socket.io").Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>} AppServer */

/** Set by `attachEngine`; every broadcast goes through it. @type {AppServer} */
let io;

/**
 * Serves `GET /health`. Returns true if it handled the request.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function handleHealth(req, res) {
  if (req.url !== "/health") return false;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, users: users.size, markets: markets.size }));
  return true;
}

/**
 * Wire the betting engine onto a Socket.io server. Used both by the standalone
 * engine below (`node server.js`) and by the combined production server (`app-server.js`).
 * @param {AppServer} server
 */
function attachEngine(server) {
  io = server;
  io.on("connection", onConnection);
}

/** @param {AppSocket} socket */
function onConnection(socket) {
  /** @returns {User | null} */
  const currentUser = () => {
    const id = socket.data.userId;
    return id ? (users.get(id) ?? null) : null;
  };

  // A user going offline changes their leaderboard status.
  socket.on("disconnect", () => {
    if (socket.data.userId) scheduleLeaderboard();
  });

  socket.on("REGISTER_USER", (payload, ack) => {
    const userId = cleanString(payload?.userId, 64);
    const username = cleanString(payload?.username, MAX_USERNAME_LEN);
    if (!userId || !username) return ack({ ok: false, error: "Invalid user id or username" });

    // An existing user keeps the server's name, so an admin rename sticks.
    let user = users.get(userId);
    if (!user) {
      user = { id: userId, username, balance: STARTING_BALANCE };
      users.set(userId, user);
      console.log(`[register] ${username} (${userId})`);
    }

    socket.data.userId = userId;
    socket.data.isAdmin = isValidAdminToken(userId, payload?.adminToken);
    socket.join(userRoom(userId));

    ack({
      ok: true,
      data: {
        user: { ...user },
        markets: [...markets.values()].map(serializeMarket),
        myBets: myBetsFor(userId),
        leaderboard: buildLeaderboard(),
        serverNow: Date.now(),
        isAdmin: socket.data.isAdmin,
      },
    });
    scheduleLeaderboard();
    markDirty();
  });

  socket.on("CREATE_MARKET", (payload, ack) => {
    const user = currentUser();
    if (!user) return ack({ ok: false, error: "Register first" });

    const title = cleanString(payload?.title, MAX_TITLE_LEN);
    const optionA = cleanString(payload?.optionA, MAX_OPTION_LEN);
    const optionB = cleanString(payload?.optionB, MAX_OPTION_LEN);
    // null = no time limit.
    const durationSec = payload?.durationSec ?? null;
    if (!title) return ack({ ok: false, error: `Title is required (max ${MAX_TITLE_LEN} chars)` });
    if (!optionA || !optionB) return ack({ ok: false, error: `Both option labels are required (max ${MAX_OPTION_LEN} chars)` });
    if (optionA.toLowerCase() === optionB.toLowerCase()) return ack({ ok: false, error: "Options must differ" });
    if (
      durationSec !== null &&
      (!Number.isInteger(durationSec) || durationSec < MIN_DURATION_SEC || durationSec > MAX_DURATION_SEC)
    ) {
      return ack({ ok: false, error: `Duration must be ${MIN_DURATION_SEC}–${MAX_DURATION_SEC} seconds, or no limit` });
    }
    const probA = payload?.probA;
    if (!Number.isInteger(probA) || probA < MIN_PROB_A || probA > MAX_PROB_A) {
      return ack({ ok: false, error: `Starting chance must be a whole percent from ${MIN_PROB_A} to ${MAX_PROB_A}` });
    }

    const now = Date.now();
    /** @type {MarketRecord} */
    const m = {
      id: uuidv4(),
      title,
      options: [
        { id: "A", label: optionA },
        { id: "B", label: optionB },
      ],
      status: "OPEN",
      creatorId: user.id,
      createdAt: now,
      expiresAt: durationSec === null ? null : now + durationSec * 1000,
      settleDeadline: durationSec === null ? now + NO_LIMIT_AUTO_VOID_MS : null,
      winningOption: null,
      refereeBounty: null,
      voidReason: null,
      resolvedAt: null,
      initialProbA: probA,
    };

    markets.set(m.id, m);
    pools.set(m.id, new Map(OPTION_IDS.map((id) => [id, 0])));
    bets.set(m.id, new Map());
    if (durationSec === null) scheduleSettleDeadline(m);
    else scheduleTimer(m.id, durationSec * 1000, () => lockMarket(m.id));
    markDirty();

    const wire = serializeMarket(m);
    io.emit("MARKET_CREATED", wire);
    ack({ ok: true, data: wire });
    console.log(`[create] ${m.id} "${title}" by ${user.username}, ${durationSec === null ? "no limit" : `${durationSec}s`}, A at ${probA}%`);
  });

  socket.on("PLACE_BET", (payload, ack) => {
    const user = currentUser();
    if (!user) return ack({ ok: false, error: "Register first" });

    const marketId = payload?.marketId;
    const optionId = payload?.optionId;
    const amount = payload?.amount;
    const m = typeof marketId === "string" ? markets.get(marketId) : undefined;

    if (!m) return ack({ ok: false, error: "Market not found" });
    if (m.status !== "OPEN" || (m.expiresAt !== null && Date.now() >= m.expiresAt)) {
      return ack({ ok: false, error: "Betting is closed" });
    }
    if (m.creatorId === user.id) return ack({ ok: false, error: "You can't bet on a market you referee" });
    if (!isOptionId(optionId)) return ack({ ok: false, error: "Invalid option" });
    if (!Number.isInteger(amount) || amount <= 0) return ack({ ok: false, error: "Amount must be a positive integer" });
    if (amount > user.balance) return ack({ ok: false, error: "Insufficient balance" });
    const byUser = /** @type {Map<string, PlacedBet[]>} */ (bets.get(m.id));
    const mine = byUser.get(user.id) ?? [];
    const backed = mine[0]?.optionId;
    if (backed !== undefined && backed !== optionId) {
      const label = m.options.find((o) => o.id === backed)?.label ?? backed;
      return ack({ ok: false, error: `You already backed "${label}" here; you can only bet on one side` });
    }

    // --- atomic mutation (no awaits) ---
    // The bet is locked at the odds current *before* it lands; its stake then moves the odds.
    /** @type {PlacedBet} */
    const bet = { id: uuidv4(), optionId, amount, odds: computeOdds(m, getPools(m.id))[optionId], placedAt: Date.now() };
    user.balance -= amount;
    const pool = /** @type {Map<OptionId, number>} */ (pools.get(m.id));
    pool.set(optionId, (pool.get(optionId) ?? 0) + amount);
    mine.push(bet);
    byUser.set(user.id, mine);
    // -----------------------------------

    emitOdds(m);
    scheduleLeaderboard();
    markDirty();
    // Sync any other tabs of the same user.
    socket.to(userRoom(user.id)).emit("BALANCE_UPDATE", { balance: user.balance });
    ack({ ok: true, data: { bet: { ...bet }, bets: mine.map((b) => ({ ...b })), balance: user.balance } });
  });

  socket.on("CLOSE_BETTING", (payload, ack) => {
    const user = currentUser();
    if (!user) return ack({ ok: false, error: "Register first" });

    const m = typeof payload?.marketId === "string" ? markets.get(payload.marketId) : undefined;
    if (!m) return ack({ ok: false, error: "Market not found" });
    const admin = socket.data.isAdmin === true;
    if (m.creatorId !== user.id && !admin) return ack({ ok: false, error: "Only the market's creator (its Referee) can close betting" });
    if (m.status !== "OPEN") return ack({ ok: false, error: "Betting is already closed" });
    if (m.expiresAt !== null) {
      if (!admin) return ack({ ok: false, error: "Timed markets close automatically" });
      // Admin closing a timed market early: lock it now, which starts the Referee's settle window.
      clearTimer(m.id);
      lockMarket(m.id);
      ack({ ok: true, data: null });
      console.log(`[admin] ${user.username} closed betting early on ${m.id} "${m.title}"`);
      return;
    }

    // The auto-void timer set at creation keeps running; there's no extra settle rush.
    m.status = "LOCKED";
    io.emit("MARKET_UPDATED", serializeMarket(m));
    markDirty();
    ack({ ok: true, data: null });
    console.log(`[close] ${m.id} "${m.title}" betting closed by ${m.creatorId === user.id ? "referee" : `admin ${user.username}`}`);
  });

  socket.on("SETTLE_MARKET", (payload, ack) => {
    const user = currentUser();
    if (!user) return ack({ ok: false, error: "Register first" });

    const m = typeof payload?.marketId === "string" ? markets.get(payload.marketId) : undefined;
    if (!m) return ack({ ok: false, error: "Market not found" });
    if (m.creatorId !== user.id && !socket.data.isAdmin) {
      return ack({ ok: false, error: "Only the market's creator (its Referee) can settle it" });
    }
    if (m.status !== "OPEN" && m.status !== "LOCKED") return ack({ ok: false, error: "Market is already resolved" });
    if (!isOptionId(payload?.winningOption)) return ack({ ok: false, error: "Invalid winning option" });

    if (m.creatorId !== user.id) console.log(`[admin] ${user.username} settles ${m.id} on behalf of the referee`);
    settleMarket(m, payload.winningOption);
    ack({ ok: true, data: null });
  });

  registerAdminHandlers(socket, currentUser);
}

// ---------------------------------------------------------------------------
// Admin handlers
// ---------------------------------------------------------------------------

/**
 * @param {AppSocket} socket
 * @param {() => User | null} currentUser
 */
function registerAdminHandlers(socket, currentUser) {
  /**
   * The acting admin, or an error ack already sent.
   * @param {(res: { ok: false, error: string }) => void} ack
   * @returns {User | null}
   */
  const requireAdmin = (ack) => {
    const user = currentUser();
    if (!user) {
      ack({ ok: false, error: "Register first" });
      return null;
    }
    if (!socket.data.isAdmin) {
      ack({ ok: false, error: "Admin only" });
      return null;
    }
    return user;
  };

  /** @param {unknown} marketId */
  const unresolvedMarket = (marketId) => {
    const m = typeof marketId === "string" ? markets.get(marketId) : undefined;
    if (!m) return { error: "Market not found" };
    if (m.status !== "OPEN" && m.status !== "LOCKED") return { error: "Market is already resolved; settled results are final" };
    return { m };
  };

  socket.on("ADMIN_LOGIN", (payload, ack) => {
    const user = currentUser();
    if (!user) return ack({ ok: false, error: "Register first" });
    if (!ADMIN_PASSWORD) return ack({ ok: false, error: "Admin is not enabled on this server (ADMIN_PASSWORD not set)" });
    const failures = socket.data.failedAdminLogins ?? 0;
    if (failures >= MAX_ADMIN_LOGIN_FAILURES) return ack({ ok: false, error: "Too many attempts; reload the page to try again" });
    if (typeof payload?.password !== "string" || !safeEqual(payload.password, ADMIN_PASSWORD)) {
      socket.data.failedAdminLogins = failures + 1;
      console.warn(`[admin] failed login by ${user.username} (${user.id})`);
      return ack({ ok: false, error: "Wrong password" });
    }
    socket.data.failedAdminLogins = 0;
    socket.data.isAdmin = true;
    console.log(`[admin] ${user.username} (${user.id}) logged in`);
    ack({ ok: true, data: { token: adminToken(user.id) } });
  });

  socket.on("ADMIN_LOGOUT", (_payload, ack) => {
    socket.data.isAdmin = false;
    ack({ ok: true, data: null });
  });

  socket.on("ADMIN_ADJUST_BALANCE", (payload, ack) => {
    const admin = requireAdmin(ack);
    if (!admin) return;
    const target = typeof payload?.userId === "string" ? users.get(payload.userId) : undefined;
    if (!target) return ack({ ok: false, error: "User not found" });
    const delta = payload?.delta;
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_ADMIN_DELTA) {
      return ack({ ok: false, error: `Amount must be a non-zero whole number up to ${MAX_ADMIN_DELTA.toLocaleString("en-US")}` });
    }
    if (target.balance + delta < 0) {
      return ack({ ok: false, error: `${target.username} only has ${target.balance} pts; the balance can't go below 0` });
    }
    const reason = payload?.reason === undefined || payload.reason === "" ? null : cleanString(payload.reason, MAX_ADMIN_REASON_LEN);
    if (payload?.reason && !reason) return ack({ ok: false, error: `Reason is too long (max ${MAX_ADMIN_REASON_LEN} chars)` });

    creditUser(target.id, delta);
    notify(target.id, { marketId: "", title: reason ?? "Balance adjusted by an admin", kind: "ADMIN", amount: delta });
    scheduleLeaderboard();
    markDirty();
    ack({ ok: true, data: { balance: target.balance } });
    console.log(`[admin] ${admin.username} adjusted ${target.username} by ${delta} → ${target.balance}${reason ? ` (${reason})` : ""}`);
  });

  socket.on("ADMIN_RENAME_USER", (payload, ack) => {
    const admin = requireAdmin(ack);
    if (!admin) return;
    const target = typeof payload?.userId === "string" ? users.get(payload.userId) : undefined;
    if (!target) return ack({ ok: false, error: "User not found" });
    const username = cleanString(payload?.username, MAX_USERNAME_LEN);
    if (!username) return ack({ ok: false, error: `Username is required (max ${MAX_USERNAME_LEN} chars)` });

    const old = target.username;
    target.username = username;
    io.to(userRoom(target.id)).emit("USER_UPDATE", { ...target });
    // Referee names are part of the market payload.
    for (const m of markets.values()) {
      if (m.creatorId === target.id) io.emit("MARKET_UPDATED", serializeMarket(m));
    }
    scheduleLeaderboard();
    markDirty();
    ack({ ok: true, data: null });
    console.log(`[admin] ${admin.username} renamed ${old} → ${username} (${target.id})`);
  });

  socket.on("ADMIN_REMOVE_USER", (payload, ack) => {
    const admin = requireAdmin(ack);
    if (!admin) return;
    const target = typeof payload?.userId === "string" ? users.get(payload.userId) : undefined;
    if (!target) return ack({ ok: false, error: "User not found" });
    if (target.id === admin.id) return ack({ ok: false, error: "You can't remove yourself" });

    // Cancel their bets in unresolved markets (the stakes leave the pools). Resolved history stays.
    for (const [marketId, byUser] of bets) {
      const m = markets.get(marketId);
      const list = byUser.get(target.id);
      if (!m || !list || (m.status !== "OPEN" && m.status !== "LOCKED")) continue;
      unstake(marketId, list);
      byUser.delete(target.id);
      emitOdds(m);
    }
    users.delete(target.id);
    // Markets they referee stay; an admin can settle or void them.
    // Their open sockets now fail every action ("Register first"); the client forgets its identity.
    io.to(userRoom(target.id)).emit("ACCOUNT_REMOVED");
    io.in(userRoom(target.id)).socketsLeave(userRoom(target.id));
    scheduleLeaderboard();
    markDirty();
    ack({ ok: true, data: null });
    console.log(`[admin] ${admin.username} removed user ${target.username} (${target.id})`);
  });

  socket.on("ADMIN_VOID_MARKET", (payload, ack) => {
    const admin = requireAdmin(ack);
    if (!admin) return;
    const { m, error } = unresolvedMarket(payload?.marketId);
    if (!m) return ack({ ok: false, error: /** @type {string} */ (error) });
    const extra = payload?.reason ? cleanString(payload.reason, MAX_ADMIN_REASON_LEN) : null;
    if (payload?.reason && !extra) return ack({ ok: false, error: `Reason is too long (max ${MAX_ADMIN_REASON_LEN} chars)` });

    console.log(`[admin] ${admin.username} voids ${m.id}`);
    voidMarket(m.id, extra ? `Voided by an admin: ${extra}` : "Voided by an admin");
    ack({ ok: true, data: null });
  });

  socket.on("ADMIN_VOID_BET", (payload, ack) => {
    const admin = requireAdmin(ack);
    if (!admin) return;
    const { m, error } = unresolvedMarket(payload?.marketId);
    if (!m) return ack({ ok: false, error: /** @type {string} */ (error) });
    const byUser = bets.get(m.id);
    const userId = payload?.userId;
    const list = typeof userId === "string" ? byUser?.get(userId) : undefined;
    const index = list?.findIndex((b) => b.id === payload?.betId) ?? -1;
    if (!byUser || !list || typeof userId !== "string" || index < 0) return ack({ ok: false, error: "Bet not found" });

    const [bet] = list.splice(index, 1);
    unstake(m.id, [bet]);
    if (list.length === 0) byUser.delete(userId);
    creditUser(userId, bet.amount);
    notify(userId, { marketId: m.id, title: m.title, kind: "REFUND", amount: bet.amount });
    io.to(userRoom(userId)).emit("MY_BETS_UPDATE", { marketId: m.id, bets: list.map((b) => ({ ...b })) });
    emitOdds(m);
    scheduleLeaderboard();
    markDirty();
    ack({ ok: true, data: null });
    console.log(`[admin] ${admin.username} voided a ${bet.amount} pt bet by ${users.get(userId)?.username ?? userId} on ${m.id}`);
  });

  socket.on("ADMIN_GET_BETS", (payload, ack) => {
    if (!requireAdmin(ack)) return;
    const marketId = payload?.marketId;
    const byUser = typeof marketId === "string" ? bets.get(marketId) : undefined;
    if (typeof marketId !== "string" || !byUser) return ack({ ok: false, error: "Market not found" });
    /** @type {AdminMarketBets} */
    const data = {
      marketId,
      bettors: [...byUser].map(([userId, list]) => ({
        userId,
        username: users.get(userId)?.username ?? "removed user",
        bets: list.map((b) => ({ ...b })),
      })),
    };
    ack({ ok: true, data });
  });
}

module.exports = { attachEngine, handleHealth, loadState, installShutdownHooks };

// Standalone engine for local development: `node server.js` (port 4000, CORS for the dev app).
if (require.main === module) {
  const httpServer = http.createServer((req, res) => {
    if (handleHealth(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  attachEngine(
    new Server(httpServer, {
      cors: { origin: CLIENT_ORIGIN === "*" ? "*" : CLIENT_ORIGIN.split(",") },
    }),
  );
  loadState()
    .then(() => {
      installShutdownHooks(httpServer);
      httpServer.listen(PORT, () => {
        console.log(`[engine] Socket.io betting engine listening on http://localhost:${PORT}`);
      });
    })
    .catch((/** @type {unknown} */ err) => {
      console.error("[engine] failed to load state:", err);
      process.exit(1);
    });
}
