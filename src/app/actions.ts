"use server";

import { revalidatePath } from "next/cache";

import { type Activity, readActivity } from "@/lib/progress";
import type { JobState } from "@/lib/runner";
import { server } from "@/lib/server";
import { ADD_MAX_ADDRESSES, NOTE_MAX_CHARS } from "@/lib/universe";
import { addWallets, loadWallets, VIA } from "@/lib/wallets";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function saveNote(address: string, note: string): Promise<{ note: string } | { error: string }> {
  const { ctx, notes } = server();
  if (note.length > NOTE_MAX_CHARS) return { error: `notes are limited to ${NOTE_MAX_CHARS} characters` };
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
  // Every new wallet costs a 180-day backfill in Helius credits.
  if (candidates.length > ADD_MAX_ADDRESSES) return { error: `at most ${ADD_MAX_ADDRESSES} addresses at a time` };
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

/** The latest run's progress, whoever started it (page, schedule or CLI). */
export async function getActivity(): Promise<Activity | null> {
  return readActivity(server().ctx.settings.dataDir);
}
