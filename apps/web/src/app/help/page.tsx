import { InlineText } from "@/components/content/markdown";
import { FaqList, faqSections } from "@/components/content/faq";
import { JsonLd } from "@/components/json-ld";
import { SiteFooter } from "@/components/shell/site-footer";
import { getLocale } from "@/i18n/server";
import { contentBlocks, splitTitle } from "@/lib/content";
import { inlineText } from "@/lib/markdown";
import { blocksText, contentSeo, faqJsonLd } from "@/lib/seo";

export const generateMetadata = contentSeo("faq", "/help", (m) => m.meta.pages.help);

/** CopyDog's /help (常見問題). Text: docs/content/faq.*.md (copied by content:sync). */
export default async function HelpPage() {
  const blocks = contentBlocks("faq", await getLocale());
  const { title } = splitTitle(blocks);
  const sections = faqSections(blocks);
  const questions = sections.flatMap((section) => section.questions);
  return (
    // CopyDog's `.hl-page`: 16px page edges on phones; on desktop the page is
    // centred between the rail and the window edge (x=758 at 1440), the
    // title 56px/84px with 40px under it.
    <div className="-mx-1 pt-[13px] md:-mr-4 md:-ml-8 md:pt-4">
      {/* CopyDog's FAQPage: every question with its answer as text. */}
      <JsonLd data={faqJsonLd(questions.map((q) => ({ question: inlineText(q.question), answer: blocksText(q.answer) })))} />
      <h1 className="text-center text-[56px] leading-[84px] font-bold tracking-tight">
        <InlineText text={title} />
      </h1>
      <div className="mt-10">
        <FaqList sections={sections} />
      </div>
      <SiteFooter className="mt-20" />
    </div>
  );
}
