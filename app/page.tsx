"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { v4 as uuidv4 } from "uuid";
import Navbar from "@/components/Navbar";
import MarketCard from "@/components/MarketCard";
import CreateMarketModal from "@/components/CreateMarketModal";
import Toasts from "@/components/Toasts";
import { loadIdentity, saveIdentity, useSocket } from "@/hooks/useSocket";
import { SOCKET_URL } from "@/lib/socket";
import { selectActiveMarkets, selectResolvedMarkets, useBettingStore } from "@/store/useBettingStore";

export default function Home() {
  const identity = useBettingStore((s) => s.identity);
  const identityLoaded = useBettingStore((s) => s.identityLoaded);
  const setIdentity = useBettingStore((s) => s.setIdentity);
  const [createOpen, setCreateOpen] = useState(false);

  // Hydrate identity from localStorage after mount (not available during SSR).
  useEffect(() => {
    setIdentity(loadIdentity());
  }, [setIdentity]);

  useSocket(identity);

  const signOut = useCallback(() => {
    saveIdentity(null);
    setIdentity(null);
  }, [setIdentity]);

  const closeCreate = useCallback(() => setCreateOpen(false), []);

  if (!identityLoaded) return <main className="flex-1" />;
  if (!identity) return <JoinScreen />;

  return (
    <>
      <Navbar onCreateMarket={() => setCreateOpen(true)} onSignOut={signOut} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <MarketFeed onCreate={() => setCreateOpen(true)} />
      </main>
      <CreateMarketModal open={createOpen} onClose={closeCreate} />
      <Toasts />
    </>
  );
}

function MarketFeed({ onCreate }: { onCreate: () => void }) {
  const markets = useBettingStore((s) => s.markets);
  const connection = useBettingStore((s) => s.connection);
  const active = useMemo(() => selectActiveMarkets(markets), [markets]);
  const resolved = useMemo(() => selectResolvedMarkets(markets), [markets]);

  return (
    <div className="space-y-8">
      {connection === "disconnected" && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Can&apos;t reach the betting engine at <code className="font-mono">{SOCKET_URL}</code>. Is{" "}
          <code className="font-mono">node server.js</code> running? Retrying…
        </div>
      )}

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Live markets <span className="ml-1 text-zinc-600">{active.length}</span>
          </h2>
        </div>
        {active.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-800 px-6 py-12 text-center">
            <p className="text-zinc-400">No live markets right now.</p>
            <button
              type="button"
              onClick={onCreate}
              disabled={connection !== "connected"}
              className="mt-3 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-40"
            >
              Create the first one
            </button>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {active.map((m) => (
              <MarketCard key={m.id} market={m} />
            ))}
          </div>
        )}
      </section>

      {resolved.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">Recently resolved</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {resolved.map((m) => (
              <MarketCard key={m.id} market={m} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function JoinScreen() {
  const setIdentity = useBettingStore((s) => s.setIdentity);
  const [username, setUsername] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    if (!name) return;
    const identity = { userId: uuidv4(), username: name };
    saveIdentity(identity);
    setIdentity(identity);
  };

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <div>
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-500 font-black text-white">LB</span>
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-zinc-100">Lecture Bets</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Predict what happens in this lecture. You start with{" "}
            <span className="font-mono text-emerald-300">1,000 pts</span> of play money.
          </p>
        </div>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          maxLength={24}
          autoFocus
          required
          placeholder="Pick a username"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-500"
        />
        <button
          type="submit"
          className="w-full rounded-lg bg-indigo-500 py-2.5 font-semibold text-white transition hover:bg-indigo-400"
        >
          Join lecture
        </button>
      </form>
    </main>
  );
}
