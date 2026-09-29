import { AsyncLocalStorage } from "node:async_hooks";

const requests = new AsyncLocalStorage<AbortSignal>();
export const currentRequestSignal = () => requests.getStore();
export const withRequestSignal = <T>(signal: AbortSignal, work: () => T): T => requests.run(signal, work);
export const outsideRequest = <T>(work: () => T): T => requests.exit(work);
