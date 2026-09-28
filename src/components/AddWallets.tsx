"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { addWalletsAction } from "@/app/actions";

export function AddWallets() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [via, setVia] = useState("manual");
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [pending, start] = useTransition();
  return (
    <details className="card">
      <summary>Add wallets</summary>
      <form
        style={{ marginTop: 10 }}
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
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Addresses, one per line or separated by spaces" />
        <div className="controls" style={{ marginTop: 8 }}>
          <label className="field">Source
            <select value={via} onChange={(e) => setVia(e.target.value)}>
              <option value="manual">manual</option>
              <option value="public_leaderboard">public_leaderboard</option>
              <option value="token_funnel">token_funnel</option>
            </select>
          </label>
          <button className="primary" type="submit" disabled={pending}>Add</button>
          {status && <span className={`status ${status.error ? "error" : ""}`}>{status.text}</span>}
        </div>
      </form>
    </details>
  );
}
