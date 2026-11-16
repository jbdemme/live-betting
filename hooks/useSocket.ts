"use client";

import { useEffect } from "react";
import { getSocket, loadAdminToken } from "@/lib/socket";
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

/** Persist the identity. Users can't clear it (one user per browser); only an admin removing the account does. */
export function saveIdentity(identity: Identity | null): void {
  try {
    if (identity) window.localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    else window.localStorage.removeItem(IDENTITY_KEY);
  } catch {
    // Ignore storage failures; the session still works until refresh.
  }
}

/** Keep the stored name in sync with the server's (an admin may rename users). */
function syncStoredName(identity: Identity, username: string): void {
  // Storage only: changing the store's identity would reconnect the socket.
  if (identity.username !== username) saveIdentity({ userId: identity.userId, username });
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
      socket.emit("REGISTER_USER", { ...identity, adminToken: loadAdminToken() }, (res) => {
        if (res.ok) {
          syncStoredName(identity, res.data.user.username);
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
    socket.on("LEADERBOARD_UPDATE", (entries) => store().setLeaderboard(entries));
    socket.on("MY_BETS_UPDATE", ({ marketId, bets }) => store().setMyBets(marketId, bets));
    socket.on("USER_UPDATE", (user) => {
      syncStoredName(identity, user.username);
      store().setCurrentUser(user);
    });
    socket.on("ACCOUNT_REMOVED", () => {
      saveIdentity(null);
      store().setIsAdmin(false);
      store().setIdentity(null); // unmount: the cleanup below disconnects
    });

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
      socket.off("LEADERBOARD_UPDATE");
      socket.off("MY_BETS_UPDATE");
      socket.off("USER_UPDATE");
      socket.off("ACCOUNT_REMOVED");
      socket.disconnect();
    };
  }, [identity]);
}
