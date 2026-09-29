import { AsyncLocalStorage } from "node:async_hooks";

const requests = new AsyncLocalStorage<{ signal: AbortSignal; requestId?: string }>();
export const currentRequestSignal = () => requests.getStore()?.signal;
export const currentRequestId = () => requests.getStore()?.requestId;
export const withRequestSignal = <T>(signal: AbortSignal, work: () => T, requestId?: string): T => requests.run({ signal, requestId }, work);
export const outsideRequest = <T>(work: () => T): T => requests.exit(work);
