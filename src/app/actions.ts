"use server";

import { revalidatePath } from "next/cache";

import type { JobState } from "@/lib/runner";
import { server } from "@/lib/server";
import { addWallets, loadWallets, VIA } from "@/lib/wallets";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function saveNote(address: string, note: string): Promise<{ note: string } | { error: string }> {
  const { ctx, notes } = server();
  if (!(await loadWallets(ctx.wh)).some((w) => w.address === address)) return { error: "unknown wallet" };
  const saved = notes.set(address, note);
  revalidatePath("/");
  return { note: saved.note };
}

export async function addWalletsAction(
  text: string,
  via: string,
): Promise<{ added: string[]; alreadyKnown: number } | { error: string }> {
  if (!VIA.includes(via as (typeof VIA)[number])) return { error: `source must be one of ${VIA.join(", ")}` };
  const candidates = text.split(/[\s,]+/).filter(Boolean);
  const invalid = candidates.filter((a) => !ADDRESS.test(a));
  if (invalid.length) return { error: `not Solana addresses: ${invalid.slice(0, 5).join(", ")}` };
  const added = await addWallets(server().ctx.wh, candidates, { via, now: Math.floor(Date.now() / 1000) });
  revalidatePath("/");
  return { added, alreadyKnown: new Set(candidates).size - added.length };
}

export async function runDailyJob(): Promise<{ started: boolean; state: JobState }> {
  const { runner } = server();
  const started = runner.start();
  return { started, state: { ...runner.state } };
}

export async function getJobState(): Promise<JobState> {
  return { ...server().runner.state };
}
