import type { Metadata } from "next";

import { LegalDocument } from "@/components/content/legal-document";
import { getLocale } from "@/i18n/server";
import { contentBlocks, splitTitle } from "@/lib/content";
import { inlineText } from "@/lib/markdown";

export async function generateMetadata(): Promise<Metadata> {
  return { title: inlineText(splitTitle(contentBlocks("privacy", await getLocale())).title) };
}

/** CopyDog's /privacy. Text: docs/content/privacy.*.md (copied by content:sync). */
export default async function PrivacyPage() {
  return <LegalDocument page="privacy" locale={await getLocale()} />;
}
