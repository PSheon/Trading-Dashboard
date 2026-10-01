import Link from "next/link";

import { InlineText, MarkdownBlocks } from "@/components/content/markdown";
import type { Locale } from "@/i18n/config";
import { APP_NAME } from "@/lib/config";
import { contentBlocks, splitTitle, type ContentPage } from "@/lib/content";
import type { Block } from "@/lib/markdown";

/**
 * CopyDog's legal pages (`/privacy`, `/terms`, `/delete-account`): a bare
 * reading page without the app frame — "← Copydog", the title, the
 * effective / updated date, then the sections. The draft notice from
 * docs/content sits under the date until the owner removes it. Sizes are
 * CopyDog's: a 760px column, 28px/1.6 title, 14px date, 18px/1.6 section
 * headings 32px above, 15px/24px paragraphs 15px apart.
 */
export function LegalDocument({ page, locale }: { page: ContentPage; locale: Locale }) {
  const { title, rest } = splitTitle(contentBlocks(page, locale));
  const notices = rest.filter((b): b is Extract<Block, { type: "quote" }> => b.type === "quote");
  const body = rest.filter((b) => b.type !== "quote");
  const [first, ...others] = body;
  const date = first?.type === "paragraph" ? first : null;
  return (
    <article className="mx-auto w-full max-w-[800px] px-5 pt-10 pb-24">
      <Link href="/" className="text-[0.9375rem] text-primary underline underline-offset-2 hover:text-primary/80">
        ← {APP_NAME}
      </Link>
      <h1 className="mt-[31px] text-[28px] leading-[1.6] font-bold">
        <InlineText text={title} />
      </h1>
      {date ? (
        <p className="mt-1 text-sm leading-[1.6] text-subtle-foreground">
          <InlineText text={date.text} />
        </p>
      ) : null}
      {notices.length > 0 ? <MarkdownBlocks blocks={notices} /> : null}
      <MarkdownBlocks
        blocks={date ? others : body}
        className="mt-2 leading-6 [&_h2]:mt-8 [&_h2]:mb-2 [&_h2]:text-[18px] [&_h2]:leading-[1.6] [&_li]:leading-6 [&_p]:my-[15px]"
      />
    </article>
  );
}
