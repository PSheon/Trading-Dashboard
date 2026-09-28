"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { addWalletsAction } from "@/app/actions";

import { Icon } from "./Icon";

export function AddWallets() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [via, setVia] = useState("manual");
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [pending, start] = useTransition();
  return (
    <details className="card">
      <summary>
        <Icon name="plus" />
        Add wallets
      </summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const res = await addWalletsAction(text, via);
            if ("error" in res) return setStatus({ text: res.error, error: true });
            setStatus({ text: `Added ${res.added.length}, already known ${res.alreadyKnown}. Run the daily job to fetch them.` });
            setText("");
            router.refresh();
          });
        }}
      >
        <textarea
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Solana addresses, one per line or separated by spaces (up to 500)"
          aria-label="Wallet addresses"
        />
        <div className="toolbar" style={{ border: 0, padding: "12px 0 0", margin: 0, background: "none" }}>
          <label className="field"><span>Source</span>
            <select value={via} onChange={(e) => setVia(e.target.value)}>
              <option value="manual">manual</option>
              <option value="public_leaderboard">public_leaderboard</option>
              <option value="token_funnel">token_funnel</option>
            </select>
          </label>
          <button className="primary" type="submit" disabled={pending || !text.trim()}>
            <Icon name={pending ? "loader" : "plus"} size={14} />
            Add wallets
          </button>
          {status && <span className={`count ${status.error ? "error" : ""}`}>{status.text}</span>}
        </div>
      </form>
    </details>
  );
}
