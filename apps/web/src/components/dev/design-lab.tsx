"use client";

import { Select } from "@/components/ui/select";
import { Link, useRouter } from "@/i18n/navigation";
import { ArrowRight, ArrowUpRight, SlidersHorizontal, Bookmark, FlaskConical, Settings } from "lucide-react";
import { useState } from "react";
import { OrbieMark } from "@/components/brand/logo";
import { AccountControls } from "@/components/shell/account-controls";
import { AddressSearch } from "@/components/shell/address-search";
import { primaryNav, type NavItem } from "@/components/shell/nav";
import { HistoricalSimulator } from "./historical-simulator";
import { LabExtras } from "./lab-extras";
import { BoardsView } from "@/components/explore/boards-view";
import { PortfolioView } from "@/components/portfolio-view";
import { FavoritesView } from "@/components/favorites/favorites-view";
import { SettingsView } from "@/components/settings/settings-view";
import { InsightsView } from "@/components/insights/insights-view";
import { BoardSparkline, boardName, TraderAvatar } from "@/components/discover/board-bits";
import { ErrorState, Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { useI18n } from "@/i18n/provider";
import { useHomeBoards, useSiteSettings } from "@/lib/queries";
import { boardCoinLabel, boardPnl, boardRoi } from "@/lib/board-format";
import type { BoardTrader } from "@/lib/contracts";
import type { Block } from "@/lib/markdown";
import { concepts, previousConcepts } from "./concepts";
import styles from "./design-lab.module.css";

/** The site rail no longer lists Settings (CopyDog reaches it from the
 * account menu); the lab keeps it as a screen to preview. */
const settingsNav: NavItem = { href: "/settings", label: "nav.settings", icon: Settings };
/** Orbie-only features kept off the user pages (see LabExtras). */
const extrasNav: NavItem = { href: "/extras", label: "nav.extras", icon: FlaskConical };

export function DesignLab({ concept, screen, numbers }: { concept: string; screen: string; numbers: Block[] }) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const en = locale === "en";
  const selected = [...concepts, ...previousConcepts].find((item) => item.id === concept) ?? concepts[0];
  const nav = [...primaryNav, settingsNav, extrasNav];
  const base = `/dev/${selected.id}`;
  return (
    <div className={`${styles.lab} ${styles[selected.id]}`} data-design={selected.id}>
      <a href="#lab-main" className={styles.skip}>{en ? "Skip to content" : "跳至內容"}</a>
      <div className={styles.labBar}>
        <span className={styles.labLabel}>DESIGN PREVIEW</span>
        <nav aria-label={en ? "Design versions" : "設計版本"} className={styles.versions}>
          {concepts.map((item, i) => <Link key={item.id} href={`/dev/${item.id}/${screen}`} aria-current={selected.id === item.id ? "page" : undefined}><span>0{i + 1}</span> {item.name}<small>{en ? item.en : item.label}</small></Link>)}
        </nav>
        <Select size="sm" className={styles.archive} label={en ? "Previous designs" : "先前版本"} placeholder={en ? "Previous designs" : "先前版本"} value={previousConcepts.some((item) => item.id === selected.id) ? selected.id : ""} onValueChange={(value) => { if (value) router.push(`/dev/${value}/${screen}`); }} options={previousConcepts.map((item) => ({ value: item.id, label: item.name }))} />
        <Link className={styles.exit} href="/">{en ? "Current site" : "返回正式版"} <ArrowUpRight size={14} /></Link>
      </div>
      <div className={styles.frame}>
        <header className={styles.header}>
          <Link href={base} className={styles.brand} aria-label="Orbie"><OrbieMark variant={selected.id === "orbit" || selected.id === "edge" ? "dark" : "light"} size={30} /><span>orbie</span></Link>
          <div className={styles.search}><AddressSearch /></div>
          <AccountControls />
        </header>
        <nav className={styles.navigation} aria-label={t("nav.primary")}>
          <span className={styles.navCaption}>{en ? "WORKSPACE" : "工作空間"}</span>
          {nav.map((item) => {
            const id = item.href === "/" ? "home" : item.href.slice(1);
            const Icon = item.icon;
            return <Link key={id} href={`${base}/${id}`} aria-current={screen === id ? "page" : undefined}><Icon size={18} strokeWidth={1.7} />{t(item.label)}<ArrowUpRight className={styles.navArrow} size={14} /></Link>;
          })}

        </nav>
        <main id="lab-main" tabIndex={-1} className={styles.main}>
          <div className={styles.direction}><span>Workspace</span><span>/</span><span>{t(nav.find((item) => (item.href === "/" ? "home" : item.href.slice(1)) === screen)?.label ?? "nav.home")}</span></div>
          {screen === "home" ? <LabHome base={base} /> : null}
          {screen === "explore" ? <BoardsView /> : null}
          {screen === "portfolio" ? <PortfolioView /> : null}
          {screen === "favorites" ? <FavoritesView /> : null}
          {screen === "insights" ? <InsightsView tierPicker /> : null}
          {screen === "settings" ? <SettingsView /> : null}
          {screen === "extras" ? <LabExtras base={base} numbers={numbers} /> : null}
          <footer className={styles.footer}><span>Orbie · Hyperliquid</span><Link href={`${base}/extras`}>{en ? "Scoring methodology" : "評分方法"} <ArrowUpRight size={13} /></Link></footer>
          <p className={styles.previewNote}>{en ? "Interactive style preview · Uses existing data and account actions. Trader details and address search open the current site." : "互動樣式預覽 · 使用現有資料與帳戶操作；交易員詳情與地址搜尋會開啟正式版頁面。"}</p>
        </main>
      </div>
    </div>
  );
}

function LabHome({ base }: { base: string }) {
  const { locale, t } = useI18n();
  const en = locale === "en";
  const home = useHomeBoards();
  const settings = useSiteSettings();
  const [sort, setSort] = useState<"copyScore" | "pnl" | "roi">("copyScore");
  const [group, setGroup] = useState<"crypto" | "stocks" | "featured">("crypto");
  const coins = [...(settings.data?.cryptoBoards ?? ["BTC", "ETH", "SOL", "DOGE", "HYPE", "ZEC", "NEAR"]), ...(settings.data?.stockBoards ?? ["xyz:SP500", "xyz:GOLD", "xyz:CL", "xyz:NVDA", "xyz:TSLA", "xyz:BRENTOIL", "xyz:SILVER"])];
  const items = [...(home.data?.[group] ?? [])].sort((a, b) => (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity));
  return (
    <div className={styles.home}>
      <section className={styles.intro}>
        <div><span className={styles.financeEyebrow}>{en ? "A CLEARER VIEW OF YOUR NEXT MOVE" : "讓下一步，更有把握。"}</span><h1>{en ? "Discover traders" : "探索交易員"}</h1><p>{en ? "Compare performance. Find a strategy that fits." : "比較績效與交易風格，找到適合你的策略。"}</p></div>
        <Link href={`${base}/favorites`} className={styles.cta}><Bookmark size={16} />{en ? "My watchlist" : "我的收藏"}</Link>
      </section>
      <section className={styles.markets}>
        <h2 className={styles.marketLabel}>{en ? "Markets" : "市場"}</h2>
        <div className={styles.coins}>{coins.map((coin) => <Link key={coin} href={`${base}/explore?${new URLSearchParams({ board: coin, sort: "pnl", ...(coin.includes(":") ? { market: "stocks" } : {}) })}`}><CoinIcon coin={coin} size={18} /><span>{boardCoinLabel(coin, t)}</span><ArrowUpRight size={13} /></Link>)}</div>
      </section>
      <section className={styles.leaders}>
        <div className={styles.sectionTitle}><h2>{en ? "Trader rankings" : "交易員排行"}</h2><Link href={`${base}/explore`}>{en ? "All traders" : "完整榜單"} <ArrowRight size={15} /></Link></div>
        <div className={styles.filters} role="group" aria-label={en ? "Trader category" : "交易員分類"}>{(["crypto", "stocks", "featured"] as const).map((key) => <button key={key} type="button" aria-pressed={group === key} onClick={() => setGroup(key)}>{key === "crypto" ? (en ? "Crypto" : "加密貨幣") : key === "stocks" ? (en ? "Stocks & commodities" : "股票與商品") : (en ? "Featured KOLs" : "精選 KOL")}</button>)}<label className={styles.sort}><SlidersHorizontal size={14} /><span>{en ? "Sort by" : "排序"}</span><Select size="sm" label={en ? "Sort traders" : "交易員排序"} value={sort} onValueChange={(value) => setSort(value as typeof sort)} options={[{ value: "copyScore", label: en ? "Copy score" : "跟單評分" }, { value: "pnl", label: en ? "Profit & loss" : "損益" }, { value: "roi", label: "ROI" }]} /></label></div><div className={styles.period}>{en ? "All-time performance · Select a trader to view positions and trading history." : "全部期間績效 · 點選交易員，查看持倉與交易紀錄。"}</div>
        {home.isError && !home.data ? <ErrorState onRetry={() => home.refetch()} /> : !home.data ? <div className={styles.loading}>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div> : items.length === 0 ? <p className={styles.empty}>{en ? "No traders in this market yet. Try another category." : "這個分類尚無交易員，請切換其他分類。"}</p> : <div className={styles.traders}><div className={styles.tableHead}><span>{en ? "Trader" : "交易員"}</span><span>{en ? "PnL / USD" : "損益 / USD"}</span><span>ROI</span><span>{en ? "PnL trend" : "損益趨勢"}</span><span>{en ? "Score" : "評分"}</span><span /></div>{items.slice(0, 6).map((trader, index) => <TraderRow trader={trader} index={index} key={trader.address} />)}</div>}
      </section>
      <HistoricalSimulator traders={home.data?.calculator ?? []} loading={!home.data && !home.isError} error={home.isError && !home.data} onRetry={() => { void home.refetch(); }} />
      <aside className={styles.research}>
        <div className={styles.help}><h2>{en ? "Build your watchlist" : "建立你的觀察清單"}</h2><p>{en ? "Save traders to compare their performance and follow their activity in one place." : "收藏感興趣的交易員，集中比較績效並追蹤交易動態。"}</p><Link href={`${base}/favorites`}>{en ? "Open watchlist" : "查看收藏"}<ArrowRight size={15} /></Link></div>
        <Link href={`${base}/insights`} className={styles.insightLink}><span>{en ? "Market insights" : "市場洞察"}</span><ArrowUpRight size={16} /></Link>
        <Link href={`${base}/extras`} className={styles.insightLink}><span>{en ? "How scores work" : "評分如何計算"}</span><ArrowUpRight size={16} /></Link>
      </aside>
    </div>
  );
}

function TraderRow({ trader, index }: { trader: BoardTrader; index: number }) {
  const { locale } = useI18n();
  return <Link className={styles.trader} href={`/trader/${trader.address}`}>
    <div className={styles.identity}><span className={styles.rank}>{String(index + 1).padStart(2, "0")}</span><TraderAvatar trader={trader} size={32} /><span><strong>{boardName(trader)}</strong><small>{trader.topCoins.slice(0, 3).join(" · ") || (locale === "en" ? "Trader" : "交易員")}</small></span></div>
    <span className={`${styles.metric} ${(trader.pnl ?? 0) < 0 ? styles.loss : styles.gain}`}>{trader.pnl == null ? "—" : boardPnl(trader.pnl)}</span>
    <span className={`${styles.metric} ${(trader.roi ?? 0) < 0 ? styles.loss : styles.gain}`}>{boardRoi(trader.roi)}</span>
    <div className={styles.spark}><BoardSparkline values={trader.sparkline} height={68} /></div><span className={styles.score}><small>{locale === "en" ? "Copy score" : "跟單評分"}</small>{trader.copyScore ?? "—"}</span><ArrowRight className={styles.rowArrow} size={15} />
  </Link>;
}
