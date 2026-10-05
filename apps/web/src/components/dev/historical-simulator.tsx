"use client";

import { Select } from "@/components/ui/select";
import { Link } from "@/i18n/navigation";
import { ArrowDownRight, ArrowUpRight, Info } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { AreaChart } from "@/components/charts/area-chart";
import { boardName, TraderAvatar } from "@/components/discover/board-bits";
import { ErrorState, Skeleton } from "@/components/page";
import { useI18n } from "@/i18n/provider";
import type { BoardTrader } from "@/lib/contracts";
import { historicalSimulation } from "./historical-simulation";
import styles from "./historical-simulator.module.css";

export function HistoricalSimulator({ traders, loading, error, onRetry }: {
  traders: BoardTrader[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const { locale } = useI18n();
  const en = locale === "en";
  const id = useId();
  const [selected, setSelected] = useState("");
  const [amount, setAmount] = useState(1000);
  const trader = traders.find((item) => item.address === selected) ?? traders[0];
  const simulation = useMemo(() => trader ? historicalSimulation(amount, trader.roi, trader.sparkline) : null, [trader, amount]);
  const money = (value: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  const roi = trader?.roi;
  const negative = roi !== null && roi !== undefined && roi < 0;
  const Arrow = negative ? ArrowDownRight : ArrowUpRight;
  return (
    <section id="historical-simulator" className={styles.panel} aria-labelledby={`${id}-title`}>
      <header className={styles.heading}>
        <div><span className={styles.eyebrow}>PERFORMANCE SIMULATOR</span><h2 id={`${id}-title`}>{en ? "Historical performance simulator" : "歷史績效試算"}</h2><p>{en ? "Choose a trader and an amount to explore their historical ROI." : "選擇交易員與投入金額，即時試算歷史 ROI 對應的結果。"}</p></div>
        <span className={styles.period}>{en ? "All-time ROI" : "全部期間 ROI"}</span>
      </header>
      {loading ? <div className={styles.loading}><Skeleton className="h-72" /><Skeleton className="h-72" /></div> : error ? <ErrorState onRetry={onRetry} /> : !trader ? <p className={styles.empty}>{en ? "No historical performance is available yet." : "目前尚無歷史績效可供試算。"}</p> : (
        <div className={styles.body}>
          <div className={styles.controls}>
            <label className={styles.label} htmlFor={`${id}-trader`}>{en ? "Trader" : "選擇交易員"}</label>
            <div className={styles.traderSelect}>
              <TraderAvatar trader={trader} size={32} />
              <Select id={`${id}-trader`} className="min-w-0 flex-1" value={trader.address} onValueChange={setSelected} options={traders.map((item) => ({ value: item.address, label: boardName(item) }))} />
            </div>
            <Link className={styles.profile} href={`/trader/${trader.address}`}>{en ? "View trader profile" : "查看交易員詳情"}<ArrowUpRight size={14} /></Link>
            <label className={styles.label} htmlFor="calc-amount">{en ? "Initial investment" : "投入金額"}</label>
            <div className={styles.amount}><span aria-hidden>$</span><input id="calc-amount" inputMode="numeric" autoComplete="off" value={amount.toLocaleString("en-US")} onChange={(event) => setAmount(Math.min(1_000_000, Number(event.target.value.replace(/[^0-9]/g, "")) || 0))} aria-describedby={`${id}-limit`} /><span>USD</span></div>
            <div className={styles.presets} role="group" aria-label={en ? "Investment presets" : "快速選擇金額"}>{[1000, 5000, 10000].map((value) => <button key={value} type="button" aria-pressed={amount === value} onClick={() => setAmount(value)}>${value.toLocaleString("en-US")}</button>)}</div>
            <p className={styles.limit} id={`${id}-limit`}>{en ? "Enter $0–$1,000,000. Results update automatically." : "可輸入 $0–$1,000,000，結果即時更新。"}</p>
            <div className={styles.formula}><span>{en ? "How it works" : "試算方式"}</span><p>{en ? "Initial investment × (1 + historical ROI)" : "投入金額 ×（1 + 歷史 ROI）"}</p></div>
          </div>
          <div className={`${styles.result} ${negative ? styles.negative : styles.positive}`}>
            <div className={styles.resultTop}><span>{en ? "Illustrative ending value" : "試算期末金額"}</span><span className={styles.roi}>{simulation ? <><Arrow size={14} aria-hidden />{roi! > 0 ? "+" : ""}{(roi! * 100).toFixed(2)}%</> : "—"}</span></div>
            <div className={styles.total} aria-live="polite" aria-atomic="true">{simulation ? money(simulation.total) : "—"}</div>
            <div className={styles.breakdown}><span>{en ? "Initial" : "本金"}<strong>{money(amount)}</strong></span><span>{en ? "Illustrative PnL" : "試算損益"}<strong className={styles.profit}>{simulation ? `${simulation.profit > 0 ? "+" : ""}${money(simulation.profit)}` : "—"}</strong></span></div>
            {simulation && simulation.series.length > 0 ? <div className={styles.chart}><AreaChart data={simulation.series} height={176} zeroBaseline={false} interactive formatValue={money} formatTime={(index) => en ? `Sample ${index + 1}` : `樣本 ${index + 1}`} ariaLabel={en ? "Illustrative return curve, normalized to the investment amount" : "依投入金額換算的報酬示意曲線"} /><div className={styles.chartLabels}><span>{en ? "Starting amount" : "起始投入"}</span><span>{en ? "Illustrative ending value" : "試算期末"}</span></div></div> : <p className={styles.noChart}>{!simulation ? (en ? "This trader’s ROI is not available yet." : "這位交易員的 ROI 尚未提供。") : (en ? "Not enough data to illustrate a return curve." : "目前資料不足，暫無報酬示意曲線。")}</p>}
          </div>
        </div>
      )}
      <footer className={styles.note}><Info size={15} aria-hidden /><p>{en ? "An illustration using all-time ROI and a normalized PnL curve, not a trade-by-trade backtest. Fees and slippage are excluded. Past performance does not guarantee future returns." : "以全部期間 ROI 與標準化損益曲線示意，非逐筆交易回測；不含手續費與滑價。過往績效不代表未來報酬。"}</p></footer>
    </section>
  );
}
