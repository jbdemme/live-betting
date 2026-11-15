import type { Market, OptionId, PlacedBet } from "@/lib/types";

export const formatPts = (n: number): string => n.toLocaleString("en-US");

export const formatOdds = (odds: number): string => `${odds.toFixed(2)}x`;

/** Fair decimal odds for a probability in percent (e.g. 25 → 4.00). */
export const oddsForProb = (percent: number): number => Math.round((100 / percent) * 100) / 100;

/** What a bet of `amount` at `odds` pays if it wins (mirrors server: integer math on hundredths). */
export const payoutAt = (amount: number, odds: number): number =>
  Math.floor((amount * Math.round(odds * 100)) / 100);

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

/** Total payout of the given bets if `option` wins. */
export const payoutIf = (bets: PlacedBet[], option: OptionId): number =>
  bets.filter((b) => b.optionId === option).reduce((sum, b) => sum + payoutAt(b.amount, b.odds), 0);

/** What the user received from a settled market (mirrors server payout math). */
export function settledPayout(market: Market, bets: PlacedBet[]): number {
  const w = market.winningOption;
  return market.status === "SETTLED" && w ? payoutIf(bets, w) : 0;
}

