"use client";

import { useBettingStore } from "@/store/useBettingStore";
import { formatPts } from "@/lib/format";

const RANK_STYLE: Record<number, string> = {
  1: "bg-amber-400 text-zinc-950",
  2: "bg-zinc-300 text-zinc-950",
  3: "bg-orange-700 text-orange-50",
};

/** All players ranked by balance + points at stake in unresolved markets. */
export default function Leaderboard() {
  const entries = useBettingStore((s) => s.leaderboard);
  const myId = useBettingStore((s) => s.currentUser?.id ?? null);
  const myIndex = entries.findIndex((e) => e.userId === myId);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4" aria-labelledby="leaderboard-title">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="leaderboard-title" className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
          Leaderboard <span className="ml-1 text-zinc-600">{entries.length}</span>
        </h2>
        {myIndex >= 0 && <span className="text-xs text-zinc-400">You&apos;re #{myIndex + 1}</span>}
      </div>
      <p className="mb-3 text-[11px] text-zinc-500">Ranked by balance + points in open bets.</p>

      {entries.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">No players yet.</p>
      ) : (
        <ol className="max-h-[70vh] space-y-1 overflow-y-auto pr-1">
          {entries.map((e, i) => {
            const rank = i + 1;
            const isMe = e.userId === myId;
            return (
              <li
                key={e.userId}
                className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm ${
                  isMe ? "bg-indigo-500/15 ring-1 ring-indigo-500/40" : ""
                }`}
              >
                <span
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-xs font-bold ${
                    RANK_STYLE[rank] ?? "text-zinc-500"
                  }`}
                >
                  {rank}
                </span>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${e.online ? "bg-emerald-400" : "bg-zinc-700"}`}
                  title={e.online ? "Online" : "Offline"}
                />
                <span className={`min-w-0 flex-1 truncate ${isMe ? "font-semibold text-zinc-100" : "text-zinc-300"}`}>
                  {e.username}
                  {isMe && <span className="ml-1 text-xs text-indigo-300">(you)</span>}
                </span>
                <span className="text-right">
                  <span className="block font-mono font-semibold tabular-nums text-zinc-100">{formatPts(e.total)}</span>
                  {e.atStake > 0 && (
                    <span className="block font-mono text-[10px] tabular-nums text-zinc-500">
                      {formatPts(e.atStake)} in bets
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
