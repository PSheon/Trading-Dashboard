import type { Metadata } from "next";

import { LegalDocument } from "@/components/content/legal-document";
import { getLocale } from "@/i18n/server";
import { contentBlocks, splitTitle } from "@/lib/content";
import { inlineText } from "@/lib/markdown";

export async function generateMetadata(): Promise<Metadata> {
  return { title: inlineText(splitTitle(contentBlocks("terms", await getLocale())).title) };
}

/** CopyDog's /terms. Text: docs/content/terms.*.md (copied by content:sync). */
export default async function TermsPage() {
  return <LegalDocument page="terms" locale={await getLocale()} />;
}
