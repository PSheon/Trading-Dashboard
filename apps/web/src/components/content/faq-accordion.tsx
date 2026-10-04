"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "cn";

export interface FaqItem {
  question: React.ReactNode;
  answer: React.ReactNode;
}

/**
 * CopyDog's `.faq-item` list: each question is a button (`aria-expanded`)
 * over its answer; the first starts open and opening one closes the other.
 * A closed answer stays in the document (hidden), as CopyDog's does, so the
 * text is in the served HTML. Sizes are CopyDog's: 20px/600 question with
 * 20px above and below, 18px chevron, 16px/1.7 answer with 20px under it.
 */
export function FaqAccordion({ items }: { items: FaqItem[] }) {
  const [open, setOpen] = useState<number | null>(0);
  const base = useId();
  return (
    <div className="flex flex-col gap-3">
      {items.map((item, index) => {
        const expanded = open === index;
        const panel = `${base}-answer-${index}`;
        return (
          <div key={index} className={cn("rounded-[26px] px-5 transition-colors", expanded ? "bg-raised" : "bg-raised hover:bg-raised-hover")}>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panel}
              onClick={() => setOpen(expanded ? null : index)}
              className="flex min-h-[60px] w-full items-center justify-between gap-4 py-4 text-left text-base leading-6 font-extrabold outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>{item.question}</span>
              <ChevronDown aria-hidden strokeWidth={2.6} className={cn("size-[18px] shrink-0 text-foreground transition-transform duration-200", expanded && "rotate-180")} />
            </button>
            <div id={panel} hidden={!expanded}>
              {item.answer}
            </div>
          </div>
        );
      })}
    </div>
  );
}
