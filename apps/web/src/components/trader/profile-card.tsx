"use client";

import { Select } from "@/components/ui/select";
import type { PnlTier, SizeTier, TraderAnalyticsResponse, TraderProfileResponse } from "@/lib/contracts";
import {
  Anchor,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleDollarSign,
  CircleDot,
  Copy,
  Crown,
  Frown,
  Gem,
  Ghost,
  Orbit,
  Sailboat,
  Ship,
  Skull,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { SkelBar, SkelCircle } from "@/components/page";
import { TraderName } from "@/components/traders/trader-name";
import { FavoriteButton } from "@/components/traders/bits";
import { CoinIcon } from "@/components/traders/coin-icon";

import { useI18n } from "@/i18n/provider";
import { useToast } from "@/components/ui/toast";
import { coinLabel, truncateAddress, signedUsd1, signedUsd2, usd0, usd1, usd2 } from "@/lib/format";
import { CopyScoreBar, TraderAvatar, XProfileLink } from "@/components/discover/board-bits";
import { shareName } from "@/lib/share-card";
import { pnlTone } from "@/lib/trade-format";
import { ShareButton } from "./share-dialog";

function useCopied() {
  const [copied, setCopied] = useState<string | null>(null);
  const toast = useToast(), { t } = useI18n();
  return {
    copied,
    copy(key: string, text: string) {
      // A blocked or missing clipboard is said, never an unhandled rejection.
      if (!navigator.clipboard) { toast.error(t("common.copyFailed")); return; }
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(key);
        setTimeout(() => setCopied(null), 1400);
      }).catch(() => toast.error(t("common.copyFailed")));
    },
  };
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mt-4 border-t-2 border-dotted border-border px-5 pt-4">
      <div className="mb-2.5 flex min-h-[26px] items-center justify-between gap-2">
        <h2 className="type-h2">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[13px] leading-5 font-bold text-muted-foreground">{label}</span>
      <span className="cd-value text-right">{children}</span>
    </div>
  );
}

function Meter({ fill, className }: { fill: number; className?: string }) {
  return (
    <div className="cd-bar w-full">
      <div className={cn("bg-primary", className)} style={{ width: `${Math.max(2, Math.min(100, fill * 100))}%` }} />
    </div>
  );
}

/** CopyDog's 現貨 (`spotFree`): spot not held as margin or by open orders,
 * Σ value × (total − hold) ÷ total. In a unified account the USDC backing
 * the perps is on hold, so this no longer repeats the perp equity. */
export function freeSpot(profile: Pick<TraderProfileResponse, "spotBalances">): number {
  return profile.spotBalances.reduce((sum, b) => sum + (b.total > 0 ? (b.value * Math.max(0, b.total - (b.hold ?? 0))) / b.total : 0), 0);
}

type Translate = ReturnType<typeof useI18n>["t"];

/** What the account value leaves out because it could not be read just now
 * (audit A8): perp dexes (for a standard account, whose perp equity it
 * adds) and staked HYPE. Null when nothing is missing. */
export function unavailableNote(profile: Pick<TraderProfileResponse, "unavailableParts" | "accountMode" | "isVault">, t: Translate, locale: string): string | null {
  const gaps = profile.unavailableParts;
  if (!gaps || profile.isVault) return null;
  const parts = [
    ...(profile.accountMode === "standard" ? gaps.perpDexes.map((dex) => (dex === "" ? t("trader.partMainDex") : t("trader.partPerpDex", { dex }))) : []),
    ...(gaps.staking ? [t("trader.partStaking")] : []),
  ];
  if (parts.length === 0) return null;
  return t("trader.accountValuePartial", { parts: new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts) });
}

/** 帳戶價值 as CopyDog's: the total with a chevron; opening it lists the
 * parts (永續 / 現貨 free of holds / 質押), full precision. A vault shows its
 * TVL alone. */
function AccountValue({ profile }: { profile: TraderProfileResponse }) {
  const { t, format } = useI18n();
  const [open, setOpen] = useState(false);
  const note = unavailableNote(profile, t, format.locale);
  const value = (
    <span className="num font-display text-[1.625rem] leading-[30px]" data-testid="account-value">
      {format.usd(profile.accountValue, { digits: 2 })}
    </span>
  );
  if (profile.isVault) {
    return (
      <div className="mt-4 border-t-2 border-dotted border-border px-5 pt-4">
        <p className="mb-2 text-[13px] font-bold text-muted-foreground">{t("common.tvl")}</p>
        {value}
      </div>
    );
  }
  return (
    <div className="mx-4 mt-4 rounded-xl bg-inset px-4 py-3.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="account-value-parts"
        onClick={() => setOpen((v) => !v)}
        className="w-full rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="mb-1 block text-[13px] font-bold text-muted-foreground">{t("trader.accountValue")}</span>
        <span className="flex items-center justify-between gap-2">
          {value}
          <ChevronDown aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </span>
      </button>
      {note ? (
        <p role="status" className="mt-1.5 text-[11px] leading-4 text-warning" data-testid="account-value-partial">
          {note}
        </p>
      ) : null}
      {open ? (
        <div id="account-value-parts" className="mt-3">
          <Row label={t("trader.accountPerp")}>
            <span data-testid="perp-equity">{format.usd(profile.perpEquity, { digits: 2 })}</span>
          </Row>
          <Row label={t("trader.accountSpot")}>
            <span data-testid="spot-value">{format.usd(freeSpot(profile), { digits: 2 })}</span>
          </Row>
          <Row label={t("trader.accountStaked")}>{format.usd(profile.stakedValue, { digits: 2 })}</Row>
        </div>
      ) : null}
    </div>
  );
}

/** Left column, CopyDog's order: identity, account value, 持倉 (leverage,
 * bias), 概覽 (with 複製評分), 分組, 最佳與最差, 最常交易. */
export function ProfileCard({
  profile,
  allTimeVolume,
  trades,
  tradesComputing,
  identity = true,
  copyScore,
}: {
  profile: TraderProfileResponse;
  /** From the same `portfolio` as the page's PnL (all-time window). */
  allTimeVolume: number | null;
  /** All-time trade analytics (any address), for 分組 and 最佳與最差. */
  trades: TraderAnalyticsResponse | undefined;
  /** The api is still reconstructing a cold address's trades. */
  tradesComputing: boolean;
  /** Avatar, name and actions; off on phones, whose top bar has them. */
  identity?: boolean;
  /** CopyDog's 複製評分 (0–98); the row is left out while it is null
   * (loading or unscored) or not given, as on CopyDog. */
  copyScore?: number | null;
}) {
  const { t, format } = useI18n();
  const { copied, copy } = useCopied();

  const gross = profile.longNotional === null || profile.shortNotional === null ? null : profile.longNotional + profile.shortNotional;
  // CopyDog's leverage is the open notional over the whole account (its
  // equity: perp + spot + staked, a unified account counted once); margin
  // usage stays a perp figure, margin used over perp equity.
  const leverage = profile.accountValue === null || gross === null ? null : profile.accountValue > 0 ? gross / profile.accountValue : 0;
  const longShare = gross !== null && gross > 0 && profile.longNotional !== null ? profile.longNotional / gross : 0.5;
  // CopyDog: neutral only without exposure; "very" when one side holds ≥ 80%.
  const biasDir = gross === null || gross === 0 || longShare === 0.5 ? null : longShare > 0.5 ? "long" : "short";
  const bias =
    gross === null ? "—" : biasDir === null
      ? t("trader.biasNeutral")
      : biasDir === "long"
        ? t(longShare >= 0.8 ? "trader.biasVeryLong" : "trader.biasLong")
        : t(1 - longShare >= 0.8 ? "trader.biasVeryShort" : "trader.biasShort");
  const unrealized = profile.perpEquity === null ? null : profile.positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const marginUsage = profile.perpEquity === null || profile.marginUsed === null ? null : profile.perpEquity > 0 ? profile.marginUsed / profile.perpEquity : 0;

  return (
    <aside aria-labelledby="trader-name" className="orbit-card overflow-hidden pb-5 [&>div:first-child]:mt-0 [&>div:first-child]:border-t-0">
      {identity ? (
        <>
          {/* C-Trader: the picture, then the name as the page's h1 (40/52,
              up to two lines) over the address; the round actions below. */}
          <div className="flex items-center gap-3 px-5 pt-5">
            <TraderAvatar trader={{ address: profile.address, avatarUrl: profile.kol?.avatarUrl ?? null }} size={52} />
            <div className="min-w-0 flex-1">
              <h1 id="trader-name" className="type-h1 flex min-w-0">
                <TraderName trader={profile} className="line-clamp-2 whitespace-normal [overflow-wrap:anywhere]" />
              </h1>
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => copy("address", profile.address)}
                  className="num flex items-center gap-1 rounded text-[13px] leading-[18px] font-bold whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  title={profile.address}
                  aria-label={`${t("common.copy")} ${profile.address}`}
                >
                  {truncateAddress(profile.address)}
                  {copied === "address" ? <Check className="size-3 text-positive" /> : <Copy className="size-3" />}
                </button>
                {profile.kol?.xHandle ? <XProfileLink handle={profile.kol.xHandle} className="text-[11px]" /> : null}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 px-5 pt-3">
            <FavoriteButton address={profile.address} favorite={profile.favorite} solid className="size-11 rounded-full bg-inset" />
            <ShareButton
              address={profile.address}
              name={shareName({ address: profile.address, displayName: profile.displayName, kol: profile.kol })}
              className="size-11 rounded-full bg-inset text-foreground hover:bg-raised-hover"
              iconClassName="size-[17px]"
            />
          </div>
        </>
      ) : null}

      <AccountValue profile={profile} />

      <Section title={t("trader.holdings")}>
        <div className="flex items-baseline justify-between gap-2.5 pt-0.5">
          <span className="text-[13px] font-bold text-muted-foreground">{t("trader.leverage")}</span>
          <span className="num font-display text-base leading-5">{leverage === null ? "—" : `${leverage.toFixed(1)}X`}</span>
        </div>
        <div className="mt-2">
          <Meter fill={(leverage ?? 0) / 10} className="bg-primary" />
        </div>
        <p className="num mt-1.5 pb-0.5 text-xs leading-4 font-bold text-muted-foreground">
          <span>{usd0(gross)}</span> {t("trader.notional")}
        </p>

        <div className="mt-[18px] flex items-baseline justify-between gap-2.5 pt-0.5">
          <span className="text-[13px] font-bold text-muted-foreground">{t("trader.bias")}</span>
          <span className={cn("inline-flex items-center gap-0.5 font-display text-base leading-5", biasDir === "long" && "text-positive", biasDir === "short" && "text-negative")} data-testid="bias">
            {biasDir === "long" ? <ArrowUpRight className="size-2.5" aria-hidden /> : biasDir === "short" ? <ArrowDownRight className="size-2.5" aria-hidden /> : null}
            {bias}
          </span>
        </div>
        <div className="cd-bar mt-2">
          {gross !== null && gross > 0 ? (
            <>
              <div className="bg-positive" style={{ width: `${longShare * 100}%` }} />
              <div className="bg-negative" style={{ width: `${(1 - longShare) * 100}%` }} />
            </>
          ) : null}
        </div>
        <div className="num mt-1.5 flex justify-between gap-2 pb-0.5 text-xs leading-4 font-bold whitespace-nowrap">
          <span>
            <span className="text-positive">{format.pct(gross === null ? null : gross > 0 ? longShare : 0)}</span>
            <span className="text-muted-foreground">
              <span className="mx-1 text-subtle-foreground">▪</span>
              {t("common.long")} {usd0(profile.longNotional)}
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">
              {usd0(profile.shortNotional)} {t("common.short")}
              <span className="mx-1 text-subtle-foreground">▪</span>
            </span>
            <span className="text-negative">{format.pct(gross === null ? null : gross > 0 ? 1 - longShare : 0)}</span>
          </span>
        </div>
      </Section>

      <Section title={t("trader.overview")}>
        <Row label={t("trader.unrealized")}>
          <span className={pnlTone(unrealized ?? 0)}>{unrealized === null ? "—" : signedUsd2(unrealized)}</span>
        </Row>
        <Row label={t("trader.marginUsage")}>
          <span className={marginUsage === null ? "" : marginUsage >= 0.7 ? "text-negative" : marginUsage >= 0.5 ? "text-warning" : ""}>
            {marginUsage === null ? "—" : `${(marginUsage * 100).toFixed(2)}%`}
          </span>
        </Row>
        <Row label={t("trader.volume")}>
          <span data-testid="volume">{allTimeVolume === null ? "—" : usd2(allTimeVolume)}</span>
        </Row>
        {copyScore != null ? (
          <Row label={t("discover.copyScore")}>
            <CopyScoreBar score={copyScore} layout="bar-first" barClassName="w-14" className="gap-2.5" />
          </Row>
        ) : null}
      </Section>

      <GroupsSection trades={trades} computing={tradesComputing} />
      <BestWorstSection trades={trades} computing={tradesComputing} />
      <MostTradedSection trades={trades} computing={tradesComputing} />
    </aside>
  );
}

/** CopyDog's tier icons (Remix Icon glyphs in its bundle), drawn with the
 * matching Lucide icons Orbie already uses. Break even has none there. */
export const PNL_ICON: Partial<Record<PnlTier, LucideIcon>> = {
  extremely_profitable: Crown,
  very_profitable: Gem,
  profitable: CircleDollarSign,
  unprofitable: Ghost,
  very_unprofitable: Frown,
  rekt: Skull,
};
export const SIZE_ICON: Record<SizeTier, LucideIcon> = {
  apex: Orbit,
  whale: Ship,
  large: Sailboat,
  medium: Anchor,
  small: CircleDot,
};

/** Placeholder bars while the api computes a cold address. */
function PendingRows({ rows = 3 }: { rows?: number }) {
  // The rows' own height (py-1.5 around a 20px line), so the figures land
  // in place.
  return (
    <div className="ui-skeleton flex flex-col" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-3 py-1.5">
          <SkelBar line="h-5" className="h-3 w-20" />
          <SkelBar line="h-5" className="h-3 w-14" />
        </div>
      ))}
    </div>
  );
}

/** No analytics yet: placeholders while computing, else a load failure
 * (never an empty history). */
function Unavailable({ computing }: { computing: boolean }) {
  const { t } = useI18n();
  if (computing) return <PendingRows />;
  return <p className="text-xs text-muted-foreground">{t("trader.analyticsFailed")}</p>;
}

function TierValue({ icon: Icon, label, hint, testId }: { icon?: LucideIcon; label: string; hint: string; testId: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={hint} data-testid={testId}>
      {Icon ? <Icon className="size-[13px]" aria-hidden /> : null}
      {label}
    </span>
  );
}

/** 分組: CopyDog's trading style, PnL cohort and size cohort; like
 * CopyDog, a row without a value is left out. */
function GroupsSection({ trades, computing }: { trades: TraderAnalyticsResponse | undefined; computing: boolean }) {
  const { t } = useI18n();
  const c = trades?.classification;
  if (!trades) {
    return (
      <Section title={t("trader.groups")}>
        {computing ? <span className="sr-only" role="status">{t("trader.computing")}</span> : null}
        <Unavailable computing={computing} />
      </Section>
    );
  }
  if (!c?.style && !c?.pnlTier && !c?.sizeTier) return null;
  return (
    <Section title={t("trader.groups")}>
      {c.style ? (
        <Row label={t("trader.tradingStyle")}>
          <span title={t(`trader.styleHints.${c.style}`)} data-testid="trading-style">
            {t(`trader.styles.${c.style}`)}
          </span>
        </Row>
      ) : null}
      {c.pnlTier ? (
        <Row label={t("trader.pnlTier")}>
          <TierValue icon={PNL_ICON[c.pnlTier]} label={t(`trader.pnlTiers.${c.pnlTier}`)} hint={t(`trader.pnlTierHints.${c.pnlTier}`)} testId="pnl-tier" />
        </Row>
      ) : null}
      {c.sizeTier ? (
        <Row label={t("trader.sizeTier")}>
          <TierValue icon={SIZE_ICON[c.sizeTier]} label={t(`trader.sizeTiers.${c.sizeTier}`)} hint={t(`trader.sizeTierHints.${c.sizeTier}`)} testId="size-tier" />
        </Row>
      ) : null}
    </Section>
  );
}

function CoinFigureRows({ rows }: { rows: Array<{ key: string; coin: string; figure: string; className?: string }> }) {
  return (
    <ul className="flex flex-col">
      {rows.map((row) => (
        <li key={row.key} className="flex items-center justify-between gap-3 py-1.5 text-[13px] leading-5">
          <span className="flex min-w-0 items-center gap-1.5">
            <CoinIcon coin={row.coin} size={16} />
            <span className="truncate">{coinLabel(row.coin)}</span>
          </span>
          <span className={cn("cd-value", row.className)}>{row.figure}</span>
        </li>
      ))}
    </ul>
  );
}

/** 最佳與最差: the three best or worst closed trades by net PnL, picked
 * with a small dropdown as on CopyDog. */
function BestWorstSection({ trades, computing }: { trades: TraderAnalyticsResponse | undefined; computing: boolean }) {
  const { t } = useI18n();
  const [view, setView] = useState<"best" | "worst">("best");
  const list = view === "best" ? trades?.summary.best.filter((x) => x.netPnl > 0) : trades?.summary.worst.filter((x) => x.netPnl < 0);
  const rows = (list ?? []).slice(0, 3);
  return (
    <Section
      title={t("trader.bestWorst")}
      action={
        <Select
          size="row"
          align="end"
          label={t("trader.bestWorst")}
          value={view}
          onValueChange={(v) => setView(v as "best" | "worst")}
          className="-my-1.5"
          options={[{ value: "best", label: t("trader.best") }, { value: "worst", label: t("trader.worst") }]}
        />
      }
    >
      {!trades ? (
        <Unavailable computing={computing} />
      ) : rows.length > 0 ? (
        <CoinFigureRows rows={rows.map((x) => ({ key: x.id, coin: x.coin, figure: signedUsd1(x.netPnl), className: pnlTone(x.netPnl) }))} />
      ) : (
        <p className="text-xs text-muted-foreground">{t(trades ? "trader.noClosedTrades" : "trader.kpi.noTrades")}</p>
      )}
    </Section>
  );
}

/** 最常交易: the three coins with the most volume (Σ size × entry). */
function MostTradedSection({ trades, computing }: { trades: TraderAnalyticsResponse | undefined; computing: boolean }) {
  const { t } = useI18n();
  const rows = [...(trades?.summary.coins ?? [])].sort((a, b) => b.volume - a.volume).slice(0, 3);
  return (
    <Section title={t("trader.mostTraded")}>
      {!trades ? (
        <Unavailable computing={computing} />
      ) : rows.length > 0 ? (
        <CoinFigureRows rows={rows.map((c) => ({ key: c.coin, coin: c.coin, figure: usd1(c.volume) }))} />
      ) : (
        <p className="text-xs text-muted-foreground">{t(trades ? "trader.noClosedTrades" : "trader.kpi.noTrades")}</p>
      )}
    </Section>
  );
}

/** The profile rail while the profile loads: the same card, sections and
 * static labels, with bars where the name and figures go (it is drawn
 * before the server's profile, or the browser's, has arrived). */
export function ProfileCardSkeleton({ identity = true }: { identity?: boolean }) {
  const { t } = useI18n();
  const figure = <SkelBar line="h-5" className="h-3 w-16" />;
  return (
    <aside aria-hidden="true" className="orbit-card ui-skeleton overflow-hidden pb-5 [&>div:first-child]:mt-0 [&>div:first-child]:border-t-0">
      {identity ? (
        <>
          <div className="flex items-center gap-3 px-5 pt-5">
            <SkelCircle className="size-[52px]" />
            <div className="min-w-0 flex-1">
              <SkelBar line="h-[44px] md:h-[52px]" className="h-6 w-28 md:h-8" />
              <SkelBar line="h-[18px]" className="h-2.5 w-24" />
            </div>
          </div>
          <div className="flex items-center gap-2 px-5 pt-3">
            <SkelCircle className="size-11" />
            <SkelCircle className="size-11" />
          </div>
        </>
      ) : null}
      <div className="mx-4 mt-4 rounded-xl bg-inset px-4 py-3.5 [--skel-bar:var(--border)]">
        <span className="mb-1 block text-[13px] font-bold text-muted-foreground">{t("trader.accountValue")}</span>
        <SkelBar line="h-[30px]" className="h-6 w-32" />
      </div>
      <Section title={t("trader.holdings")}>
        <div className="flex items-baseline justify-between gap-2.5 pt-0.5">
          <span className="text-[13px] font-bold text-muted-foreground">{t("trader.leverage")}</span>
          <SkelBar line="h-5" className="h-3 w-10" />
        </div>
        <div className="mt-2 cd-bar w-full" />
        <SkelBar line="mt-1.5 mb-0.5 h-4" className="h-2.5 w-24" />
        <div className="mt-[18px] flex items-baseline justify-between gap-2.5 pt-0.5">
          <span className="text-[13px] font-bold text-muted-foreground">{t("trader.bias")}</span>
          <SkelBar line="h-5" className="h-3 w-12" />
        </div>
        <div className="cd-bar mt-2" />
        <SkelBar line="mt-1.5 mb-0.5 h-4" className="h-2.5 w-full" />
      </Section>
      <Section title={t("trader.overview")}>
        <Row label={t("trader.unrealized")}>{figure}</Row>
        <Row label={t("trader.marginUsage")}>{figure}</Row>
        <Row label={t("trader.volume")}>{figure}</Row>
      </Section>
      <Section title={t("trader.groups")}><PendingRows /></Section>
      <Section title={t("trader.bestWorst")}><PendingRows /></Section>
      <Section title={t("trader.mostTraded")}><PendingRows /></Section>
    </aside>
  );
}
