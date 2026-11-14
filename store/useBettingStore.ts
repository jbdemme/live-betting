import { create } from "zustand";
import type {
  Market,
  MyBets,
  OddsUpdatePayload,
  PayoutNotice,
  SessionSnapshot,
  Stake,
  User,
} from "@/lib/types";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected";

export interface Identity {
  userId: string;
  username: string;
}

export interface Toast extends PayoutNotice {
  id: string;
}

interface BettingState {
  /** Persisted client identity (localStorage); null until the user picks a name. */
  identity: Identity | null;
  /** True once the identity has been read from localStorage on the client. */
  identityLoaded: boolean;
  connection: ConnectionStatus;
  currentUser: User | null;
  /** Markets keyed by id (live parimutuel odds are carried on each market). */
  markets: Record<string, Market>;
  myBets: MyBets;
  /** serverNow - clientNow, used to render timers against the server clock. */
  clockOffset: number;
  toasts: Toast[];

  setIdentity: (identity: Identity | null) => void;
  setConnection: (status: ConnectionStatus) => void;
  applySession: (snapshot: SessionSnapshot) => void;
  upsertMarket: (market: Market) => void;
  applyOdds: (update: OddsUpdatePayload) => void;
  setBalance: (balance: number) => void;
  setStake: (marketId: string, stake: Stake) => void;
  pushToast: (notice: PayoutNotice) => void;
  dismissToast: (id: string) => void;
}

let toastSeq = 0;

export const useBettingStore = create<BettingState>()((set) => ({
  identity: null,
  identityLoaded: false,
  connection: "idle",
  currentUser: null,
  markets: {},
  myBets: {},
  clockOffset: 0,
  toasts: [],

  setIdentity: (identity) => set({ identity, identityLoaded: true }),

  setConnection: (connection) => set({ connection }),

  applySession: ({ user, markets, myBets, serverNow }) =>
    set({
      currentUser: user,
      markets: Object.fromEntries(markets.map((m) => [m.id, m])),
      myBets,
      clockOffset: serverNow - Date.now(),
    }),

  upsertMarket: (market) => set((s) => ({ markets: { ...s.markets, [market.id]: market } })),

  applyOdds: ({ marketId, pools, totalPool, odds, bettorCount }) =>
    set((s) => {
      const existing = s.markets[marketId];
      if (!existing) return s;
      return {
        markets: { ...s.markets, [marketId]: { ...existing, pools, totalPool, odds, bettorCount } },
      };
    }),

  setBalance: (balance) =>
    set((s) => (s.currentUser ? { currentUser: { ...s.currentUser, balance } } : s)),

  setStake: (marketId, stake) => set((s) => ({ myBets: { ...s.myBets, [marketId]: stake } })),

  pushToast: (notice) =>
    set((s) => ({ toasts: [...s.toasts, { ...notice, id: `t${++toastSeq}` }].slice(-5) })),

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// ---------------------------------------------------------------------------
// Derived selectors / helpers
// ---------------------------------------------------------------------------

export const EMPTY_STAKE: Stake = { A: 0, B: 0 };

export const stakeTotal = (stake: Stake): number => stake.A + stake.B;

const isActive = (m: Market): boolean => m.status === "OPEN" || m.status === "LOCKED";

/** Next deadline that matters for a market (no-time-limit markets fall back to their auto-void time). */
const nextDeadline = (m: Market): number =>
  (m.status === "OPEN" ? m.expiresAt : null) ?? m.settleDeadline ?? Number.MAX_SAFE_INTEGER;

/** Active markets, soonest deadline first. */
export function selectActiveMarkets(markets: Record<string, Market>): Market[] {
  return Object.values(markets)
    .filter(isActive)
    .sort((a, b) => nextDeadline(a) - nextDeadline(b));
}

/** Settled/voided markets, most recent first. */
export function selectResolvedMarkets(markets: Record<string, Market>, limit = 10): Market[] {
  return Object.values(markets)
    .filter((m) => !isActive(m))
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    .slice(0, limit);
}
