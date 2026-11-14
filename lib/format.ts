import type { Market, OptionId, Stake } from "@/lib/types";

export const formatPts = (n: number): string => n.toLocaleString("en-US");

export const formatOdds = (odds: number | null): string => (odds === null ? "—" : `${odds.toFixed(2)}x`);

/** m:ss (or h:mm:ss for an hour or more) countdown, clamped at 0. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function optionLabel(market: Market, id: OptionId): string {
  return market.options.find((o) => o.id === id)?.label ?? id;
}

/** What the user received from a settled market (mirrors server payout math). */
export function settledPayout(market: Market, stake: Stake): number {
  const w = market.winningOption;
  if (market.status !== "SETTLED" || !w) return 0;
  const winningPool = market.pools[w];
  if (winningPool === 0 || stake[w] === 0) return 0;
  return Math.floor((stake[w] * market.totalPool) / winningPool);
}

