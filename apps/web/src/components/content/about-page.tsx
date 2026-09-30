import { Bell, BriefcaseBusiness, ChartNoAxesColumn, Compass, CopyPlus, ScanSearch, ShieldCheck, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";

import { InlineText, MarkdownBlocks } from "@/components/content/markdown";
import { SiteFooter } from "@/components/shell/site-footer";
import { parseInline, type Block } from "@/lib/markdown";

type Heading = Extract<Block, { type: "heading" }>;

/** Splits blocks at `---`. */
function chunks(blocks: Block[]): Block[][] {
  const out: Block[][] = [[]];
  for (const b of blocks) {
    if (b.type === "hr") out.push([]);
    else out[out.length - 1].push(b);
  }
  return out.filter((c) => c.length > 0);
}

/** Groups a chunk into `##` sections (heading + what follows). */
function sections(blocks: Block[]): Array<{ heading: Heading | null; body: Block[] }> {
  const out: Array<{ heading: Heading | null; body: Block[] }> = [];
  for (const b of blocks) {
    if (b.type === "heading" && b.level === 2) out.push({ heading: b, body: [] });
    else if (out.length === 0) out.push({ heading: null, body: [b] });
    else out[out.length - 1].body.push(b);
  }
  return out;
}

/** A paragraph that is only a link: a call-to-action button. */
function ctaOf(block: Block): { href: string; label: string } | null {
  if (block.type !== "paragraph") return null;
  const nodes = parseInline(block.text);
  if (nodes.length !== 1 || nodes[0].type !== "link") return null;
  const label = nodes[0].children.map((n) => (n.type === "text" ? n.text : "")).join("");
  return { href: nodes[0].href, label };
}

/** A paragraph that is only bold text: the hero's small eyebrow line. */
function eyebrowOf(block: Block): string | null {
  if (block.type !== "paragraph") return null;
  const m = /^\*\*([^*]+)\*\*$/.exec(block.text.trim());
  return m ? m[1] : null;
}

function Cta({ href, label, className }: { href: string; label: string; className?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex h-11 items-center rounded-full bg-foreground px-6 text-sm font-semibold text-background outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {label}
    </Link>
  );
}

/** "投資組合：你的資金一目了然" → pill "投資組合" + title "你的資金一目了然". */
function splitLabel(text: string): { label: string | null; title: string } {
  const m = /^(.{1,24}?)(?:：|:\s)(.+)$/.exec(text);
  return m ? { label: m[1], title: m[2] } : { label: null, title: text };
}

const STEP_ICONS: LucideIcon[] = [ScanSearch, ChartNoAxesColumn, CopyPlus];
const FEATURE_ICONS: LucideIcon[] = [BriefcaseBusiness, Bell, Compass, ShieldCheck];

function Illustration({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex aspect-[4/3] w-full items-center justify-center rounded-3xl border border-border bg-gradient-to-br from-raised to-card",
        className,
      )}
    >
      <span className="flex size-24 items-center justify-center rounded-3xl bg-primary/12 text-primary shadow-[0_0_80px_-10px] shadow-primary/40">
        <Icon className="size-11" strokeWidth={1.6} />
      </span>
    </div>
  );
}

/**
 * CopyDog's 關於我們 (`/about`), a landing page: hero with the call to
 * action, the three steps, alternating feature sections, the funds-safety
 * block, the closing call to action and the footer. The words come from
 * docs/content/about.*.md (split by `---` and `##`); the pictures are
 * Orbie's own icon panels, not CopyDog's product mock-ups.
 */
export function AboutPage({ blocks }: { blocks: Block[] }) {
  const body = blocks.filter((b) => !(b.type === "heading" && b.level === 1));
  const parts = chunks(body);
  let feature = 0;
  return (
    <div className="flex flex-col gap-24 pt-8 md:gap-36 md:pt-16">
      {parts.map((part, p) => {
        const secs = sections(part);
        const steps = part.filter((b): b is Heading => b.type === "heading" && b.level === 3);
        // Hero: the first chunk.
        if (p === 0) {
          const [hero] = secs;
          return (
            <section key={p} className="mx-auto flex max-w-[760px] flex-col items-center text-center">
              {hero.body.map((b, i) => {
                const eyebrow = eyebrowOf(b);
                if (eyebrow) return <p key={i} className="order-first mb-4 text-xs font-semibold tracking-[0.2em] text-primary uppercase">{eyebrow}</p>;
                return null;
              })}
              {hero.heading ? (
                <h1 className="text-[2.5rem] leading-[1.1] font-extrabold tracking-tight text-balance md:text-[4.25rem]">
                  <InlineText text={hero.heading.text} />
                </h1>
              ) : null}
              {hero.body.map((b, i) => {
                if (eyebrowOf(b)) return null;
                const cta = ctaOf(b);
                if (cta) return <Cta key={i} {...cta} className="mt-7" />;
                if (b.type === "small") return <p key={i} className="mt-8 text-xs text-subtle-foreground"><InlineText text={b.text} /></p>;
                if (b.type === "paragraph") return <p key={i} className="mt-5 max-w-[560px] text-base leading-relaxed text-muted-foreground md:text-lg"><InlineText text={b.text} /></p>;
                return <MarkdownBlocks key={i} blocks={[b]} />;
              })}
            </section>
          );
        }
        // Three steps: a chunk with ### items.
        if (steps.length > 0) {
          const title = secs[0]?.heading;
          const items: Array<{ title: string; body: Block[] }> = [];
          for (const b of part) {
            if (b.type === "heading" && b.level === 3) items.push({ title: b.text.replace(/^\d+\.\s*/, ""), body: [] });
            else if (items.length > 0) items[items.length - 1].body.push(b);
          }
          return (
            <section key={p} className="mx-auto w-full max-w-[1080px]">
              {title ? (
                <h2 className="text-center text-[1.75rem] leading-tight font-extrabold tracking-tight text-balance md:text-[2.5rem]">
                  <InlineText text={title.text} />
                </h2>
              ) : null}
              <div className="mt-10 grid gap-5 md:mt-14 md:grid-cols-3">
                {items.map((item, i) => {
                  const Icon = STEP_ICONS[i % STEP_ICONS.length];
                  return (
                    <div key={i} className="flex flex-col items-center text-center">
                      <Illustration icon={Icon} className="aspect-[5/4]" />
                      <h3 className="mt-5 text-base font-bold">
                        <InlineText text={item.title} />
                      </h3>
                      <MarkdownBlocks blocks={item.body} className="mt-1 text-sm leading-relaxed text-muted-foreground [&_p]:my-1" />
                    </div>
                  );
                })}
              </div>
            </section>
          );
        }
        // Closing call to action: a heading and a link, nothing else.
        const last = secs.length === 1 && secs[0].body.length === 1 ? ctaOf(secs[0].body[0]) : null;
        if (last && secs[0].heading) {
          return (
            <section key={p} className="mx-auto flex max-w-[760px] flex-col items-center text-center">
              <h2 className="text-[2rem] leading-tight font-extrabold tracking-tight text-balance md:text-[3.25rem]">
                <InlineText text={secs[0].heading.text} />
              </h2>
              <Cta {...last} className="mt-8" />
            </section>
          );
        }
        // Feature sections, alternating sides; the funds-safety one (it has
        // a small print line) is centred with a shield, as on CopyDog.
        return (
          <div key={p} className="flex flex-col gap-24 md:gap-36">
            {secs.map((sec, s) => {
              if (!sec.heading) return <MarkdownBlocks key={s} blocks={sec.body} />;
              const smallPrint = sec.body.filter((b) => b.type === "small");
              const text = sec.body.filter((b) => b.type !== "small");
              if (smallPrint.length > 0) {
                return (
                  <section key={s} className="mx-auto flex max-w-[620px] flex-col items-center text-center">
                    <span aria-hidden className="flex size-16 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                      <ShieldCheck className="size-9" strokeWidth={1.6} />
                    </span>
                    <h2 className="mt-6 text-[1.75rem] leading-tight font-extrabold tracking-tight text-balance md:text-[2.5rem]">
                      <InlineText text={sec.heading.text} />
                    </h2>
                    <MarkdownBlocks blocks={text} className="mt-3 text-sm leading-relaxed text-muted-foreground" />
                    {smallPrint.map((b, i) => (
                      <p key={i} className="mt-4 text-xs text-subtle-foreground">
                        {b.type === "small" ? <InlineText text={b.text} /> : null}
                      </p>
                    ))}
                  </section>
                );
              }
              const { label, title } = splitLabel(sec.heading.text);
              const flip = feature % 2 === 1;
              const Icon = FEATURE_ICONS[feature++ % FEATURE_ICONS.length];
              return (
                <section key={s} className="mx-auto grid w-full max-w-[1080px] items-center gap-8 md:grid-cols-2 md:gap-16">
                  <Illustration icon={Icon} className={cn(flip && "md:order-2")} />
                  <div>
                    {label ? (
                      <span className="inline-flex rounded-full bg-primary/15 px-2.5 py-1 text-xs font-semibold text-primary">
                        <InlineText text={label} />
                      </span>
                    ) : null}
                    <h2 className="mt-4 text-[1.75rem] leading-tight font-extrabold tracking-tight text-balance md:text-[2.5rem]">
                      <InlineText text={title} />
                    </h2>
                    <MarkdownBlocks blocks={text} className="mt-3 text-sm leading-relaxed text-muted-foreground" />
                  </div>
                </section>
              );
            })}
          </div>
        );
      })}
      <SiteFooter />
    </div>
  );
}
