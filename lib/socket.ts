import { io, type Socket } from "socket.io-client";
import type {
  Ack,
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
    const { setStake, setBalance } = useBettingStore.getState();
    setStake(marketId, res.data.stake);
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
