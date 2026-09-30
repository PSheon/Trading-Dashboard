import { AsyncLocalStorage } from "node:async_hooks";

interface RequestStore {
  /** Aborts when the request's deadline passes or the client disconnects
   * before the answer is complete: in-flight upstream calls stop. */
  signal: AbortSignal;
  requestId?: string;
  /** Also aborts once the answer has been sent: work still waiting for its
   * turn (the Hyperliquid budget queue) no longer has anyone to serve. */
  answered?: AbortSignal;
  /** The caller's `clientKey` bucket, for per-client limits. */
  client?: string;
}

const requests = new AsyncLocalStorage<RequestStore>();
export const currentRequestSignal = () => requests.getStore()?.signal;
export const currentRequestId = () => requests.getStore()?.requestId;
/** Aborts when the current request has been answered or abandoned. */
export const currentRequestAnswered = () => { const store = requests.getStore(); return store?.answered ?? store?.signal; };
export const currentRequestClient = () => requests.getStore()?.client;
export const withRequestSignal = <T>(signal: AbortSignal, work: () => T, requestId?: string, extra: Pick<RequestStore, "answered" | "client"> = {}): T =>
  requests.run({ signal, requestId, ...extra }, work);
export const outsideRequest = <T>(work: () => T): T => requests.exit(work);
