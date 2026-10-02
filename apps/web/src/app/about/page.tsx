import { AboutPage } from "@/components/content/about-page";
import { JsonLd } from "@/components/json-ld";
import { getLocale, getMessages } from "@/i18n/server";
import { contentBlocks, splitTitle } from "@/lib/content";
import { inlineText } from "@/lib/markdown";
import { contentSeo, webPageJsonLd } from "@/lib/seo";
import { withApp } from "@/lib/seo-text";

export const generateMetadata = contentSeo("about", "/about", (m) => m.meta.pages.about);

/** CopyDog's /about. Text: docs/content/about.*.md (copied by content:sync). */
export default async function About() {
  const locale = await getLocale();
  const blocks = contentBlocks("about", locale);
  return (
    <>
      {/* As CopyDog's about page: a WebPage that belongs to the site. */}
      <JsonLd data={webPageJsonLd({ name: inlineText(splitTitle(blocks).title), description: withApp(getMessages(locale).meta.pages.about), path: "/about" })} />
      <AboutPage blocks={blocks} />
    </>
  );
}
