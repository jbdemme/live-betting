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

/** Implied parimutuel odds per option: Total Pool / Option Pool (null when option pool is empty). */
export type OddsMap = Record<OptionId, number | null>;

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
  pools: PoolMap;
  totalPool: number;
  odds: OddsMap;
  bettorCount: number;
  winningOption: OptionId | null;
  refereeBounty: number | null;
  voidReason: string | null;
  resolvedAt: number | null;
}

/** The current user's stake per option in one market. */
export type Stake = PoolMap;

export type MyBets = Record<string, Stake>;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface RegisterUserPayload {
  /** Persisted client id; reused on reconnect so the balance survives refreshes. */
  userId: string;
  username: string;
}

export interface CreateMarketPayload {
  title: string;
  optionA: string;
  optionB: string;
  /** Betting window in seconds, or null for no time limit. */
  durationSec: number | null;
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

export interface SessionSnapshot {
  user: User;
  markets: Market[];
  myBets: MyBets;
  serverNow: number;
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
  kind: "WIN" | "LOSS" | "REFUND" | "BOUNTY";
  amount: number;
}

// ---------------------------------------------------------------------------
// Event maps (typed Socket.io)
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  REGISTER_USER: (payload: RegisterUserPayload, ack: (res: Ack<SessionSnapshot>) => void) => void;
  CREATE_MARKET: (payload: CreateMarketPayload, ack: (res: Ack<Market>) => void) => void;
  PLACE_BET: (payload: PlaceBetPayload, ack: (res: Ack<{ stake: Stake; balance: number }>) => void) => void;
  /** Creator-only, no-time-limit markets: stop betting before declaring the outcome. */
  CLOSE_BETTING: (payload: { marketId: string }, ack: (res: Ack) => void) => void;
  SETTLE_MARKET: (payload: SettleMarketPayload, ack: (res: Ack) => void) => void;
}

export interface ServerToClientEvents {
  MARKET_CREATED: (market: Market) => void;
  /** Any non-odds change to a market (e.g. locked). */
  MARKET_UPDATED: (market: Market) => void;
  ODDS_UPDATE: (payload: OddsUpdatePayload) => void;
  MARKET_SETTLED: (market: Market) => void;
  MARKET_VOIDED: (market: Market) => void;
  BALANCE_UPDATE: (payload: { balance: number }) => void;
  PAYOUT: (notice: PayoutNotice) => void;
}
