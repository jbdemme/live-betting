"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { Ack, LeaderboardEntry } from "@/lib/types";
import { adminAdjustBalance, adminLogin, adminLogout, adminRemoveUser, adminRenameUser } from "@/lib/socket";
import { useBettingStore } from "@/store/useBettingStore";
import { formatPts } from "@/lib/format";

interface AdminModalProps {
  open: boolean;
  onClose: () => void;
}

/** Admin login (when not admin) or user management (when admin). Market tools live on each MarketCard. */
export default function AdminModal({ open, onClose }: AdminModalProps) {
  const isAdmin = useBettingStore((s) => s.isAdmin);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-title"
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="admin-title" className="text-lg font-bold text-zinc-100">
            {isAdmin ? "Admin · Users" : "Admin login"}
          </h2>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-300" aria-label="Close">
            ✕
          </button>
        </div>
        {isAdmin ? <UserManager onLoggedOut={onClose} /> : <LoginForm />}
      </div>
    </div>
  );
}

function LoginForm() {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await adminLogin(password);
    setPending(false);
    if (!res.ok) setError(res.error);
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
        required
        placeholder="Admin password"
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500"
      />
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-violet-500 py-2.5 font-semibold text-white transition hover:bg-violet-400 disabled:opacity-40"
      >
        {pending ? "Checking…" : "Log in as admin"}
      </button>
      <p className="text-xs text-zinc-500">This browser stays admin until you log out.</p>
    </form>
  );
}

function UserManager({ onLoggedOut }: { onLoggedOut: () => void }) {
  const entries = useBettingStore((s) => s.leaderboard);
  const [filter, setFilter] = useState("");
  const shown = entries.filter((e) => e.username.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={`Search ${entries.length} users`}
        className="mb-3 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500"
      />
      <ul className="-mr-1 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {shown.map((e) => (
          <UserRow key={e.userId} entry={e} />
        ))}
        {shown.length === 0 && <li className="py-6 text-center text-sm text-zinc-500">No users found.</li>}
      </ul>
      <p className="mt-3 text-xs text-zinc-500">
        To void a market or a single bet, or to close/settle any market, use the violet Admin box on each market card.
      </p>
      <button
        type="button"
        onClick={() => {
          void adminLogout();
          onLoggedOut();
        }}
        className="mt-3 w-full rounded-lg border border-zinc-700 py-2 text-sm font-semibold text-zinc-300 transition hover:bg-zinc-800"
      >
        Log out of admin
      </button>
    </>
  );
}

function UserRow({ entry }: { entry: LeaderboardEntry }) {
  const myId = useBettingStore((s) => s.currentUser?.id ?? null);
  const [mode, setMode] = useState<"none" | "points" | "rename">("none");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [name, setName] = useState(entry.username);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<Ack<unknown>>) => {
    setPending(true);
    setError(null);
    const res = await action();
    setPending(false);
    if (res.ok) {
      setMode("none");
      setAmount("");
      setReason("");
    } else setError(res.error);
  };

  const adjust = (sign: 1 | -1) => {
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0) return setError("Enter a positive whole number");
    void run(() => adminAdjustBalance({ userId: entry.userId, delta: sign * n, reason: reason.trim() || undefined }));
  };

  const remove = () => {
    if (!window.confirm(`Remove ${entry.username}? Their bets in open markets are cancelled and their balance is deleted.`)) return;
    void run(() => adminRemoveUser(entry.userId));
  };

  const btn = "rounded-md border border-zinc-700 px-2 py-1 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40";

  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${entry.online ? "bg-emerald-400" : "bg-zinc-700"}`} />
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">
          {entry.username}
          {entry.userId === myId && <span className="ml-1 text-xs text-indigo-300">(you)</span>}
        </span>
        <span className="font-mono text-sm tabular-nums text-emerald-300">{formatPts(entry.balance)}</span>
      </div>
      {entry.atStake > 0 && (
        <p className="ml-3.5 font-mono text-[10px] text-zinc-500">{formatPts(entry.atStake)} pts in open bets</p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" className={btn} onClick={() => setMode(mode === "points" ? "none" : "points")}>
          ± Points
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => {
            setName(entry.username);
            setMode(mode === "rename" ? "none" : "rename");
          }}
        >
          Rename
        </button>
        {entry.userId !== myId && (
          <button type="button" className={`${btn} border-rose-500/40 text-rose-300 hover:bg-rose-500/10`} disabled={pending} onClick={remove}>
            Remove
          </button>
        )}
      </div>

      {mode === "points" && (
        <div className="mt-2 space-y-1.5">
          <div className="flex gap-1.5">
            <input
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
              placeholder="Amount"
              className="w-24 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-sm text-zinc-100 outline-none focus:border-violet-500"
            />
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={80}
              placeholder="Reason (shown to user)"
              className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-violet-500"
            />
          </div>
          <div className="flex gap-1.5">
            <button type="button" disabled={pending} onClick={() => adjust(1)} className={`${btn} flex-1 border-emerald-500/40 text-emerald-300`}>
              + Add
            </button>
            <button type="button" disabled={pending} onClick={() => adjust(-1)} className={`${btn} flex-1 border-rose-500/40 text-rose-300`}>
              − Subtract
            </button>
          </div>
        </div>
      )}

      {mode === "rename" && (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => adminRenameUser(entry.userId, name));
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-violet-500"
          />
          <button type="submit" disabled={pending} className={btn}>
            Save
          </button>
        </form>
      )}

      {error && <p className="mt-2 rounded-md bg-rose-500/10 px-2 py-1 text-xs text-rose-300">{error}</p>}
    </li>
  );
}
