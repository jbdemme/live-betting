"use client";

import { useEffect } from "react";
import { useBettingStore, type Toast } from "@/store/useBettingStore";
import { formatPts } from "@/lib/format";

const KIND_STYLE: Record<Toast["kind"], { label: string; cls: string; sign: string }> = {
  WIN: { label: "You won", cls: "border-emerald-500/40 text-emerald-200", sign: "+" },
  LOSS: { label: "You lost", cls: "border-rose-500/40 text-rose-200", sign: "−" },
  REFUND: { label: "Refunded", cls: "border-zinc-600 text-zinc-200", sign: "+" },
  BOUNTY: { label: "Referee bounty", cls: "border-amber-400/40 text-amber-200", sign: "+" },
};

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useBettingStore((s) => s.dismissToast);

  useEffect(() => {
    const id = window.setTimeout(() => dismiss(toast.id), 5000);
    return () => window.clearTimeout(id);
  }, [dismiss, toast.id]);

  const style = KIND_STYLE[toast.kind];
  return (
    <button
      type="button"
      onClick={() => dismiss(toast.id)}
      className={`w-72 rounded-xl border bg-zinc-900/95 px-4 py-3 text-left shadow-xl backdrop-blur ${style.cls}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{style.label}</span>
        <span className="font-mono text-sm font-bold tabular-nums">
          {style.sign}
          {formatPts(toast.amount)} pts
        </span>
      </div>
      <p className="mt-0.5 truncate text-xs text-zinc-400">{toast.title}</p>
    </button>
  );
}

export default function Toasts() {
  const toasts = useBettingStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col gap-2 [&>*]:pointer-events-auto" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
