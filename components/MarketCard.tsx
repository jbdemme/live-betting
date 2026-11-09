"use client";

import { useState, type ReactNode } from "react";
import type { Ack, Market, OptionId } from "@/lib/types";
import { claimReferee, placeBet, settleMarket } from "@/lib/socket";
import { EMPTY_STAKE, stakeTotal, useBettingStore } from "@/store/useBettingStore";
import { useServerNow } from "@/hooks/useNow";
import { formatCountdown, formatOdds, formatPts, optionLabel, settledPayout } from "@/lib/format";

const QUICK_BETS = [50, 100, 250] as const;

const OPTION_STYLE: Record<OptionId, { text: string; bar: string; btn: string; ring: string }> = {
  A: {
    text: "text-sky-300",
    bar: "bg-sky-500",
    btn: "border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/25",
    ring: "ring-sky-400",
  },
  B: {
    text: "text-fuchsia-300",
    bar: "bg-fuchsia-500",
    btn: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200 hover:bg-fuchsia-500/25",
    ring: "ring-fuchsia-400",
  },
};

const STATUS_STYLE: Record<Market["status"], string> = {
  OPEN: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  LOCKED: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  SETTLED: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  VOID: "bg-zinc-700/40 text-zinc-400 border-zinc-600/40",
};

export default function MarketCard({ market }: { market: Market }) {
  const userId = useBettingStore((s) => s.currentUser?.id ?? null);
  const balance = useBettingStore((s) => s.currentUser?.balance ?? 0);
  const stake = useBettingStore((s) => s.myBets[market.id] ?? EMPTY_STAKE);
  const now = useServerNow();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isReferee = userId !== null && market.refereeId === userId;
  const myTotal = stakeTotal(stake);
  const bettingOpen = market.status === "OPEN" && now < market.expiresAt;
  const resolved = market.status === "SETTLED" || market.status === "VOID";

  const run = async (action: () => Promise<Ack>) => {
    setPending(true);
    setError(null);
    const res = await action();
    setPending(false);
    if (!res.ok) setError(res.error);
  };

  const shareA = market.totalPool > 0 ? (market.pools.A / market.totalPool) * 100 : 50;

  return (
    <article
      className={`rounded-2xl border bg-zinc-900/70 p-4 shadow-lg transition sm:p-5 ${
        resolved ? "border-zinc-800/70 opacity-80" : "border-zinc-800"
      }`}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-2">
            <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold tracking-wider ${STATUS_STYLE[market.status]}`}>
              {market.status}
            </span>
            <span className="truncate text-xs text-zinc-500">
              by {market.creatorName} · {market.bettorCount} {market.bettorCount === 1 ? "bettor" : "bettors"}
            </span>
          </div>
          <h3 className="text-base font-semibold leading-snug text-zinc-100 sm:text-lg">{market.title}</h3>
        </div>
        <Timer market={market} now={now} />
      </div>

      {/* Parimutuel odds bar */}
      <div className="mt-4">
        <div className="mb-1.5 flex justify-between text-sm">
          {(["A", "B"] as const).map((id) => (
            <div key={id} className={id === "B" ? "text-right" : undefined}>
              <span className={`font-semibold ${OPTION_STYLE[id].text}`}>
                {optionLabel(market, id)}
                {market.winningOption === id && " ✓"}
              </span>
              <span className="ml-2 font-mono text-zinc-300 tabular-nums">{formatOdds(market.odds[id])}</span>
              <div className="font-mono text-xs text-zinc-500 tabular-nums">{formatPts(market.pools[id])} pts</div>
            </div>
          ))}
        </div>
        <div className="flex h-3 overflow-hidden rounded-full bg-zinc-800" role="img" aria-label={`${Math.round(shareA)}% of pool on ${optionLabel(market, "A")}`}>
          <div
            className={`${market.totalPool > 0 ? OPTION_STYLE.A.bar : "bg-zinc-700"} transition-[width] duration-700 ease-out`}
            style={{ width: `${shareA}%` }}
          />
          <div
            className={`${market.totalPool > 0 ? OPTION_STYLE.B.bar : "bg-zinc-700/60"} flex-1 transition-[width] duration-700 ease-out`}
          />
        </div>
        <div className="mt-1 text-center font-mono text-xs text-zinc-500 tabular-nums">
          Total pool {formatPts(market.totalPool)} pts
        </div>
      </div>

      {/* Quick bets */}
      {bettingOpen && !isReferee && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {(["A", "B"] as const).map((id) => (
            <div key={id} className="flex items-center gap-1.5">
              <span className={`w-16 shrink-0 truncate text-xs font-medium ${OPTION_STYLE[id].text}`}>
                {optionLabel(market, id)}
              </span>
              {QUICK_BETS.map((amt) => (
                <button
                  key={amt}
                  type="button"
                  disabled={pending || amt > balance}
                  onClick={() => run(() => placeBet(market.id, id, amt))}
                  className={`flex-1 rounded-lg border px-2 py-1.5 font-mono text-sm font-semibold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 ${OPTION_STYLE[id].btn}`}
                >
                  +{amt}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* My position */}
      {myTotal > 0 && <MyPosition market={market} stake={stake} />}

      {/* Referee */}
      <RefereePanel
        market={market}
        now={now}
        isReferee={isReferee}
        hasBets={myTotal > 0}
        bettingOpen={bettingOpen}
        pending={pending}
        onClaim={() => run(() => claimReferee(market.id))}
        onSettle={(winner) => run(() => settleMarket(market.id, winner))}
      />

      {error && <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
    </article>
  );
}

function Timer({ market, now }: { market: Market; now: number }) {
  if (market.status === "OPEN") {
    const remaining = market.expiresAt - now;
    const urgent = remaining < 15_000;
    return (
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">Closes in</div>
        <div className={`font-mono text-xl font-bold tabular-nums ${urgent ? "animate-pulse text-rose-400" : "text-zinc-100"}`}>
          {formatCountdown(remaining)}
        </div>
      </div>
    );
  }
  if (market.status === "LOCKED" && market.settleDeadline) {
    return (
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-wider text-amber-500/80">Ruling due</div>
        <div className="font-mono text-xl font-bold tabular-nums text-amber-300">
          {formatCountdown(market.settleDeadline - now)}
        </div>
      </div>
    );
  }
  return null;
}

function MyPosition({ market, stake }: { market: Market; stake: Market["pools"] }) {
  const total = stakeTotal(stake);
  let outcome: ReactNode = null;

  if (market.status === "SETTLED") {
    const payout = settledPayout(market, stake);
    const net = payout - total;
    outcome = (
      <span className={net >= 0 ? "text-emerald-300" : "text-rose-300"}>
        {net >= 0 ? "+" : "−"}
        {formatPts(Math.abs(net))} pts net
      </span>
    );
  } else if (market.status === "VOID") {
    outcome = <span className="text-zinc-300">{formatPts(total)} pts refunded</span>;
  }

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-zinc-950/60 px-3 py-2 text-xs">
      <span className="text-zinc-400">
        Your stake:{" "}
        {(["A", "B"] as const)
          .filter((id) => stake[id] > 0)
          .map((id) => (
            <span key={id} className={`ml-1 font-mono font-semibold ${OPTION_STYLE[id].text}`}>
              {formatPts(stake[id])} on {optionLabel(market, id)}
            </span>
          ))}
      </span>
      {outcome && <span className="font-mono font-semibold">{outcome}</span>}
    </div>
  );
}

interface RefereePanelProps {
  market: Market;
  now: number;
  isReferee: boolean;
  hasBets: boolean;
  bettingOpen: boolean;
  pending: boolean;
  onClaim: () => void;
  onSettle: (winner: OptionId) => void;
}

function RefereePanel({ market, now, isReferee, hasBets, bettingOpen, pending, onClaim, onSettle }: RefereePanelProps) {
  const [selected, setSelected] = useState<OptionId | null>(null);

  if (market.status === "SETTLED") {
    return (
      <div className="mt-4 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
        Settled by <span className="font-medium text-zinc-200">{market.refereeName}</span> · winner{" "}
        <span className={`font-semibold ${market.winningOption ? OPTION_STYLE[market.winningOption].text : ""}`}>
          {market.winningOption ? optionLabel(market, market.winningOption) : "—"}
        </span>{" "}
        · referee bounty <span className="font-mono text-emerald-300">+{formatPts(market.refereeBounty ?? 0)}</span>
      </div>
    );
  }

  if (market.status === "VOID") {
    return (
      <div className="mt-4 border-t border-zinc-800 pt-3 text-xs text-zinc-500">
        Voided — {market.voidReason ?? "all wagers refunded"}. All wagers refunded.
      </div>
    );
  }

  // Active market, no referee yet.
  if (!market.refereeId) {
    return (
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-3">
        <span className="flex items-center gap-1.5 text-xs text-amber-300/90">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          No referee — market voids at close without one
        </span>
        {hasBets ? (
          <span className="text-xs text-zinc-500">You&apos;ve bet here, so you can&apos;t referee</span>
        ) : (
          <button
            type="button"
            disabled={pending || !bettingOpen}
            onClick={onClaim}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs font-semibold text-amber-200 transition hover:bg-amber-400/20 disabled:opacity-40"
          >
            Claim Referee (+5% Bounty)
          </button>
        )}
      </div>
    );
  }

  // Someone else is referee.
  if (!isReferee) {
    return (
      <div className="mt-4 flex items-center gap-2 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
        <span className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-semibold text-zinc-300">
          Referee Assigned
        </span>
        <span className="truncate">{market.refereeName}</span>
        {market.status === "LOCKED" && <span className="ml-auto text-amber-300/80">awaiting ruling…</span>}
      </div>
    );
  }

  // You are the referee.
  const bounty = Math.round(market.totalPool * 0.05);
  return (
    <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-md bg-amber-400 px-1.5 py-0.5 text-[10px] font-black tracking-wider text-zinc-950">
          YOU ARE REFEREE
        </span>
        <span className="font-mono text-xs text-amber-200/80">bounty ≈ +{formatPts(bounty)} pts</span>
      </div>
      <p className="mt-2 text-xs text-zinc-400">
        {market.status === "LOCKED" && market.settleDeadline
          ? `Betting closed. Declare the outcome within ${formatCountdown(market.settleDeadline - now)} or the market is voided.`
          : "You can't bet on this market. Declare the outcome once it happens — settling ends betting immediately."}
      </p>
      <div className="mt-2 flex gap-2">
        {(["A", "B"] as const).map((id) => (
          <button
            key={id}
            type="button"
            disabled={pending}
            onClick={() => setSelected(id)}
            aria-pressed={selected === id}
            className={`flex-1 rounded-lg border px-3 py-1.5 text-sm font-semibold transition disabled:opacity-40 ${OPTION_STYLE[id].btn} ${
              selected === id ? `ring-2 ${OPTION_STYLE[id].ring}` : ""
            }`}
          >
            {optionLabel(market, id)} won
          </button>
        ))}
      </div>
      {selected && (
        <button
          type="button"
          disabled={pending}
          onClick={() => onSettle(selected)}
          className="mt-2 w-full rounded-lg bg-amber-400 py-1.5 text-sm font-bold text-zinc-950 transition hover:bg-amber-300 disabled:opacity-40"
        >
          {pending ? "Settling…" : `Confirm: "${optionLabel(market, selected)}" wins`}
        </button>
      )}
    </div>
  );
}
