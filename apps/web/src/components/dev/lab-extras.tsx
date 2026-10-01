"use client";

import { Download } from "lucide-react";
import Link from "next/link";

import { MarkdownBlocks } from "@/components/content/markdown";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { exportFills } from "@/lib/csv-exports";
import type { Block } from "@/lib/markdown";
import type { BoardTrader } from "@/lib/contracts";
import { useHomeBoards, useTraderFills } from "@/lib/queries";

const METHODOLOGY = ["intro", "scope", "copyScore", "flow", "exclusions", "risk", "records", "history", "missing", "crowd"] as const;

/**
 * Orbie's own features that copydog.xyz doesn't have, kept off the user
 * pages (owner's rule) and reachable here: the performance methodology,
 * the about page's "numbers you can see" section, fills export to CSV, and
 * a pointer to the cohort tier picker on the lab's insights screen.
 */
export function LabExtras({ base, numbers }: { base: string; numbers: Block[] }) {
  const { t, locale } = useI18n();
  const en = locale === "en";
  const home = useHomeBoards();
  const sample = home.data?.featured[0] ?? home.data?.crypto[0] ?? null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-bold">{en ? "Fills export (CSV)" : "成交匯出（CSV）"}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {en ? "The trader page's export button, kept here: the sample is the first featured trader." : "交易員頁原本的匯出鈕；範例取首頁第一位精選交易員。"}
          {sample ? ` · ${sample.displayName ?? sample.address}` : ""}
        </p>
        {sample ? <FillsExport trader={sample} /> : null}
      </section>
      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-bold">{en ? "Cohort tier picker" : "洞察分層選單"}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {en ? "CopyDog serves 極度盈利 only; the other tiers' data stays in the api and the picker is on this lab's insights screen." : "CopyDog 只提供極度盈利；其他分層的資料仍在 api，選單放在本實驗室的洞察畫面。"}
        </p>
        <Link href={`${base}/insights`} className="mt-3 inline-block text-sm font-semibold text-primary underline underline-offset-2">
          {t("nav.insights")}
        </Link>
      </section>
      <section className="rounded-2xl border border-border bg-card p-6">
        <MarkdownBlocks blocks={numbers} className="[&_h2]:mt-0 [&_h2]:text-lg" />
      </section>
      <article className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-bold">{t("methodology.title")}</h2>
        {METHODOLOGY.map((key) => (
          <p key={key} className="text-sm leading-relaxed">{t(`methodology.${key}`)}</p>
        ))}
      </article>
    </div>
  );
}

/** Mounted once a sample trader is known, so no request goes out without an address. */
function FillsExport({ trader }: { trader: BoardTrader }) {
  const { t } = useI18n();
  const fills = useTraderFills(trader.address, 100);
  return (
    <Button className="mt-4" variant="secondary" disabled={!fills.data?.length} onClick={() => exportFills(trader.address, fills.data ?? [])}>
      <Download />
      {t("common.exportCsv")}
    </Button>
  );
}
