"use client";

import { useState } from "react";

import { DASH, links, num, price, short, time } from "@/lib/format";
import type { TradeView } from "@/lib/views";

const PAGE = 300;

export function TradesTable({ trades }: { trades: TradeView[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? trades : trades.slice(0, PAGE);
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="left">Time (UTC)</th><th className="left">Token</th><th className="left">Side</th>
              <th>Tokens</th><th>SOL</th><th>Price (SOL)</th><th>Fee (SOL)</th><th className="left">Tx</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={`${t.tx_sig}-${t.mint}`}>
                <td className="left">{time(t.block_time)}</td>
                <td className="left">
                  <a href={links.solscanToken(t.mint)} target="_blank" rel="noreferrer" className="mono">{short(t.mint)}</a>
                </td>
                <td className="left">{t.side}</td>
                <td>{Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(t.tokens)}</td>
                <td>{t.sol == null ? DASH : num(t.sol)}</td>
                <td className={t.low_confidence ? "muted" : ""}>{price(t.price_sol)}</td>
                <td>{num(t.fee_sol, 5)}</td>
                <td className="left">
                  <a href={links.solscanTx(t.tx_sig)} target="_blank" rel="noreferrer" className="mono">{short(t.tx_sig)}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!all && trades.length > PAGE && (
        <button style={{ marginTop: 8 }} onClick={() => setAll(true)}>Show all {trades.length}</button>
      )}
    </>
  );
}
