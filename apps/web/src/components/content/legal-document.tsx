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
 * docs/content sits under the date until the owner removes it.
 */
export function LegalDocument({ page, locale }: { page: ContentPage; locale: Locale }) {
  const { title, rest } = splitTitle(contentBlocks(page, locale));
  const notices = rest.filter((b): b is Extract<Block, { type: "quote" }> => b.type === "quote");
  const body = rest.filter((b) => b.type !== "quote");
  const [first, ...others] = body;
  const date = first?.type === "paragraph" ? first : null;
  return (
    <article className="mx-auto w-full max-w-[760px] px-5 pt-10 pb-24 md:pt-12">
      <Link href="/" className="text-[0.9375rem] text-primary underline underline-offset-2 hover:text-primary/80">
        ← {APP_NAME}
      </Link>
      <h1 className="mt-8 text-[1.75rem] leading-tight font-bold tracking-tight md:text-[2rem]">
        <InlineText text={title} />
      </h1>
      {date ? (
        <p className="mt-3 text-[0.9375rem] text-muted-foreground">
          <InlineText text={date.text} />
        </p>
      ) : null}
      {notices.length > 0 ? <MarkdownBlocks blocks={notices} /> : null}
      <MarkdownBlocks blocks={date ? others : body} className="mt-2" />
    </article>
  );
}
