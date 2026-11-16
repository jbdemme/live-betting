import { io, type Socket } from "socket.io-client";
import type {
  Ack,
  AdminAdjustPayload,
  AdminMarketBets,
  AdminVoidBetPayload,
  ClientToServerEvents,
  CreateMarketPayload,
  Market,
  OptionId,
  ServerToClientEvents,
} from "@/lib/types";
import { useBettingStore } from "@/store/useBettingStore";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Where the betting engine lives. In development it's the standalone `node server.js` on :4000;
 * in production `app-server.js` serves it on the same origin as the page (undefined = same origin).
 */
export const SOCKET_URL: string | undefined =
  process.env.NEXT_PUBLIC_SOCKET_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:4000" : undefined);
const ACK_TIMEOUT_MS = 5000;

let socket: AppSocket | null = null;

/** Lazily-created singleton so React StrictMode double-mounts don't open two connections. */
export function getSocket(): AppSocket {
  if (!socket) {
    const opts = { autoConnect: false };
    socket = SOCKET_URL ? io(SOCKET_URL, opts) : io(opts);
  }
  return socket;
}

function failure(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : "Request failed" };
}

// ---------------------------------------------------------------------------
// Client -> server actions. Each resolves with the server's Ack and applies
// the result to the store; broadcasts handle everyone else's view.
// ---------------------------------------------------------------------------

export async function createMarket(payload: CreateMarketPayload): Promise<Ack<Market>> {
  try {
    return await getSocket().timeout(ACK_TIMEOUT_MS).emitWithAck("CREATE_MARKET", payload);
  } catch (err) {
    return failure(err);
  }
}

export async function placeBet(marketId: string, optionId: OptionId, amount: number): Promise<Ack> {
  try {
    const res = await getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck("PLACE_BET", { marketId, optionId, amount });
    if (!res.ok) return res;
    const { setMyBets, setBalance } = useBettingStore.getState();
    setMyBets(marketId, res.data.bets);
    setBalance(res.data.balance);
    return { ok: true, data: null };
  } catch (err) {
    return failure(err);
  }
}

export async function closeBetting(marketId: string): Promise<Ack> {
  try {
    return await getSocket().timeout(ACK_TIMEOUT_MS).emitWithAck("CLOSE_BETTING", { marketId });
  } catch (err) {
    return failure(err);
  }
}

export async function settleMarket(marketId: string, winningOption: OptionId): Promise<Ack> {
  try {
    return await getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck("SETTLE_MARKET", { marketId, winningOption });
  } catch (err) {
    return failure(err);
  }
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const ADMIN_TOKEN_KEY = "live-betting:admin-token";

export function loadAdminToken(): string | undefined {
  try {
    return window.localStorage.getItem(ADMIN_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveAdminToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else window.localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // Storage unavailable: admin lasts until the page reloads.
  }
}

export async function adminLogin(password: string): Promise<Ack> {
  try {
    const res = await getSocket().timeout(ACK_TIMEOUT_MS).emitWithAck("ADMIN_LOGIN", { password });
    if (!res.ok) return res;
    saveAdminToken(res.data.token);
    useBettingStore.getState().setIsAdmin(true);
    return { ok: true, data: null };
  } catch (err) {
    return failure(err);
  }
}

export async function adminLogout(): Promise<void> {
  saveAdminToken(null);
  useBettingStore.getState().setIsAdmin(false);
  try {
    await getSocket().timeout(ACK_TIMEOUT_MS).emitWithAck("ADMIN_LOGOUT", {});
  } catch {
    // The token is gone locally; the server drops admin on the next connect anyway.
  }
}

export async function adminAdjustBalance(payload: AdminAdjustPayload): Promise<Ack<{ balance: number }>> {
  try {
    return await getSocket().timeout(ACK_TIMEOUT_MS).emitWithAck("ADMIN_ADJUST_BALANCE", payload);
  } catch (err) {
    return failure(err);
  }
}

export async function adminRenameUser(userId: string, username: string): Promise<Ack> {
  try {
    return await getSocket().timeout(ACK_TIMEOUT_MS).emitWithAck("ADMIN_RENAME_USER", { userId, username });
  } catch (err) {
    return failure(err);
  }
}

export async function adminRemoveUser(userId: string): Promise<Ack> {
  try {
    return await getSocket().timeout(ACK_TIMEOUT_MS).emitWithAck("ADMIN_REMOVE_USER", { userId });
  } catch (err) {
    return failure(err);
  }
}

export async function adminVoidMarket(marketId: string, reason?: string): Promise<Ack> {
  try {
    return await getSocket().timeout(ACK_TIMEOUT_MS).emitWithAck("ADMIN_VOID_MARKET", { marketId, reason });
  } catch (err) {
    return failure(err);
  }
}

export async function adminVoidBet(payload: AdminVoidBetPayload): Promise<Ack> {
  try {
    return await getSocket().timeout(ACK_TIMEOUT_MS).emitWithAck("ADMIN_VOID_BET", payload);
  } catch (err) {
    return failure(err);
  }
}

export async function adminGetBets(marketId: string): Promise<Ack<AdminMarketBets>> {
  try {
    return await getSocket().timeout(ACK_TIMEOUT_MS).emitWithAck("ADMIN_GET_BETS", { marketId });
  } catch (err) {
    return failure(err);
  }
}
