import Link from "next/link";
import { Fragment } from "react";
import { cn } from "cn";

import { parseInline, type Block, type Inline } from "@/lib/markdown";

/** Inline runs as React. Site paths use next/link; the owner's
 * 【待填：…】 placeholders are lit so they can't be missed. */
export function InlineText({ text }: { text: string }) {
  return <>{renderInline(parseInline(text))}</>;
}

function renderInline(nodes: Inline[]): React.ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <Fragment key={i}>{node.text}</Fragment>;
      case "bold":
        return (
          <strong key={i} className="font-semibold text-foreground">
            {renderInline(node.children)}
          </strong>
        );
      case "code":
        return (
          <code key={i} className="rounded bg-raised px-1 py-0.5 font-mono text-[0.85em]">
            {node.text}
          </code>
        );
      case "placeholder":
        return (
          <mark key={i} className="rounded bg-primary/15 px-1 text-primary-text">
            {node.text}
          </mark>
        );
      case "link":
        return node.href.startsWith("/") ? (
          <Link key={i} href={node.href} className="text-primary-text underline underline-offset-2 decoration-primary/50 hover:decoration-primary">
            {renderInline(node.children)}
          </Link>
        ) : (
          <a key={i} href={node.href} target="_blank" rel="noopener noreferrer" className="text-primary-text underline underline-offset-2 decoration-primary/50 hover:decoration-primary">
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

/**
 * A long-form document in CopyDog's legal-page style (privacy, terms,
 * delete-account): section headings, readable paragraphs, lists and
 * tables. The draft notice (a leading quote) shows as a callout.
 */
export function MarkdownBlocks({ blocks, className }: { blocks: Block[]; className?: string }) {
  return (
    <div className={cn("text-[0.9375rem] leading-7 text-foreground/85", className)}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading": {
            if (block.level <= 2)
              return (
                <h2 key={i} className="mt-10 mb-3 text-xl font-bold tracking-tight text-foreground">
                  <InlineText text={block.text} />
                </h2>
              );
            return (
              <h3 key={i} className="mt-6 mb-2 text-base font-semibold text-foreground">
                <InlineText text={block.text} />
              </h3>
            );
          }
          case "paragraph":
            return (
              <p key={i} className="my-3">
                <InlineText text={block.text} />
              </p>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={i} className={cn("my-3 space-y-1.5 pl-6", block.ordered ? "list-decimal" : "list-disc")}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <InlineText text={item} />
                  </li>
                ))}
              </List>
            );
          }
          case "table":
            return (
              <div key={i} className="my-4 overflow-x-auto rounded-xl border border-border">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-raised/60">
                      {block.head.map((cell, j) => (
                        <th key={j} className="px-3 py-2 text-left font-semibold text-foreground">
                          <InlineText text={cell} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, j) => (
                      <tr key={j} className="border-t border-border">
                        {row.map((cell, k) => (
                          <td key={k} className="px-3 py-2 align-top">
                            <InlineText text={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "quote":
            return (
              <p key={i} role="note" className="my-4 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
                <InlineText text={block.text} />
              </p>
            );
          case "small":
            return (
              <p key={i} className="my-2 text-xs text-subtle-foreground">
                <InlineText text={block.text} />
              </p>
            );
          case "hr":
            return <hr key={i} className="my-8 border-border" />;
        }
      })}
    </div>
  );
}
