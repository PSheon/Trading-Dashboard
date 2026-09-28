// Process-wide state for the Next.js server: one context, one notes database,
// one job runner. Kept on globalThis so dev-mode reloads do not duplicate them.

import { type Context, context, notesFor } from "./context";
import { daily } from "./jobs";
import type { Notes } from "./notes";
import { JobRunner } from "./runner";

interface ServerState {
  ctx: Context;
  notes: Notes;
  runner: JobRunner;
}

const holder = globalThis as unknown as { __smartwalletServer?: ServerState };

export function server(): ServerState {
  if (!holder.__smartwalletServer) {
    const ctx = context();
    holder.__smartwalletServer = {
      ctx,
      notes: notesFor(ctx),
      runner: new JobRunner(() =>
        daily(ctx.wh, ctx.helius(), ctx.rawDir, {
          now: Math.floor(Date.now() / 1000),
          dune: ctx.dune(),
          creditBudget: ctx.creditBudget,
        }),
      ),
    };
  }
  return holder.__smartwalletServer;
}
