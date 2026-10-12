import { LegalDocument } from "@/components/content/legal-document";
import { getLocale } from "@/i18n/server";
import { contentSeo } from "@/lib/seo";

export const generateMetadata = contentSeo("deleteAccount", "/delete-account", (m) => m.meta.pages.deleteAccount);

/** CopyDog's /delete-account: how deletion works and what is kept. Text:
 * docs/content/delete-account.*.md (copied by content:sync). */
export default async function DeleteAccountPage() {
  return <LegalDocument page="deleteAccount" locale={await getLocale()} />;
}
