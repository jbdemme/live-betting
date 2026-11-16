/**
 * Shared wire types between the Socket.io engine (`server.js`) and the client.
 * `server.js` mirrors these shapes via JSDoc typedefs.
 */

export type OptionId = "A" | "B";

export type MarketStatus = "OPEN" | "LOCKED" | "SETTLED" | "VOID";

export interface User {
  id: string;
  username: string;
  balance: number;
}

export interface MarketOption {
  id: OptionId;
  label: string;
}

/**
 * Current decimal odds per option (2 decimals). A new bet is locked at these odds.
 * odds = (SEED + total staked) / (option seed + option staked), where the virtual SEED
 * is split by the creator's starting probability.
 */
export type OddsMap = Record<OptionId, number>;

export type PoolMap = Record<OptionId, number>;

export interface Market {
  id: string;
  title: string;
  options: [MarketOption, MarketOption];
  status: MarketStatus;
  /** The creator is the market's Referee: they settle it, can't bet on it, and earn the bounty. */
  creatorId: string;
  creatorName: string;
  createdAt: number;
  /** Epoch ms when betting locks; null for a no-time-limit market (the creator closes betting). */
  expiresAt: number | null;
  /**
   * Epoch ms by which the referee must settle or the market auto-voids.
   * Timed markets: set when betting locks. No-time-limit markets: set at creation.
   */
  settleDeadline: number | null;
  /** Creator's starting probability for option A, in percent (1–99). */
  initialProbA: number;
  /**
   * Referee's live tally of how often the event has happened (e.g. "says 'essentially'").
   * Display-only, never settles anything; null until the Referee first taps +.
   */
  eventCount: number | null;
  /** Real points staked per option. */
  pools: PoolMap;
  /** Real points staked in total. */
  totalPool: number;
  odds: OddsMap;
  bettorCount: number;
  winningOption: OptionId | null;
  refereeBounty: number | null;
  voidReason: string | null;
  resolvedAt: number | null;
}

/** One bet, locked at the odds that were current when it was placed. */
export interface PlacedBet {
  id: string;
  optionId: OptionId;
  amount: number;
  /** Decimal odds locked for this bet; it pays floor(amount * odds) if its option wins. */
  odds: number;
  placedAt: number;
}

/** The current user's bets per market id (a user backs only one option per market). */
export type MyBets = Record<string, PlacedBet[]>;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface RegisterUserPayload {
  /** Persisted client id; reused on reconnect so the balance survives refreshes. */
  userId: string;
  /** Used only when the user is new; an existing user keeps the server's name (an admin may have renamed them). */
  username: string;
  /** Token from ADMIN_LOGIN, re-sent on every connect to keep admin rights. */
  adminToken?: string;
}

export interface CreateMarketPayload {
  title: string;
  optionA: string;
  optionB: string;
  /** Betting window in seconds, or null for no time limit. */
  durationSec: number | null;
  /** Starting probability for option A in percent, integer 1–99; sets the starting odds. */
  probA: number;
}

export interface PlaceBetPayload {
  marketId: string;
  optionId: OptionId;
  amount: number;
}

export interface SettleMarketPayload {
  marketId: string;
  winningOption: OptionId;
}

export type Ack<T = null> = { ok: true; data: T } | { ok: false; error: string };

export interface LeaderboardEntry {
  userId: string;
  username: string;
  /** Spendable points. */
  balance: number;
  /** Points staked in markets that are still OPEN or LOCKED. */
  atStake: number;
  /** Ranking score: balance + atStake. */
  total: number;
  online: boolean;
}

export interface SessionSnapshot {
  user: User;
  markets: Market[];
  myBets: MyBets;
  /** All users, best first. */
  leaderboard: LeaderboardEntry[];
  serverNow: number;
  /** True if `adminToken` was valid. */
  isAdmin: boolean;
}

export interface OddsUpdatePayload {
  marketId: string;
  pools: PoolMap;
  totalPool: number;
  odds: OddsMap;
  bettorCount: number;
}

export interface PayoutNotice {
  marketId: string;
  title: string;
  /** ADMIN: an admin changed the balance; `amount` is signed and `title` holds the reason. */
  kind: "WIN" | "LOSS" | "REFUND" | "BOUNTY" | "ADMIN";
  amount: number;
}

// ---------------------------------------------------------------------------
// Admin (unlocked with the ADMIN_PASSWORD env var on the server)
// ---------------------------------------------------------------------------

export interface AdminAdjustPayload {
  userId: string;
  /** Non-zero integer; the resulting balance may not go below 0. */
  delta: number;
  reason?: string;
}

export interface AdminVoidBetPayload {
  marketId: string;
  userId: string;
  betId: string;
}

/** Every user's bets on one market, for the admin panel. */
export interface AdminMarketBets {
  marketId: string;
  bettors: { userId: string; username: string; bets: PlacedBet[] }[];
}

// ---------------------------------------------------------------------------
// Event maps (typed Socket.io)
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  REGISTER_USER: (payload: RegisterUserPayload, ack: (res: Ack<SessionSnapshot>) => void) => void;
  CREATE_MARKET: (payload: CreateMarketPayload, ack: (res: Ack<Market>) => void) => void;
  PLACE_BET: (payload: PlaceBetPayload, ack: (res: Ack<{ bet: PlacedBet; bets: PlacedBet[]; balance: number }>) => void) => void;
  /** Creator-only, no-time-limit markets: stop betting before declaring the outcome. */
  CLOSE_BETTING: (payload: { marketId: string }, ack: (res: Ack) => void) => void;
  SETTLE_MARKET: (payload: SettleMarketPayload, ack: (res: Ack) => void) => void;
  /** Referee-only, OPEN/LOCKED markets: add 1 to the live event counter (broadcast via MARKET_UPDATED). */
  COUNT_EVENT: (payload: { marketId: string }, ack: (res: Ack<{ eventCount: number }>) => void) => void;

  // Admin. CLOSE_BETTING and SETTLE_MARKET above also accept an admin on any market
  // (an admin may close a timed market early, too).
  ADMIN_LOGIN: (payload: { password: string }, ack: (res: Ack<{ token: string }>) => void) => void;
  ADMIN_LOGOUT: (payload: Record<string, never>, ack: (res: Ack) => void) => void;
  ADMIN_ADJUST_BALANCE: (payload: AdminAdjustPayload, ack: (res: Ack<{ balance: number }>) => void) => void;
  ADMIN_RENAME_USER: (payload: { userId: string; username: string }, ack: (res: Ack) => void) => void;
  /** Deletes the user; their bets in unresolved markets are cancelled (no refund, the account is gone). */
  ADMIN_REMOVE_USER: (payload: { userId: string }, ack: (res: Ack) => void) => void;
  /** Void an OPEN/LOCKED market and refund every bet. */
  ADMIN_VOID_MARKET: (payload: { marketId: string; reason?: string }, ack: (res: Ack) => void) => void;
  /** Cancel and refund one bet on an OPEN/LOCKED market. Other bets keep their locked odds. */
  ADMIN_VOID_BET: (payload: AdminVoidBetPayload, ack: (res: Ack) => void) => void;
  ADMIN_GET_BETS: (payload: { marketId: string }, ack: (res: Ack<AdminMarketBets>) => void) => void;
}

export interface ServerToClientEvents {
  MARKET_CREATED: (market: Market) => void;
  /** Any non-odds change to a market (e.g. locked, event counted). */
  MARKET_UPDATED: (market: Market) => void;
  ODDS_UPDATE: (payload: OddsUpdatePayload) => void;
  MARKET_SETTLED: (market: Market) => void;
  MARKET_VOIDED: (market: Market) => void;
  BALANCE_UPDATE: (payload: { balance: number }) => void;
  PAYOUT: (notice: PayoutNotice) => void;
  /** Full ranking, best first; sent (debounced) whenever totals or online status change. */
  LEADERBOARD_UPDATE: (entries: LeaderboardEntry[]) => void;
  /** The user's bets on a market changed without them placing one (an admin voided a bet). */
  MY_BETS_UPDATE: (payload: { marketId: string; bets: PlacedBet[] }) => void;
  /** The user's profile changed (an admin renamed them). */
  USER_UPDATE: (user: User) => void;
  /** An admin deleted this account; the client should forget its identity. */
  ACCOUNT_REMOVED: () => void;
}
