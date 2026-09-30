"use client";

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
  Share2,
  Ship,
  Skull,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { AlertBell } from "@/components/alerts/alert-bell";
import { TraderName } from "@/components/traders/trader-name";
import { FavoriteButton, VaultBadge } from "@/components/traders/bits";
import { CoinIcon } from "@/components/traders/coin-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n/provider";
import { coinLabel, truncateAddress } from "@/lib/format";
import { CopyScoreBar, TraderAvatar, VerifiedTick, XProfileLink } from "@/components/discover/board-bits";
import { pnlTone, signedUsd1, signedUsd2, usd0, usd1, usd2 } from "@/lib/trade-format";

function useCopied() {
  const [copied, setCopied] = useState<string | null>(null);
  return {
    copied,
    copy(key: string, text: string) {
      void navigator.clipboard?.writeText(text).then(() => {
        setCopied(key);
        setTimeout(() => setCopied(null), 1400);
      });
    },
  };
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="border-t border-border px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[0.8125rem] font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-[0.8125rem]">
      <span className="text-muted-foreground">{label}</span>
      <span className="num text-right font-medium">{children}</span>
    </div>
  );
}

function Meter({ fill, className }: { fill: number; className?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
      <div
        className={cn("h-full rounded-full bg-primary", className)}
        style={{ width: `${Math.max(2, Math.min(100, fill * 100))}%` }}
      />
    </div>
  );
}

/** CopyDog's 現貨 (`spotFree`): spot not held as margin or by open orders,
 * Σ value × (total − hold) ÷ total. In a unified account the USDC backing
 * the perps is on hold, so this no longer repeats the perp equity. */
export function freeSpot(profile: Pick<TraderProfileResponse, "spotBalances">): number {
  return profile.spotBalances.reduce((sum, b) => sum + (b.total > 0 ? (b.value * Math.max(0, b.total - (b.hold ?? 0))) / b.total : 0), 0);
}

/** 帳戶價值 as CopyDog's: the total with a chevron; opening it lists the
 * parts (永續 / 現貨 free of holds / 質押), full precision. A vault shows its
 * TVL alone. */
function AccountValue({ profile }: { profile: TraderProfileResponse }) {
  const { t, format } = useI18n();
  const [open, setOpen] = useState(false);
  const value = (
    <span className="num text-[1.625rem] leading-none font-bold tracking-tight" data-testid="account-value">
      {format.usd(profile.accountValue, { digits: 2 })}
    </span>
  );
  if (profile.isVault) {
    return (
      <div className="border-t border-border px-4 py-4">
        <p className="mb-1.5 text-xs text-muted-foreground">{t("common.tvl")}</p>
        {value}
      </div>
    );
  }
  return (
    <div className="border-t border-border px-4 py-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="account-value-parts"
        onClick={() => setOpen((v) => !v)}
        className="w-full rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="mb-1.5 block text-xs text-muted-foreground">{t("trader.accountValue")}</span>
        <span className="flex items-center justify-between gap-2">
          {value}
          <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-subtle-foreground transition-transform", open && "rotate-180")} />
        </span>
      </button>
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
  /** CopyDog's 複製評分 (0–98); null while loading or unscored; the row is
   * left out when not given. */
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
    <aside className="overflow-hidden rounded-2xl border border-border bg-card">
      {identity ? (
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3.5">
          <TraderAvatar trader={{ address: profile.address, avatarUrl: profile.kol?.avatarUrl ?? null }} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <h1 className="flex min-w-0 text-[0.9375rem] font-bold">
                <TraderName trader={profile} />
              </h1>
              {profile.kol?.verified ? <VerifiedTick className="size-3.5" /> : null}
              {profile.kol?.xHandle ? <XProfileLink handle={profile.kol.xHandle} /> : null}
              {profile.isVault ? <VaultBadge /> : null}
            </div>
            <button
              type="button"
              onClick={() => copy("address", profile.address)}
              className="num mt-0.5 flex items-center gap-1 rounded font-mono text-[11px] whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              title={profile.address}
              aria-label={`${t("common.copy")} ${profile.address}`}
            >
              {truncateAddress(profile.address)}
              {copied === "address" ? <Check className="size-3 text-positive" /> : <Copy className="size-3" />}
            </button>
          </div>
          <FavoriteButton address={profile.address} favorite={profile.favorite} size="sm" />
          <AlertBell address={profile.address} className="-ml-1.5" />
          <button
            type="button"
            onClick={() => copy("link", window.location.href)}
            aria-label={copied === "link" ? t("common.linkCopied") : t("common.share")}
            title={copied === "link" ? t("common.linkCopied") : t("common.share")}
            className="-ml-1.5 inline-flex size-7 items-center justify-center rounded-full text-subtle-foreground outline-none hover:bg-raised-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {copied === "link" ? <Check className="size-4 text-positive" /> : <Share2 className="size-4" />}
          </button>
        </div>
      ) : null}

      <AccountValue profile={profile} />

      <Section title={t("trader.holdings")}>
        <div className="flex items-center justify-between text-[0.8125rem]">
          <span className="text-muted-foreground">{t("trader.leverage")}</span>
          <span className="num font-semibold text-warning">{leverage === null ? "—" : `${leverage.toFixed(1)}X`}</span>
        </div>
        <div className="mt-2">
          <Meter fill={(leverage ?? 0) / 10} className="bg-warning" />
        </div>
        <p className="num mt-1.5 text-[11px] text-subtle-foreground">
          <span className="text-warning">{usd0(gross)}</span> {t("trader.notional")}
        </p>

        <div className="mt-4 flex items-center justify-between text-[0.8125rem]">
          <span className="text-muted-foreground">{t("trader.bias")}</span>
          <span className={cn("inline-flex items-center gap-0.5 font-semibold", biasDir === "long" && "text-positive", biasDir === "short" && "text-negative")} data-testid="bias">
            {biasDir === "long" ? <ArrowUpRight className="size-3.5" aria-hidden /> : biasDir === "short" ? <ArrowDownRight className="size-3.5" aria-hidden /> : null}
            {bias}
          </span>
        </div>
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-border">
          {gross !== null && gross > 0 ? (
            <>
              <div className="h-full bg-positive" style={{ width: `${longShare * 100}%` }} />
              <div className="h-full bg-negative" style={{ width: `${(1 - longShare) * 100}%` }} />
            </>
          ) : null}
        </div>
        <div className="num mt-1.5 flex justify-between text-[11px]">
          <span>
            <span className="text-positive">{format.pct(gross === null ? null : gross > 0 ? longShare : 0)}</span>
            <span className="text-subtle-foreground">
              {" · "}
              {t("common.long")} {usd0(profile.longNotional)}
            </span>
          </span>
          <span>
            <span className="text-subtle-foreground">
              {usd0(profile.shortNotional)} {t("common.short")}
              {" · "}
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
        {copyScore !== undefined ? (
          <Row label={t("discover.copyScore")}>
            <CopyScoreBar score={copyScore} layout="bar-first" barClassName="w-14" />
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
const PNL_ICON: Partial<Record<PnlTier, LucideIcon>> = {
  extremely_profitable: Crown,
  very_profitable: Gem,
  profitable: CircleDollarSign,
  unprofitable: Ghost,
  very_unprofitable: Frown,
  rekt: Skull,
};
const SIZE_ICON: Record<SizeTier, LucideIcon> = {
  apex: Orbit,
  whale: Ship,
  large: Sailboat,
  medium: Anchor,
  small: CircleDot,
};

/** Placeholder bars while the api computes a cold address. */
function PendingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 py-1" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex justify-between">
          <span className="h-3.5 w-20 animate-pulse rounded bg-raised" />
          <span className="h-3.5 w-14 animate-pulse rounded bg-raised" />
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
      {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
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
    <ul className="flex flex-col gap-1">
      {rows.map((row) => (
        <li key={row.key} className="flex items-center justify-between py-1 text-[0.8125rem]">
          <span className="flex items-center gap-1.5">
            <CoinIcon coin={row.coin} size={16} />
            {coinLabel(row.coin)}
          </span>
          <span className={cn("num font-medium", row.className)}>{row.figure}</span>
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
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("trader.bestWorst")}
            className="inline-flex items-center gap-0.5 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t(view === "best" ? "trader.best" : "trader.worst")}
            <ChevronDown className="size-3.5" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-28">
            <DropdownMenuRadioGroup value={view} onValueChange={(v) => setView(v as "best" | "worst")}>
              <DropdownMenuRadioItem value="best">{t("trader.best")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="worst">{t("trader.worst")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
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
