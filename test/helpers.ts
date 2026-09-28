import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Warehouse } from "../src/lib/store";

export function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "sw-test-"));
}

export function tmpWarehouse(): Warehouse {
  return new Warehouse(path.join(tmpDir(), "warehouse"));
}
