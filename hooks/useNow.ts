"use client";

import { useEffect, useState } from "react";
import { useBettingStore } from "@/store/useBettingStore";

/** Server-adjusted "now" (epoch ms), re-rendering every `intervalMs`. */
export function useServerNow(intervalMs = 250): number {
  const clockOffset = useBettingStore((s) => s.clockOffset);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return now + clockOffset;
}
