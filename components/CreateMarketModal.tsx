"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createMarket } from "@/lib/socket";

const DURATIONS: { label: string; seconds: number }[] = [
  { label: "30s", seconds: 30 },
  { label: "1m", seconds: 60 },
  { label: "2m", seconds: 120 },
  { label: "5m", seconds: 300 },
  { label: "10m", seconds: 600 },
];

const TEMPLATES = [
  "Prof reaches Slide 15 by 10:30",
  "Prof says 'essentially' 5+ times",
  "Someone's phone rings during lecture",
  "Lecture ends early",
];

interface CreateMarketModalProps {
  open: boolean;
  onClose: () => void;
}

export default function CreateMarketModal({ open, onClose }: CreateMarketModalProps) {
  if (!open) return null;
  // Mount fresh each time so the form state resets.
  return <CreateMarketForm onClose={onClose} />;
}

function CreateMarketForm({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [optionA, setOptionA] = useState("Yes");
  const [optionB, setOptionB] = useState("No");
  const [durationSec, setDurationSec] = useState(120);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await createMarket({ title, optionA, optionB, durationSec });
    setPending(false);
    if (res.ok) onClose();
    else setError(res.error);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-market-title"
        className="w-full max-w-md space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 id="create-market-title" className="text-lg font-semibold text-zinc-100">
            Create a micro-market
          </h2>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-300" aria-label="Close">
            ✕
          </button>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">Question</span>
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            required
            placeholder="Prof reaches Slide 15 by 10:30"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-500"
          />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {TEMPLATES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTitle(t)}
              className="rounded-full border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
            >
              {t}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-sky-400">Option A</span>
            <input
              value={optionA}
              onChange={(e) => setOptionA(e.target.value)}
              maxLength={32}
              required
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-sky-500"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-fuchsia-400">Option B</span>
            <input
              value={optionB}
              onChange={(e) => setOptionB(e.target.value)}
              maxLength={32}
              required
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-fuchsia-500"
            />
          </label>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium uppercase tracking-wide text-zinc-400">Betting window</legend>
          <div className="mt-1.5 flex gap-1.5">
            {DURATIONS.map((d) => (
              <button
                key={d.seconds}
                type="button"
                onClick={() => setDurationSec(d.seconds)}
                aria-pressed={durationSec === d.seconds}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-sm font-medium transition ${
                  durationSec === d.seconds
                    ? "border-indigo-500 bg-indigo-500/15 text-indigo-200"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-zinc-500">
            A Referee must claim the market before betting closes, then has 60s to declare the winner — otherwise all
            wagers are refunded.
          </p>
        </fieldset>

        {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-lg bg-indigo-500 py-2.5 font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
        >
          {pending ? "Creating…" : "Open market"}
        </button>
      </form>
    </div>
  );
}
