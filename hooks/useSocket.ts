"use client";

import { useEffect } from "react";
import { getSocket } from "@/lib/socket";
import { useBettingStore, type Identity } from "@/store/useBettingStore";

const IDENTITY_KEY = "live-betting:identity";

/** Read the persisted identity once on the client. */
export function loadIdentity(): Identity | null {
  try {
    const raw = window.localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "userId" in parsed &&
      "username" in parsed &&
      typeof parsed.userId === "string" &&
      typeof parsed.username === "string"
    ) {
      return { userId: parsed.userId, username: parsed.username };
    }
  } catch {
    // Storage unavailable or corrupt: fall through to a fresh identity.
  }
  return null;
}

/** Persist the identity. There is deliberately no way to clear it: one user per browser. */
export function saveIdentity(identity: Identity): void {
  try {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // Ignore storage failures; the session still works until refresh.
  }
}

/**
 * Owns the Socket.io connection lifecycle for the given identity:
 * connects, (re-)registers on every connect, and mirrors server broadcasts into the store.
 */
export function useSocket(identity: Identity | null): void {
  useEffect(() => {
    if (!identity) return;

    const socket = getSocket();
    const store = useBettingStore.getState;

    const register = () => {
      socket.emit("REGISTER_USER", identity, (res) => {
        if (res.ok) {
          store().applySession(res.data);
          store().setConnection("connected");
        } else {
          console.error("REGISTER_USER failed:", res.error);
          store().setConnection("disconnected");
        }
      });
    };

    const onDisconnect = () => store().setConnection("disconnected");
    const onConnectError = () => store().setConnection("disconnected");

    socket.on("connect", register);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("MARKET_CREATED", (m) => store().upsertMarket(m));
    socket.on("MARKET_UPDATED", (m) => store().upsertMarket(m));
    socket.on("MARKET_SETTLED", (m) => store().upsertMarket(m));
    socket.on("MARKET_VOIDED", (m) => store().upsertMarket(m));
    socket.on("ODDS_UPDATE", (u) => store().applyOdds(u));
    socket.on("BALANCE_UPDATE", ({ balance }) => store().setBalance(balance));
    socket.on("PAYOUT", (notice) => store().pushToast(notice));

    store().setConnection("connecting");
    if (socket.connected) register();
    else socket.connect();

    return () => {
      socket.off("connect", register);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("MARKET_CREATED");
      socket.off("MARKET_UPDATED");
      socket.off("MARKET_SETTLED");
      socket.off("MARKET_VOIDED");
      socket.off("ODDS_UPDATE");
      socket.off("BALANCE_UPDATE");
      socket.off("PAYOUT");
      socket.disconnect();
    };
  }, [identity]);
}
