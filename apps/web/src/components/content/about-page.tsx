import { ShieldCheck } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { cn } from "cn";

import { AvatarStack, BoardMock, CopyMock, KolMarquee, ProfileMock } from "@/components/content/about-visuals";
import { InlineText, MarkdownBlocks } from "@/components/content/markdown";
import { inlineText, parseInline, type Block } from "@/lib/markdown";

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
        "orbit-press inline-flex h-14 items-center rounded-full bg-primary px-8 font-display text-lg text-primary-foreground outline-none hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      {label}
    </Link>
  );
}

const STEP_MOCKS = [BoardMock, ProfileMock, CopyMock];
/** The wallet provider's name on the funds-safety badge: a brand, the same
 * in every language. */
const PROVIDER = "Privy";

/**
 * CopyDog's 關於我們 (`/about`), a landing page: hero with the call to
 * action, the three steps (a picture and a short title each), the
 * funds-safety title with the wallet provider's badge, the closing call to
 * action and the footer. The words come from docs/content/about.*.md (split
 * by `---` and `##`). The UI stays minimal (Paul, 2026-10-25): no body
 * paragraph under a step or a section; the funds-safety fine print is the
 * badge's hover.
 */
export function AboutPage({ blocks }: { blocks: Block[] }) {
  const body = blocks.filter((b) => !(b.type === "heading" && b.level === 1));
  const parts = chunks(body);
  // The footer is the shell's (route group chrome, mt-16), in the page
  // frame outside the full-bleed sections; the bottom padding keeps it 80px
  // below them.
  return (
    <div className="-mx-4 -mt-4 flex flex-col pb-4 md:-mx-5 md:-mt-2">
      {parts.map((part, p) => {
        const secs = sections(part);
        const steps = part.filter((b): b is Heading => b.type === "heading" && b.level === 3);
        // Hero: the first chunk.
        if (p === 0) {
          const [hero] = secs;
          return (
            <div key={p} className="flex flex-col items-center">
              {/* CopyDog's hero: no eyebrow, a 79px headline, the lede, one
                  button and the "built for" line, then the trader marquee. */}
              <section className="flex flex-col items-center px-5 py-10 text-center md:py-[120px]">
                {hero.heading ? (
                  <h1 className="type-hero mx-auto mt-8 max-w-[300px] text-balance sm:max-w-[500px] lg:max-w-[700px]">
                    <InlineText text={hero.heading.text} />
                  </h1>
                ) : null}
                {hero.body.map((b, i) => {
                  if (eyebrowOf(b)) return null;
                  const cta = ctaOf(b);
                  if (cta) return <Cta key={i} {...cta} className="mt-8" />;
                  if (b.type === "small") return <p key={i} className="mt-10 text-[13px] font-medium text-subtle-foreground"><InlineText text={b.text} /></p>;
                  if (b.type === "paragraph") return <p key={i} className="mx-auto mt-6 max-w-[240px] text-xl leading-[26px] font-[440] text-muted-foreground sm:max-w-[380px] lg:max-w-[560px]"><InlineText text={b.text} /></p>;
                  return <MarkdownBlocks key={i} blocks={[b]} />;
                })}
              </section>
              <KolMarquee />
            </div>
          );
        }
        // Three steps: a chunk with ### items, each a picture and its title.
        if (steps.length > 0) {
          const title = secs[0]?.heading;
          return (
            <section key={p} className="mx-auto flex w-full flex-col items-center gap-10 px-5 py-10 md:gap-20 md:py-[120px] lg:px-[116px]">
              {title ? (
                <h2 className="text-center text-[28px] leading-[1.05] font-display text-balance md:text-[56px]">
                  <InlineText text={title.text} />
                </h2>
              ) : null}
              <div className="grid w-full max-w-[448px] gap-10 md:max-w-[1024px] md:grid-cols-3 md:gap-6">
                {steps.map((step, i) => {
                  const Picture = STEP_MOCKS[i % STEP_MOCKS.length];
                  return (
                    <figure key={i} className="grid content-start gap-6 text-center md:gap-8">
                      <div className="grid aspect-[1.1] w-full place-items-center overflow-hidden rounded-3xl bg-raised [&>*]:w-[min(86%,324px)]">
                        <Picture />
                      </div>
                      <figcaption>
                        <h3 className="type-h2">
                          <InlineText text={step.text.replace(/^\d+\.\s*/, "")} />
                        </h3>
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </section>
          );
        }
        // Closing call to action: a heading and a link, nothing else.
        const closingBody = secs.length === 1 ? secs[0].body : [];
        const last = closingBody.length > 0 ? ctaOf(closingBody[closingBody.length - 1]) : null;
        if (last && secs[0].heading) {
          return (
            <section key={p} className="mx-auto flex flex-col items-center px-5 py-10 text-center md:py-[120px]">
              {/* CopyDog's rotating trader avatar above the closing line. */}
              <AvatarStack />
              <h2 className="mt-6 max-w-[900px] text-[36px] leading-none font-display text-balance lg:text-[80px]">
                <InlineText text={secs[0].heading.text} />
              </h2>
              <Cta {...last} className="mt-8" />
            </section>
          );
        }
        // The funds-safety block, centred with a shield as on CopyDog: the
        // title and the provider badge; its fine print is the badge's hover.
        return (
          <div key={p} className="mx-auto grid w-full max-w-[1280px] gap-20 px-5 py-10 md:gap-[120px] md:py-[120px] lg:px-[116px]">
            {secs.map((sec, s) => {
              if (!sec.heading) return null;
              const smallPrint = sec.body.find((b): b is Extract<Block, { type: "small" }> => b.type === "small");
              return (
                <section key={s} className="mx-auto flex max-w-[620px] flex-col items-center text-center">
                  <ShieldCheck aria-hidden className="size-12 text-primary-text" strokeWidth={1.6} fill="currentColor" fillOpacity={0.15} />
                  {/* CopyDog keeps this heading at 56px even on phones. */}
                  <h2 className="mt-6 text-[56px] leading-[1.05] font-display text-balance">
                    <InlineText text={sec.heading.text} />
                  </h2>
                  {smallPrint ? (
                    <span
                      title={inlineText(smallPrint.text)}
                      data-testid="about-provider"
                      className="mt-6 inline-flex rounded-full bg-primary/10 px-3.5 py-[5px] text-[13px] font-semibold text-primary-text"
                    >
                      {PROVIDER}
                    </span>
                  ) : null}
                </section>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
