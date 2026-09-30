import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it.each(["admin/admin-users", "common/auth/auth", "api/actions/actions", "telegram/telegram-link", "outbox/outbox", "notify/notify", "rules/rules", "import/import", "watcher/account-state", "watcher/fill-sync"])(
  "%s service delegates persistence to a feature repository", feature => {
    const source = readFileSync(new URL("../src/" + feature + ".service.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/DRIZZLE_CLIENT|from ["']drizzle-orm|from ["']@trading-dashboard\/shared\/database/);
    expect(source).not.toMatch(/\b(?:this\.db|tx)\.(?:select|insert|update|delete|execute|transaction)\(/);
    expect(source).toContain(".repository.js");
  },
);
