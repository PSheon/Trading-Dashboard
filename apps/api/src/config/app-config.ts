import type { RuntimeConfig } from "./runtime-config.js";

function freeze(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  Object.freeze(value);
}

/** One validated snapshot per application. Secrets must never be logged. */
export class AppConfig {
  readonly value: RuntimeConfig;
  constructor(value: RuntimeConfig) {
    this.value = structuredClone(value);
    freeze(this.value);
  }
}
