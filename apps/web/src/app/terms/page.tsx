import { LegalDocument } from "@/components/content/legal-document";
import { getLocale } from "@/i18n/server";
import { contentSeo } from "@/lib/seo";

export const generateMetadata = contentSeo("terms", "/terms", (m) => m.meta.pages.terms);

/** CopyDog's /terms. Text: docs/content/terms.*.md (copied by content:sync). */
export default async function TermsPage() {
  return <LegalDocument page="terms" locale={await getLocale()} />;
}
