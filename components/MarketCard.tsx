"use client";

import { useState, type ReactNode } from "react";
import type { Ack, Market, OptionId, PlacedBet } from "@/lib/types";
import { closeBetting, countEvent, placeBet, settleMarket } from "@/lib/socket";
import { EMPTY_BETS, betsTotal, useBettingStore } from "@/store/useBettingStore";
import { useServerNow } from "@/hooks/useNow";
import AdminMarketTools from "@/components/AdminMarketTools";
import { formatCountdown, formatOdds, formatPts, optionLabel, payoutAt, payoutIf, settledPayout } from "@/lib/format";

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
  const myBets = useBettingStore((s) => s.myBets[market.id] ?? EMPTY_BETS);
  const isAdmin = useBettingStore((s) => s.isAdmin);
  const now = useServerNow();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The creator is the Referee: they settle the market and can never bet on it.
  const isReferee = userId !== null && market.creatorId === userId;
  const myTotal = betsTotal(myBets);
  // A user backs only one side per market.
  const backedSide: OptionId | null = myBets[0]?.optionId ?? null;
  const bettingOpen = market.status === "OPEN" && (market.expiresAt === null || now < market.expiresAt);
  const resolved = market.status === "SETTLED" || market.status === "VOID";

  const run = async (action: () => Promise<Ack>) => {
    setPending(true);
    setError(null);
    const res = await action();
    setPending(false);
    if (!res.ok) setError(res.error);
  };

  // Implied chance of A from the current odds (fair odds, so 1/A + 1/B ≈ 1).
  const shareA = (1 / market.odds.A / (1 / market.odds.A + 1 / market.odds.B)) * 100;

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
              Referee {isReferee ? "you" : market.creatorName} · {market.bettorCount} {market.bettorCount === 1 ? "bettor" : "bettors"}
            </span>
          </div>
          <h3 className="text-base font-semibold leading-snug text-zinc-100 sm:text-lg">{market.title}</h3>
        </div>
        <Timer market={market} now={now} />
      </div>

      {/* Live event counter (optional, kept by the Referee) */}
      <EventCounter market={market} isReferee={isReferee} onError={setError} />

      {/* Current fixed odds; the bar shows the implied chance */}
      <div className="mt-4">
        <div className="mb-1.5 flex justify-between text-sm">
          {(["A", "B"] as const).map((id) => (
            <div key={id} className={id === "B" ? "text-right" : undefined}>
              <span className={`font-semibold ${OPTION_STYLE[id].text}`}>
                {optionLabel(market, id)}
                {market.winningOption === id && " ✓"}
              </span>
              <span className="ml-2 font-mono text-zinc-300 tabular-nums">{formatOdds(market.odds[id])}</span>
              <div className="font-mono text-xs text-zinc-500 tabular-nums">{formatPts(market.pools[id])} pts staked</div>
            </div>
          ))}
        </div>
        <div className="flex h-3 overflow-hidden rounded-full bg-zinc-800" role="img" aria-label={`${Math.round(shareA)}% implied chance for ${optionLabel(market, "A")}`}>
          <div className={`${OPTION_STYLE.A.bar} transition-[width] duration-700 ease-out`} style={{ width: `${shareA}%` }} />
          <div className={`${OPTION_STYLE.B.bar} flex-1 transition-[width] duration-700 ease-out`} />
        </div>
        <div className="mt-1 flex justify-between font-mono text-xs text-zinc-500 tabular-nums">
          <span>{Math.round(shareA)}%</span>
          <span>Total staked {formatPts(market.totalPool)} pts</span>
          <span>{100 - Math.round(shareA)}%</span>
        </div>
      </div>

      {/* Quick bets */}
      {bettingOpen && !isReferee && (
        <div className="mt-4 grid gap-2">
          {(["A", "B"] as const)
            .filter((id) => backedSide === null || backedSide === id)
            .map((id) => (
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
                    title={`Bet ${amt} pts at ${formatOdds(market.odds[id])}: pays ${payoutAt(amt, market.odds[id])} pts if ${optionLabel(market, id)} wins`}
                    className={`flex-1 rounded-lg border px-2 py-1 font-mono text-sm font-semibold leading-tight transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 ${OPTION_STYLE[id].btn}`}
                  >
                    +{amt}
                    <span className="block text-[10px] font-normal opacity-70">pays {formatPts(payoutAt(amt, market.odds[id]))}</span>
                  </button>
                ))}
              </div>
            ))}
          {backedSide !== null && (
            <p className="text-[11px] text-zinc-500">
              You backed {optionLabel(market, backedSide)}, so you can only add to that side. Each bet keeps the odds it got.
            </p>
          )}
        </div>
      )}

      {/* My position */}
      {myTotal > 0 && <MyPosition market={market} bets={myBets} />}

      {/* Referee */}
      <RefereePanel
        market={market}
        now={now}
        isReferee={isReferee}
        pending={pending}
        onCloseBetting={() => run(() => closeBetting(market.id))}
        onSettle={(winner) => run(() => settleMarket(market.id, winner))}
      />

      {isAdmin && !resolved && <AdminMarketTools market={market} isReferee={isReferee} />}

      {error && <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
    </article>
  );
}

function EventCounter({
  market,
  isReferee,
  onError,
}: {
  market: Market;
  isReferee: boolean;
  onError: (error: string | null) => void;
}) {
  const active = market.status === "OPEN" || market.status === "LOCKED";
  const canCount = isReferee && active;
  // Bettors only see it once the Referee has started counting.
  if (market.eventCount === null && !canCount) return null;
  const count = market.eventCount ?? 0;

  // Not disabled while a tap is in flight, so quick successive taps all count.
  const onTap = async () => {
    onError(null);
    const res = await countEvent(market.id);
    if (!res.ok) onError(res.error);
  };

  return (
    <div className="mt-3 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">
          {active ? "Happened so far" : "Final count"}
        </div>
        {canCount && market.eventCount === null && (
          <div className="text-[11px] text-zinc-500">Optional: tap + each time it happens so bettors can follow along.</div>
        )}
      </div>
      <span
        className="font-mono text-2xl font-bold tabular-nums text-zinc-100"
        aria-live="polite"
        aria-label={`Happened ${count} ${count === 1 ? "time" : "times"} so far`}
      >
        {count}×
      </span>
      {canCount && (
        <button
          type="button"
          onClick={onTap}
          aria-label="Count one more occurrence"
          className="h-10 w-12 shrink-0 rounded-lg border border-amber-400/40 bg-amber-400/10 text-xl font-bold text-amber-200 transition hover:bg-amber-400/20 active:scale-90"
        >
          +1
        </button>
      )}
    </div>
  );
}

function Timer({ market, now }: { market: Market; now: number }) {
  const noLimit = market.expiresAt === null;
  if (market.status === "OPEN" && noLimit) {
    return (
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">Betting</div>
        <div className="text-sm font-bold text-zinc-100">No time limit</div>
      </div>
    );
  }
  if (market.status === "OPEN" && market.expiresAt !== null) {
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
        <div className="text-[10px] uppercase tracking-wider text-amber-500/80">
          {noLimit ? "Auto-refund in" : "Ruling due"}
        </div>
        <div className="font-mono text-xl font-bold tabular-nums text-amber-300">
          {formatCountdown(market.settleDeadline - now)}
        </div>
      </div>
    );
  }
  return null;
}

function MyPosition({ market, bets }: { market: Market; bets: PlacedBet[] }) {
  const total = betsTotal(bets);
  const side = bets[0].optionId;
  let outcome: ReactNode;

  if (market.status === "SETTLED") {
    const net = settledPayout(market, bets) - total;
    outcome = (
      <span className={net >= 0 ? "text-emerald-300" : "text-rose-300"}>
        {net >= 0 ? "+" : "−"}
        {formatPts(Math.abs(net))} pts net
      </span>
    );
  } else if (market.status === "VOID") {
    outcome = <span className="text-zinc-300">{formatPts(total)} pts refunded</span>;
  } else {
    outcome = (
      <span className="text-zinc-300">
        pays {formatPts(payoutIf(bets, side))} if {optionLabel(market, side)} wins
      </span>
    );
  }

  return (
    <div className="mt-3 rounded-lg bg-zinc-950/60 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-zinc-400">
          Your bets: <span className="font-mono font-semibold text-zinc-200">{formatPts(total)} pts</span>
        </span>
        <span className="font-mono font-semibold">{outcome}</span>
      </div>
      <ul className="mt-1.5 space-y-0.5 font-mono tabular-nums">
        {bets.map((b) => (
          <li key={b.id} className="flex justify-between gap-2 text-zinc-500">
            <span className={OPTION_STYLE[b.optionId].text}>
              {formatPts(b.amount)} on {optionLabel(market, b.optionId)}
            </span>
            <span>
              @ {formatOdds(b.odds)} → {formatPts(payoutAt(b.amount, b.odds))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface RefereePanelProps {
  market: Market;
  now: number;
  isReferee: boolean;
  pending: boolean;
  onCloseBetting: () => void;
  onSettle: (winner: OptionId) => void;
}

function RefereePanel({ market, now, isReferee, pending, onCloseBetting, onSettle }: RefereePanelProps) {
  const [selected, setSelected] = useState<OptionId | null>(null);

  if (market.status === "SETTLED") {
    return (
      <div className="mt-4 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
        Settled by referee <span className="font-medium text-zinc-200">{market.creatorName}</span> · winner{" "}
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

  // Someone else created this market, so they referee it.
  if (!isReferee) {
    return (
      <div className="mt-4 flex items-center gap-2 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
        <span className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-semibold text-zinc-300">
          Referee
        </span>
        <span className="truncate">{market.creatorName}</span>
        {market.status === "LOCKED" && <span className="ml-auto text-amber-300/80">awaiting ruling…</span>}
      </div>
    );
  }

  // You created this market, so you referee it.
  const bounty = Math.round(market.totalPool * 0.05);
  return (
    <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-md bg-amber-400 px-1.5 py-0.5 text-[10px] font-black tracking-wider text-zinc-950">
          YOU ARE REFEREE
        </span>
        <span className="font-mono text-xs text-amber-200/80">your bounty ≈ +{formatPts(bounty)} pts</span>
      </div>
      <p className="mt-2 text-xs text-zinc-400">{refereeHint(market, now)}</p>
      {market.status === "OPEN" && market.expiresAt === null && (
        <button
          type="button"
          disabled={pending}
          onClick={onCloseBetting}
          className="mt-2 w-full rounded-lg border border-zinc-600 bg-zinc-800 py-1.5 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-700 disabled:opacity-40"
        >
          Close betting
        </button>
      )}
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

function refereeHint(market: Market, now: number): string {
  const deadline = market.settleDeadline !== null ? formatCountdown(market.settleDeadline - now) : null;
  if (market.expiresAt === null) {
    return market.status === "OPEN"
      ? `No time limit: close betting once the outcome gets predictable, then declare it. Unsettled markets refund everyone in ${deadline}.`
      : `Betting closed. Declare the outcome once it's known (within ${deadline}, or everyone is refunded).`;
  }
  return market.status === "LOCKED" && deadline
    ? `Betting closed. Declare the outcome within ${deadline} or the market is voided.`
    : "You created this market, so you can't bet on it. Declare the outcome once it happens — settling ends betting immediately.";
}
