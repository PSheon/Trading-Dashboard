"use client";

import { ArrowDownLeft, ArrowUpRight, Bell } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { describeCopyEvent } from "@/components/copy/copy-feed";
import { useLeaders } from "@/components/copy/copy-portfolio";
import { PaperBadge } from "@/components/copy/paper-badge";
import { boardName } from "@/components/discover/board-bits";
import { Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import type { ActionFeedItem } from "@/lib/contracts";
import { useCopyEvents, useCopyOverview } from "@/lib/copy";
import { coinLabel, truncateAddress } from "@/lib/format";
import { useActions } from "@/lib/queries";
import { useWalletHistory } from "@/lib/wallet";

type Chip = "copies" | "following" | "deposits";

/** "Just now", "5m", "3h", "2d" (CopyDog's activity times). */
export function shortAgo(value: string | number | Date, t: (key: "feed.justNow") => string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (s < 60) return t("feed.justNow");
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function Row({ icon, title, subtitle, trail, href, onNavigate }: { icon: React.ReactNode; title: React.ReactNode; subtitle?: React.ReactNode; trail?: React.ReactNode; href?: string; onNavigate?: () => void }) {
  const body = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">{title}</span>
        {subtitle ? <span className="truncate text-xs text-muted-foreground">{subtitle}</span> : null}
      </span>
      {trail ? <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs">{trail}</span> : null}
    </>
  );
  return (
    <li>
      {href ? (
        <Link href={href} onClick={onNavigate} className="flex items-center gap-3 rounded-lg py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">{body}</Link>
      ) : (
        <div className="flex items-center gap-3 py-3">{body}</div>
      )}
    </li>
  );
}

function CoinBadge({ coin, down }: { coin: string; down: boolean }) {
  return (
    <span className="relative shrink-0">
      <CoinIcon coin={coin} size={40} />
      <span className={cn("absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full ring-2 ring-background", down ? "bg-negative" : "bg-positive")}>
        {down ? <ArrowDownLeft className="size-2.5 text-background" strokeWidth={3} /> : <ArrowUpRight className="size-2.5 text-background" strokeWidth={3} />}
      </span>
    </span>
  );
}

function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <Bell className="size-8 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <p className="mt-3 text-[0.9375rem] font-bold">{title}</p>
      {body ? <p className="mt-2 text-[0.8125rem] text-muted-foreground">{body}</p> : null}
    </div>
  );
}

function CopiesList() {
  const { t, format } = useI18n();
  const events = useCopyEvents();
  const overview = useCopyOverview();
  const leaders = useLeaders(overview.data?.strategies ?? []);
  const leaderOf = (strategyId: number | null) => {
    const s = overview.data?.strategies.find((x) => x.id === strategyId);
    return s ? boardName(leaders.get(s.leaderAddress) ?? { address: s.leaderAddress, displayName: null }) : null;
  };
  if (!events.data) return events.isError ? <p className="py-8 text-center text-sm text-muted-foreground">{t("copyUpdates.activityError")}</p> : <div className="flex flex-col gap-3 py-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>;
  const items = [...events.data.items].reverse().filter((e) => describeCopyEvent(e).kind !== "other");
  if (!items.length) return <Empty title={t("feed.emptyCopies")} body={t("feed.emptyCopiesDesc")} />;
  return (
    <ul className="divide-y divide-border">
      {items.map((event) => {
        const d = describeCopyEvent(event);
        const who = leaderOf(event.strategyId);
        const coin = d.coin ? coinLabel(d.coin) : "";
        const side = d.long === null ? "" : t(d.long ? "feed.long" : "feed.short");
        const at = d.px !== null ? ` ${t("feed.atPrice", { px: format.price(d.px) })}` : "";
        const time = shortAgo(event.createdAt, t);
        if (d.coin && (d.kind === "open" || d.kind === "increase" || d.kind === "decrease" || d.kind === "close" || d.kind === "liquidation")) {
          const verb = t(`feed.verb.${d.kind}`);
          const down = d.kind === "decrease" || d.kind === "close" || d.kind === "liquidation";
          return (
            <Row
              key={event.id}
              icon={<CoinBadge coin={d.coin} down={down} />}
              title={`${verb} ${side} ${coin}${at}`.replace(/\s+/g, " ").trim()}
              subtitle={who ? (down ? t("feed.via", { who }) : t("feed.copiedWho", { who })) : undefined}
              trail={<>
                {d.pnl !== null && d.pnl !== 0 ? <span className={cn("num font-semibold", d.pnl > 0 ? "text-positive" : "text-negative")}>{format.usd(d.pnl, { sign: true, digits: 2 })}</span> : null}
                <span className="text-muted-foreground">{time}</span>
              </>}
            />
          );
        }
        const title = d.kind === "funds_in" ? t("feed.fundsIn") : d.kind === "funds_out" ? t("feed.fundsOut") : d.kind === "sweep" ? t("feed.sweep") : t("feed.hubWithdrawal");
        const status = event.type === "wallet_withdrawal" && typeof event.payload.status === "string" ? t(event.payload.status === "accepted" ? "feed.accepted" : "feed.rejected") : null;
        return (
          <Row
            key={event.id}
            icon={<span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", d.kind === "funds_in" ? "bg-positive-soft text-positive" : "bg-raised text-muted-foreground")}>{d.kind === "funds_in" ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}</span>}
            title={title}
            subtitle={[who, status].filter(Boolean).join(" · ") || undefined}
            trail={<>
              {d.amount !== null ? <span className="num font-semibold">{format.usd(d.amount, { digits: 2 })}</span> : null}
              <span className="text-muted-foreground">{time}</span>
            </>}
          />
        );
      })}
    </ul>
  );
}

const buys = (a: Pick<ActionFeedItem, "kind" | "side">) => (a.kind === "open" || a.kind === "add" || a.kind === "flip" ? a.side === "long" : a.side !== "long");

function FollowingList({ onNavigate }: { onNavigate: () => void }) {
  const { t, format } = useI18n();
  const feed = useActions({ scope: "favorites", limit: 50 }, { refetchInterval: 15_000 });
  if (!feed.data) return feed.isError ? <p className="py-8 text-center text-sm text-muted-foreground">{t("copyUpdates.activityError")}</p> : <div className="flex flex-col gap-3 py-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>;
  if (!feed.data.length) return <Empty title={t("feed.followingEmpty")} body={t("feed.followingWaiting")} />;
  return (
    <ul className="divide-y divide-border">
      {feed.data.map((a) => {
        const buy = buys(a);
        const who = a.leaderLabel?.trim() || truncateAddress(a.address);
        return (
          <Row
            key={String(a.id)}
            href={`/trader/${a.address}`}
            onNavigate={onNavigate}
            icon={<CoinBadge coin={a.coin} down={!buy} />}
            title={t(buy ? "feed.bought" : "feed.sold", { who, coin: coinLabel(a.coin) })}
            subtitle={`${format.usd(Number(a.notionalUsd), { digits: 0 })} @ ${format.price(Number(a.avgPx))}`}
            trail={<span className="text-muted-foreground">{shortAgo(a.ts, t)}</span>}
          />
        );
      })}
    </ul>
  );
}

function DepositsList() {
  const { t, format } = useI18n();
  const history = useWalletHistory();
  const rows = useMemo(() => (history.data?.transfers ?? []).filter((x) => x.kind === "deposit" || x.kind === "withdraw"), [history.data]);
  if (!history.data) return history.isError ? <p className="py-8 text-center text-sm text-muted-foreground">{t("copyUpdates.activityError")}</p> : <div className="flex flex-col gap-3 py-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>;
  if (!rows.length) return <Empty title={t("feed.emptyDeposits")} />;
  return (
    <ul className="divide-y divide-border">
      {rows.map((x) => {
        const deposit = x.kind === "deposit";
        return (
          <Row
            key={`${x.hash}-${String(x.time)}`}
            icon={<span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", deposit ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>{deposit ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}</span>}
            title={t(deposit ? "feed.deposit" : "feed.withdrawal")}
            subtitle={shortAgo(x.time, t)}
            trail={<>
              <span className={cn("num font-semibold", deposit ? "text-positive" : "text-negative")}>{deposit ? "+" : "−"}{format.usd(x.amount, { digits: 2 })}</span>
              <span className="text-positive">{t("feed.completed")}</span>
            </>}
          />
        );
      })}
    </ul>
  );
}

/**
 * CopyDog's phone Activity panel (the portfolio's bell): Copies (the copy
 * events, live), Following (the latest trades of your favorites) and
 * Deposits (the wallet's deposits and withdrawals).
 */
export function ActivityPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { status, login } = useAuth();
  const [chip, setChip] = useState<Chip>("copies");
  const signedIn = status === "signedIn";
  return (
    <Modal
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={t("feed.title")}
      badge={chip === "copies" && signedIn ? <PaperBadge /> : null}
      className="top-0 left-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0"
      bodyClassName="px-4 pt-3 pb-8"
    >
      <div role="tablist" aria-label={t("feed.title")} className="flex gap-2">
        {(["copies", "following", "deposits"] as const).map((c) => (
          <button key={c} type="button" role="tab" aria-selected={chip === c} onClick={() => setChip(c)} className={cn("h-9 rounded-full px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring", chip === c ? "bg-primary text-primary-foreground" : "bg-raised text-foreground")}>
            {t(`feed.chips.${c}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mt-2">
        {!signedIn ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <Bell className="size-8 text-muted-foreground" strokeWidth={1.5} aria-hidden />
            <p className="mt-3 text-[0.9375rem] font-bold">{t("feed.signedOutTitle")}</p>
            <p className="mt-2 text-[0.8125rem] text-muted-foreground">{t("feed.signedOutDesc")}</p>
            <Button className="mt-4" onClick={login} disabled={status === "disabled"}>{t("common.signIn")}</Button>
          </div>
        ) : chip === "copies" ? <CopiesList /> : chip === "following" ? <FollowingList onNavigate={onClose} /> : <DepositsList />}
      </div>
    </Modal>
  );
}
