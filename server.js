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
 *  - Settling pays winners `wager * (totalPool / winningPool)` and mints a 5% bounty
 *    (of the total pool) for the Referee on top.
 *  - VOID refunds every wager in full.
 *
 * Handlers run synchronously (no awaits between validation and mutation), so every
 * state transition is atomic with respect to other socket events.
 *
 * Persistence: with DATABASE_URL set, the whole state is snapshotted to Postgres
 * (debounced, plus a final flush on shutdown) and restored on startup — see persistence.js.
 */

const http = require("node:http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const persistence = require("./persistence");

/** @typedef {import("./lib/types").OptionId} OptionId */
/** @typedef {import("./lib/types").MarketStatus} MarketStatus */
/** @typedef {import("./lib/types").User} User */
/** @typedef {import("./lib/types").Market} Market */
/** @typedef {import("./lib/types").MarketOption} MarketOption */
/** @typedef {import("./lib/types").Stake} Stake */
/** @typedef {import("./lib/types").MyBets} MyBets */
/** @typedef {import("./lib/types").OddsMap} OddsMap */
/** @typedef {import("./lib/types").PoolMap} PoolMap */
/** @typedef {import("./lib/types").PayoutNotice} PayoutNotice */
/** @typedef {import("./lib/types").LeaderboardEntry} LeaderboardEntry */
/** @typedef {import("./lib/types").ClientToServerEvents} ClientToServerEvents */
/** @typedef {import("./lib/types").ServerToClientEvents} ServerToClientEvents */
/** @typedef {{ userId?: string }} SocketData */
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
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "*";
const STARTING_BALANCE = 1000;
const REFEREE_BOUNTY_RATE = 0.05;
const REFEREE_SETTLE_WINDOW_MS = 60_000;
/** No-time-limit markets refund everyone if still unsettled this long after creation. */
const NO_LIMIT_AUTO_VOID_MS = 3 * 60 * 60 * 1000;
/** Debounce for writing snapshots to the database. */
const SAVE_DEBOUNCE_MS = 2000;
/** Only the most recent resolved markets are kept (in memory and in the snapshot). */
const MAX_RESOLVED_KEPT = 50;
const SNAPSHOT_VERSION = 1;
const MIN_DURATION_SEC = 15;
const MAX_DURATION_SEC = 60 * 60;
const MAX_TITLE_LEN = 120;
const MAX_OPTION_LEN = 32;
const MAX_USERNAME_LEN = 24;
/** @type {readonly OptionId[]} */
const OPTION_IDS = ["A", "B"];

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** User ledger. @type {Map<string, User>} */
const users = new Map();
/** @type {Map<string, MarketRecord>} */
const markets = new Map();
/** Pool allocations: total wagered points per option. @type {Map<string, Map<OptionId, number>>} */
const pools = new Map();
/** Per-market wagers: marketId -> userId -> stake per option. @type {Map<string, Map<string, Stake>>} */
const bets = new Map();
/** Pending lock / referee-timeout timers. @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {string} userId */
const userRoom = (userId) => `user:${userId}`;

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

/** Parimutuel implied odds: Total Pool / Option Pool. @param {PoolMap} p @returns {OddsMap} */
function computeOdds(p) {
  const total = p.A + p.B;
  return {
    A: p.A > 0 ? total / p.A : null,
    B: p.B > 0 ? total / p.B : null,
  };
}

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
    pools: p,
    totalPool: p.A + p.B,
    odds: computeOdds(p),
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
    const stake = byUser.get(userId);
    if (stake) result[marketId] = { ...stake };
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
    for (const [userId, stake] of byUser) {
      atStake.set(userId, (atStake.get(userId) ?? 0) + stake.A + stake.B);
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

  for (const [userId, stake] of bets.get(marketId) ?? []) {
    const refund = stake.A + stake.B;
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
      : `Referee did not settle within ${REFEREE_SETTLE_WINDOW_MS / 1000}s`;
  scheduleTimer(m.id, m.settleDeadline - Date.now(), () => voidMarket(m.id, reason));
}

/**
 * SETTLE: pay winners `wager * (totalPool / winningPool)`, mint a 5% bounty for the Referee (creator).
 * @param {MarketRecord} m
 * @param {OptionId} winningOption
 */
function settleMarket(m, winningOption) {
  const p = getPools(m.id);
  const totalPool = p.A + p.B;
  const winningPool = p[winningOption];

  if (winningPool === 0) {
    // Nobody backed the winner: there is no one to pay, so refund everyone instead of burning points.
    voidMarket(m.id, `No wagers on the winning option ("${m.options.find((o) => o.id === winningOption)?.label}")`);
    return;
  }

  clearTimer(m.id);
  m.status = "SETTLED";
  m.winningOption = winningOption;
  m.resolvedAt = Date.now();

  for (const [userId, stake] of bets.get(m.id) ?? []) {
    const wager = stake[winningOption];
    if (wager > 0) {
      const payout = Math.floor((wager * totalPool) / winningPool);
      creditUser(userId, payout);
      notify(userId, { marketId: m.id, title: m.title, kind: "WIN", amount: payout });
    } else {
      notify(userId, { marketId: m.id, title: m.title, kind: "LOSS", amount: stake.A + stake.B });
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
  console.log(`[settle] ${m.id} "${m.title}" → ${winningOption}, pool ${totalPool}, bounty ${bounty}`);
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
 * @property {[string, [string, Stake][]][]} bets
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
  for (const [id, byUser] of snap.bets) bets.set(id, new Map(byUser.map(([uid, st]) => [uid, { ...st }])));
}

/**
 * Re-arm timers for unresolved markets after a restart. Downtime never eats a timed
 * market's 60s ruling window (an expired window restarts); the no-limit 3h cap is absolute.
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
  const snap = /** @type {Snapshot | null} */ (await persistence.claimAndLoad());
  if (snap && snap.version === SNAPSHOT_VERSION) {
    restore(snap);
    console.log(`[persist] restored ${users.size} users and ${markets.size} markets`);
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

    let user = users.get(userId);
    if (!user) {
      user = { id: userId, username, balance: STARTING_BALANCE };
      users.set(userId, user);
      console.log(`[register] ${username} (${userId})`);
    } else {
      user.username = username;
    }

    socket.data.userId = userId;
    socket.join(userRoom(userId));

    ack({
      ok: true,
      data: {
        user: { ...user },
        markets: [...markets.values()].map(serializeMarket),
        myBets: myBetsFor(userId),
        leaderboard: buildLeaderboard(),
        serverNow: Date.now(),
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
    console.log(`[create] ${m.id} "${title}" by ${user.username}, ${durationSec === null ? "no limit" : `${durationSec}s`}`);
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

    // --- atomic mutation (no awaits) ---
    user.balance -= amount;
    const pool = /** @type {Map<OptionId, number>} */ (pools.get(m.id));
    pool.set(optionId, (pool.get(optionId) ?? 0) + amount);
    const byUser = /** @type {Map<string, Stake>} */ (bets.get(m.id));
    const stake = byUser.get(user.id) ?? { A: 0, B: 0 };
    stake[optionId] += amount;
    byUser.set(user.id, stake);
    // -----------------------------------

    const p = getPools(m.id);
    io.emit("ODDS_UPDATE", {
      marketId: m.id,
      pools: p,
      totalPool: p.A + p.B,
      odds: computeOdds(p),
      bettorCount: bettorCount(m.id),
    });
    scheduleLeaderboard();
    markDirty();
    // Sync any other tabs of the same user.
    socket.to(userRoom(user.id)).emit("BALANCE_UPDATE", { balance: user.balance });
    ack({ ok: true, data: { stake: { ...stake }, balance: user.balance } });
  });

  socket.on("CLOSE_BETTING", (payload, ack) => {
    const user = currentUser();
    if (!user) return ack({ ok: false, error: "Register first" });

    const m = typeof payload?.marketId === "string" ? markets.get(payload.marketId) : undefined;
    if (!m) return ack({ ok: false, error: "Market not found" });
    if (m.creatorId !== user.id) return ack({ ok: false, error: "Only the market's creator (its Referee) can close betting" });
    if (m.expiresAt !== null) return ack({ ok: false, error: "Timed markets close automatically" });
    if (m.status !== "OPEN") return ack({ ok: false, error: "Betting is already closed" });

    // The auto-void timer set at creation keeps running; there's no extra settle rush.
    m.status = "LOCKED";
    io.emit("MARKET_UPDATED", serializeMarket(m));
    markDirty();
    ack({ ok: true, data: null });
    console.log(`[close] ${m.id} "${m.title}" betting closed by referee`);
  });

  socket.on("SETTLE_MARKET", (payload, ack) => {
    const user = currentUser();
    if (!user) return ack({ ok: false, error: "Register first" });

    const m = typeof payload?.marketId === "string" ? markets.get(payload.marketId) : undefined;
    if (!m) return ack({ ok: false, error: "Market not found" });
    if (m.creatorId !== user.id) return ack({ ok: false, error: "Only the market's creator (its Referee) can settle it" });
    if (m.status !== "OPEN" && m.status !== "LOCKED") return ack({ ok: false, error: "Market is already resolved" });
    if (!isOptionId(payload?.winningOption)) return ack({ ok: false, error: "Invalid winning option" });

    settleMarket(m, payload.winningOption);
    ack({ ok: true, data: null });
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
