import type { Metadata } from "next";

import { InlineText } from "@/components/content/markdown";
import { FaqList, faqSections } from "@/components/content/faq";
import { SiteFooter } from "@/components/shell/site-footer";
import { getLocale } from "@/i18n/server";
import { contentBlocks, splitTitle } from "@/lib/content";
import { inlineText } from "@/lib/markdown";

export async function generateMetadata(): Promise<Metadata> {
  return { title: inlineText(splitTitle(contentBlocks("faq", await getLocale())).title) };
}

/** CopyDog's /help (常見問題). Text: docs/content/faq.*.md (copied by content:sync). */
export default async function HelpPage() {
  const blocks = contentBlocks("faq", await getLocale());
  const { title } = splitTitle(blocks);
  return (
    <div className="pt-6 md:pt-10">
      <h1 className="text-center text-[2.25rem] leading-tight font-extrabold tracking-tight md:text-[3.5rem]">
        <InlineText text={title} />
      </h1>
      <div className="mt-8 md:mt-12">
        <FaqList sections={faqSections(blocks)} />
      </div>
      <SiteFooter className="mt-24" />
    </div>
  );
}
