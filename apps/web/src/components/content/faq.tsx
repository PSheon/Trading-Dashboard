import { FaqAccordion } from "@/components/content/faq-accordion";
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
 * CopyDog's 常見問題 (`/help`): a centred title and one 672px column of
 * questions that open in place (FaqAccordion). Orbie's `##` groups only
 * order the questions (CopyDog shows one plain list, so no group labels).
 * The text is rendered here, on the server, and handed to the accordion.
 */
export function FaqList({ sections }: { sections: Section[] }) {
  const questions = sections.flatMap((section) => section.questions);
  return (
    <div className="mx-auto w-full max-w-[672px]">
      <FaqAccordion
        items={questions.map((q) => ({
          question: <InlineText text={q.question} />,
          answer: <MarkdownBlocks blocks={q.answer} className="-mt-3 pb-5 text-base leading-[27.2px] text-muted-foreground [&_p]:my-0 [&_p+p]:mt-3" />,
        }))}
      />
    </div>
  );
}
