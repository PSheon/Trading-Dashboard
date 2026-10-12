import { LegalDocument } from "@/components/content/legal-document";
import { getLocale } from "@/i18n/server";
import { contentSeo } from "@/lib/seo";

export const generateMetadata = contentSeo("privacy", "/privacy", (m) => m.meta.pages.privacy);

/** CopyDog's /privacy. Text: docs/content/privacy.*.md (copied by content:sync). */
export default async function PrivacyPage() {
  return <LegalDocument page="privacy" locale={await getLocale()} />;
}
