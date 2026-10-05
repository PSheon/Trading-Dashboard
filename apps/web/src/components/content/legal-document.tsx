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
    <article className="mx-auto w-full max-w-[760px] pt-4 pb-16">
      <Link href="/" className="text-sm font-extrabold text-primary-text underline underline-offset-2 hover:text-primary-text/80">
        ← {APP_NAME}
      </Link>
      <h1 className="type-h1 mt-5">
        <InlineText text={title} />
      </h1>
      {date ? (
        <p className="mt-2 text-sm leading-[1.6] font-bold text-muted-foreground">
          <InlineText text={date.text} />
        </p>
      ) : null}
      {notices.length > 0 ? <MarkdownBlocks blocks={notices} /> : null}
      <MarkdownBlocks
        blocks={date ? others : body}
        className="mt-2 leading-7 text-[15px] [&_h2]:mt-9 [&_h2]:mb-2 [&_h2]:font-display [&_h2]:text-[22px] [&_h2]:leading-[1.4] [&_h3]:font-display [&_h3]:text-[17px] [&_li]:leading-7 [&_p]:my-[14px] [&_p]:text-muted-foreground [&_li]:text-muted-foreground"
      />
    </article>
  );
}
