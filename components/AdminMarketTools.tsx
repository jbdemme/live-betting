"use client";

import { useEffect, useState } from "react";
import type { Ack, AdminMarketBets, Market, OptionId } from "@/lib/types";
import { adminGetBets, adminVoidBet, adminVoidMarket, closeBetting, settleMarket } from "@/lib/socket";
import { formatOdds, formatPts, optionLabel } from "@/lib/format";

/** Admin-only controls on an OPEN/LOCKED market: close, settle, void, and per-bet voiding. */
export default function AdminMarketTools({ market, isReferee }: { market: Market; isReferee: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBets, setShowBets] = useState(false);

  const run = async (action: () => Promise<Ack>) => {
    setPending(true);
    setError(null);
    const res = await action();
    setPending(false);
    if (!res.ok) setError(res.error);
  };

  const voidMarket = () => {
    const reason = window.prompt(`Void "${market.title}" and refund every bet? Optional reason:`, "");
    if (reason === null) return;
    void run(() => adminVoidMarket(market.id, reason.trim() || undefined));
  };

  const settle = (winner: OptionId) => {
    if (!window.confirm(`Settle "${market.title}": "${optionLabel(market, winner)}" wins? This is final.`)) return;
    void run(() => settleMarket(market.id, winner));
  };

  const btn =
    "rounded-md border border-violet-500/40 px-2 py-1 text-xs font-semibold text-violet-200 transition hover:bg-violet-500/15 disabled:opacity-40";

  return (
    <div className="mt-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 rounded-md bg-violet-500 px-1.5 py-0.5 text-[10px] font-black tracking-wider text-white">ADMIN</span>
        {market.status === "OPEN" && (
          <button type="button" className={btn} disabled={pending} onClick={() => run(() => closeBetting(market.id))}>
            Close betting
          </button>
        )}
        {/* The referee already has settle buttons in their own panel. */}
        {!isReferee &&
          (["A", "B"] as const).map((id) => (
            <button key={id} type="button" className={btn} disabled={pending} onClick={() => settle(id)}>
              {optionLabel(market, id)} won
            </button>
          ))}
        <button
          type="button"
          className={`${btn} border-rose-500/40 text-rose-300 hover:bg-rose-500/10`}
          disabled={pending}
          onClick={voidMarket}
        >
          Void market
        </button>
        <button type="button" className={`${btn} ml-auto`} onClick={() => setShowBets((v) => !v)}>
          {showBets ? "Hide bets" : `Bets (${market.bettorCount})`}
        </button>
      </div>
      {showBets && <BetList market={market} onError={setError} />}
      {error && <p className="mt-2 rounded-md bg-rose-500/10 px-2 py-1 text-xs text-rose-300">{error}</p>}
    </div>
  );
}

function BetList({ market, onError }: { market: Market; onError: (e: string | null) => void }) {
  const [data, setData] = useState<AdminMarketBets | null>(null);
  const [pendingBet, setPendingBet] = useState<string | null>(null);

  // Refetch whenever the pools change (new bets, voided bets).
  useEffect(() => {
    let cancelled = false;
    void adminGetBets(market.id).then((res) => {
      if (cancelled) return;
      if (res.ok) setData(res.data);
      else onError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [market.id, market.totalPool, market.bettorCount, onError]);

  const voidBet = async (userId: string, username: string, betId: string, amount: number) => {
    if (!window.confirm(`Void ${username}'s ${amount} pt bet and refund it?`)) return;
    setPendingBet(betId);
    onError(null);
    const res = await adminVoidBet({ marketId: market.id, userId, betId });
    setPendingBet(null);
    if (!res.ok) onError(res.error);
  };

  if (!data) return <p className="mt-2 text-xs text-zinc-500">Loading bets…</p>;
  if (data.bettors.length === 0) return <p className="mt-2 text-xs text-zinc-500">No bets yet.</p>;

  return (
    <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1 text-xs">
      {data.bettors.map((b) => (
        <li key={b.userId} className="rounded-md bg-zinc-950/60 px-2 py-1.5">
          <div className="font-medium text-zinc-300">{b.username}</div>
          <ul className="mt-0.5 space-y-0.5 font-mono tabular-nums">
            {b.bets.map((bet) => (
              <li key={bet.id} className="flex items-center justify-between gap-2 text-zinc-400">
                <span>
                  {formatPts(bet.amount)} on {optionLabel(market, bet.optionId)} @ {formatOdds(bet.odds)}
                </span>
                <button
                  type="button"
                  disabled={pendingBet !== null}
                  onClick={() => void voidBet(b.userId, b.username, bet.id, bet.amount)}
                  className="rounded border border-rose-500/40 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-40"
                >
                  {pendingBet === bet.id ? "…" : "Void"}
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
