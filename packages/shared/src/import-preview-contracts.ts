import { z } from "zod";
export const importPreviewSchema = z.object({
  sampledAt: z.string().datetime({ offset: true }),
  canImport: z.boolean(),
  totalRows: z.number().int(),
  uniqueAddresses: z.number().int(),
  duplicateRows: z.number().int(),
  newAddresses: z.number().int(),
  promotedAddresses: z.number().int(),
  preservedAddresses: z.number().int(),
  estimatedNewJobs: z.number().int(),
  errors: z.array(z.object({ index: z.number().int(), reason: z.string() })),
  items: z.array(
    z.object({
      address: z.string(),
      rank: z.number().int(),
      action: z.enum(["new", "promote", "preserve"]),
      activeAfter: z.boolean(),
      tierAfter: z.enum(["A", "B", "C"]),
    }),
  ),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;
