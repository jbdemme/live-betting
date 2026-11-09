"use client";

import { useBettingStore, type ConnectionStatus } from "@/store/useBettingStore";
import { formatPts } from "@/lib/format";

const CONNECTION_STYLE: Record<ConnectionStatus, { dot: string; label: string }> = {
  idle: { dot: "bg-zinc-500", label: "Offline" },
  connecting: { dot: "bg-amber-400 animate-pulse", label: "Connecting" },
  connected: { dot: "bg-emerald-400", label: "Live" },
  disconnected: { dot: "bg-rose-500 animate-pulse", label: "Reconnecting" },
};

interface NavbarProps {
  onCreateMarket: () => void;
  onSignOut: () => void;
}

export default function Navbar({ onCreateMarket, onSignOut }: NavbarProps) {
  const user = useBettingStore((s) => s.currentUser);
  const identity = useBettingStore((s) => s.identity);
  const connection = useBettingStore((s) => s.connection);
  const conn = CONNECTION_STYLE[connection];
  const username = user?.username ?? identity?.username ?? "";

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/85 backdrop-blur">
      <nav className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-500 text-sm font-black text-white">
            LB
          </span>
          <span className="hidden font-semibold tracking-tight text-zinc-100 sm:inline">Lecture Bets</span>
        </div>

        <span className="ml-1 flex items-center gap-1.5 text-xs text-zinc-400" title={`Socket: ${connection}`}>
          <span className={`h-2 w-2 rounded-full ${conn.dot}`} />
          <span className="hidden sm:inline">{conn.label}</span>
        </span>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <div
            className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 font-mono text-sm font-semibold text-emerald-300 tabular-nums"
            aria-label="Current balance"
          >
            {user ? formatPts(user.balance) : "—"} <span className="text-emerald-400/70">pts</span>
          </div>

          <button
            type="button"
            onClick={onCreateMarket}
            disabled={connection !== "connected"}
            className="rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="sm:hidden">+ Market</span>
            <span className="hidden sm:inline">+ Create Market</span>
          </button>

          <button
            type="button"
            onClick={onSignOut}
            title="Switch user"
            className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 py-1 pl-1 pr-3 text-sm text-zinc-200 transition hover:border-zinc-700"
          >
            <span className="grid h-6 w-6 place-items-center rounded-full bg-zinc-700 text-xs font-bold uppercase">
              {username.slice(0, 1) || "?"}
            </span>
            <span className="max-w-24 truncate">{username}</span>
          </button>
        </div>
      </nav>
    </header>
  );
}
