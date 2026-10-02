import { expect, it, vi } from "vitest";

const options = vi.hoisted(() => ({ last: undefined as Record<string, unknown> | undefined }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (o: Record<string, unknown>) => { options.last = o; return {}; },
}));

import { useSiteSettings } from "@/lib/queries";
import { queryKeys } from "@/lib/query-keys";

it("an open tab re-reads the public settings every minute and on focus, so a kill switch or maintenance notice shows without a reload", () => {
  useSiteSettings();
  expect(options.last).toMatchObject({ queryKey: queryKeys.siteSettings, refetchOnWindowFocus: true });
  expect(options.last!.refetchInterval).toBeLessThanOrEqual(60_000);
  expect(options.last!.staleTime).toBeLessThanOrEqual(60_000);
});
