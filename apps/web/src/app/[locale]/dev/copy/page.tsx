import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ExecutionWalletSettings } from "@/components/settings/execution-wallets";
import { labEnabled } from "@/lib/dev-lab";

export const metadata: Metadata = {
  title: "Copy setup forms",
  robots: { index: false, follow: false },
};

/** The step-by-step testnet copy forms (wallet, deposit, account mode, agent,
 * mandate), for development and support: one-click setup on the trader page
 * replaced them for users. Lab only: 404 in production unless NEXT_DEV_LAB=1. */
export default function DevCopyPage() {
  if (!labEnabled()) notFound();
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <ExecutionWalletSettings />
    </main>
  );
}
