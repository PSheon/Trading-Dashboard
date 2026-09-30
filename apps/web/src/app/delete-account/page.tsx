import type { Metadata } from "next";

import { LegalDocument } from "@/components/content/legal-document";
import { getLocale } from "@/i18n/server";
import { contentBlocks, splitTitle } from "@/lib/content";
import { inlineText } from "@/lib/markdown";

export async function generateMetadata(): Promise<Metadata> {
  return { title: inlineText(splitTitle(contentBlocks("deleteAccount", await getLocale())).title) };
}

/** CopyDog's /delete-account: how deletion works and what is kept. Text:
 * docs/content/delete-account.*.md (copied by content:sync). */
export default async function DeleteAccountPage() {
  return <LegalDocument page="deleteAccount" locale={await getLocale()} />;
}
