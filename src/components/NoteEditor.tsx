"use client";

import { useState } from "react";

import { saveNote } from "@/app/actions";
import { NOTE_MAX_CHARS } from "@/lib/universe";

export function NoteEditor({ address, initial }: { address: string; initial: string }) {
  const [status, setStatus] = useState("");
  return (
    <div className="controls" style={{ margin: 0 }}>
      <input
        style={{ flex: 1, minWidth: 240 }}
        defaultValue={initial}
        placeholder="Your note on this wallet"
        maxLength={NOTE_MAX_CHARS}
        onChange={() => setStatus("")}
        onBlur={async (e) => {
          const res = await saveNote(address, e.target.value);
          setStatus("error" in res ? res.error : "Saved");
        }}
      />
      <span className="status">{status}</span>
    </div>
  );
}
