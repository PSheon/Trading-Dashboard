// Human-authored data: notes. It cannot be rebuilt from raw, so it lives in
// SQLite beside the warehouse, never inside a table a rebuild would replace.
// Back this file up.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Note {
  note: string;
  updated_at: number;
}

export class Notes {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS wallet_notes (address TEXT PRIMARY KEY, note TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
  }

  all(): Map<string, Note> {
    const rows = this.db.prepare("SELECT address, note, updated_at FROM wallet_notes").all() as {
      address: string;
      note: string;
      updated_at: number;
    }[];
    return new Map(rows.map((r) => [r.address, { note: r.note, updated_at: Number(r.updated_at) }]));
  }

  get(address: string): Note | null {
    const r = this.db.prepare("SELECT note, updated_at FROM wallet_notes WHERE address = ?").get(address) as
      | { note: string; updated_at: number }
      | undefined;
    return r ? { note: r.note, updated_at: Number(r.updated_at) } : null;
  }

  set(address: string, note: string, now = Math.floor(Date.now() / 1000)): Note {
    const text = note.trim();
    if (text) {
      this.db
        .prepare(
          "INSERT INTO wallet_notes (address, note, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(address) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at",
        )
        .run(address, text, now);
    } else {
      this.db.prepare("DELETE FROM wallet_notes WHERE address = ?").run(address);
    }
    return { note: text, updated_at: now };
  }
}
