import { ChevronDown } from "lucide-react";

import { InlineText, MarkdownBlocks } from "@/components/content/markdown";
import type { Block } from "@/lib/markdown";

interface Question {
  question: string;
  answer: Block[];
}
interface Section {
  title: string | null;
  questions: Question[];
}

/** docs/content/faq.*.md → sections (`##`) of questions (`###`) and their
 * answers (everything up to the next heading). */
export function faqSections(blocks: Block[]): Section[] {
  const sections: Section[] = [];
  let section: Section | null = null;
  let question: Question | null = null;
  for (const block of blocks) {
    if (block.type === "heading" && block.level === 1) continue;
    if (block.type === "heading" && block.level === 2) {
      section = { title: block.text, questions: [] };
      sections.push(section);
      question = null;
      continue;
    }
    if (block.type === "heading" && block.level === 3) {
      if (!section) {
        section = { title: null, questions: [] };
        sections.push(section);
      }
      question = { question: block.text, answer: [] };
      section.questions.push(question);
      continue;
    }
    question?.answer.push(block);
  }
  return sections.filter((s) => s.questions.length > 0);
}

/**
 * CopyDog's 常見問題 (`/help`): a centred title and one column of questions
 * that open in place, the first one open. Orbie's FAQ is longer, so its
 * `##` groups show as small labels between the questions. Plain
 * <details>: works without JavaScript and with find-in-page. Sizes are
 * CopyDog's `.faq-item`: 672px column, 20px/600 question with 20px above
 * and below, 18px chevron, 16px/1.7 answer with 20px under it.
 */
export function FaqList({ sections }: { sections: Section[] }) {
  let index = 0;
  return (
    <div className="mx-auto w-full max-w-[672px]">
      {sections.map((section, s) => (
        <section key={s} aria-label={section.title ?? undefined} className="mt-10 first:mt-0">
          {section.title ? (
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">
              <InlineText text={section.title} />
            </h2>
          ) : null}
          <div className="border-t border-border">
            {section.questions.map((q) => {
              const open = index++ === 0;
              return (
                <details key={q.question} open={open} className="group border-b border-border">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[20px] leading-[30px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <span>
                      <InlineText text={q.question} />
                    </span>
                    <ChevronDown aria-hidden className="size-[18px] shrink-0 text-subtle-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <MarkdownBlocks blocks={q.answer} className="-mt-3 pb-5 text-base leading-[27.2px] text-muted-foreground [&_p]:my-0 [&_p+p]:mt-3" />
                </details>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
