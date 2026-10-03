import { expect, it } from "vitest";
import { copyRecordLabel } from "@/components/copy/copy-labels";
import { catalogs } from "@/i18n/messages";

it("localizes all supported ledger kinds and copy commands in every catalog", () => {
  for (const messages of Object.values(catalogs)) {
    for (const kind of ["ledgerKinds", "commandLabels"] as const) {
      for (const [value, label] of Object.entries(messages.copyUpdates[kind])) {
        expect(copyRecordLabel(kind, value, (key) => {
          const [, group, item] = key.split(".");
          return (messages.copyUpdates[group as typeof kind] as Record<string, string>)[item];
        })).toBe(label);
      }
      expect(copyRecordLabel(kind, "future_server_value", () => { throw Error("unknown translation"); })).toBe("future server value");
      expect(copyRecordLabel(kind, "__proto__", () => { throw Error("unsafe key"); })).toBe("  proto  ");
    }
  }
});
