import { Bell, BriefcaseBusiness, Compass, ShieldCheck, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";

import { AlertsMock, AvatarStack, BoardMock, CopyMock, KolMarquee, PortfolioMock, ProfileMock } from "@/components/content/about-visuals";
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
        "inline-flex h-11 items-center rounded-full bg-foreground px-4 text-[15px] font-[650] text-background outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring",
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

const STEP_MOCKS = [BoardMock, ProfileMock, CopyMock];
/** CopyDog's mock-ups for 投資組合 and 提醒; Orbie's own extra sections keep
 * an icon panel. */
const FEATURE_MOCKS: Array<(() => React.ReactNode) | null> = [PortfolioMock, AlertsMock];
const FEATURE_ICONS: LucideIcon[] = [BriefcaseBusiness, Bell, Compass, ShieldCheck];

function Illustration({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex aspect-[4/3] w-full items-center justify-center rounded-3xl bg-raised",
        className,
      )}
    >
      <span className="flex size-24 items-center justify-center rounded-3xl bg-primary/12 text-primary-text shadow-[0_0_80px_-10px] shadow-primary/40">
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
    <div className="-mx-5 -mt-5 flex flex-col md:-mt-8 md:-mr-4 md:-ml-8">
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
                  <h1 className="mx-auto mt-8 max-w-[300px] text-[36px] leading-none font-[652] tracking-[-0.6px] text-balance sm:max-w-[500px] md:text-[56px] lg:max-w-[700px] lg:text-[79px]">
                    <InlineText text={hero.heading.text} />
                  </h1>
                ) : null}
                {hero.body.map((b, i) => {
                  if (eyebrowOf(b)) return null;
                  const cta = ctaOf(b);
                  if (cta) return <Cta key={i} {...cta} className="mt-8" />;
                  if (b.type === "small") return <p key={i} className="mt-10 text-[13px] font-medium tracking-[0.4px] text-subtle-foreground"><InlineText text={b.text} /></p>;
                  if (b.type === "paragraph") return <p key={i} className="mx-auto mt-6 max-w-[240px] text-xl leading-[26px] font-[440] text-muted-foreground sm:max-w-[380px] lg:max-w-[560px]"><InlineText text={b.text} /></p>;
                  return <MarkdownBlocks key={i} blocks={[b]} />;
                })}
              </section>
              <KolMarquee />
            </div>
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
            <section key={p} className="mx-auto flex w-full flex-col items-center gap-10 px-5 py-10 md:gap-20 md:py-[120px] lg:px-[116px]">
              {title ? (
                <h2 className="text-center text-[28px] leading-[1.05] font-[652] tracking-[-0.6px] text-balance md:text-[56px]">
                  <InlineText text={title.text} />
                </h2>
              ) : null}
              <div className="grid w-full max-w-[448px] gap-10 md:max-w-[1024px] md:grid-cols-3 md:gap-6">
                {items.map((item, i) => {
                  const Picture = STEP_MOCKS[i % STEP_MOCKS.length];
                  return (
                    <figure key={i} className="grid content-start gap-6 text-center md:gap-8">
                      <div className="grid aspect-[1.1] w-full place-items-center overflow-hidden rounded-3xl bg-raised [&>*]:w-[min(86%,324px)]">
                        <Picture />
                      </div>
                      <figcaption>
                        <h3 className="text-xl font-[650] tracking-[-0.2px]">
                          <InlineText text={item.title} />
                        </h3>
                        <MarkdownBlocks blocks={item.body} className="pt-2 text-base leading-[1.5] text-muted-foreground [&_p]:my-0" />
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </section>
          );
        }
        // Closing call to action: a heading, one line and a link, nothing else.
        const closingBody = secs.length === 1 ? secs[0].body : [];
        const last = closingBody.length >= 1 && closingBody.length <= 2 ? ctaOf(closingBody[closingBody.length - 1]) : null;
        const lede = closingBody.length === 2 && closingBody[0].type === "paragraph" ? closingBody[0] : null;
        if (last && secs[0].heading && (closingBody.length === 1 || lede)) {
          return (
            <section key={p} className="mx-auto flex flex-col items-center px-5 py-10 text-center md:py-[120px]">
              {/* CopyDog's rotating trader avatar above the closing line. */}
              <AvatarStack />
              <h2 className="mt-6 max-w-[900px] text-[36px] leading-none font-[652] tracking-[-0.6px] text-balance lg:text-[80px]">
                <InlineText text={secs[0].heading.text} />
              </h2>
              {lede ? (
                <p className="mx-auto mt-6 max-w-[240px] text-xl leading-[26px] font-[440] text-muted-foreground sm:max-w-[380px] lg:max-w-[560px]">
                  <InlineText text={lede.text} />
                </p>
              ) : null}
              <Cta {...last} className="mt-8" />
            </section>
          );
        }
        // Feature sections, alternating sides; the funds-safety one (it has
        // a small print line) is centred with a shield, as on CopyDog.
        return (
          <div key={p} className="mx-auto grid w-full max-w-[1280px] gap-20 px-5 py-10 md:gap-[120px] md:py-[120px] lg:px-[116px]">
            {secs.map((sec, s) => {
              if (!sec.heading) return <MarkdownBlocks key={s} blocks={sec.body} />;
              const smallPrint = sec.body.filter((b) => b.type === "small");
              const text = sec.body.filter((b) => b.type !== "small");
              if (smallPrint.length > 0) {
                return (
                  <section key={s} className="mx-auto flex max-w-[620px] flex-col items-center text-center">
                    <ShieldCheck aria-hidden className="size-12 text-primary-text" strokeWidth={1.6} fill="currentColor" fillOpacity={0.15} />
                    {/* CopyDog keeps this heading at 56px even on phones. */}
                    <h2 className="mt-6 text-[56px] leading-[1.05] font-[652] tracking-[-0.6px] text-balance">
                      <InlineText text={sec.heading.text} />
                    </h2>
                    <MarkdownBlocks blocks={text} className="mt-6 max-w-[420px] text-base leading-[1.5] text-muted-foreground" />
                    {smallPrint.map((b, i) => (
                      <p key={i} className="mt-6 text-[13px] text-subtle-foreground">
                        {b.type === "small" ? <InlineText text={b.text} /> : null}
                      </p>
                    ))}
                  </section>
                );
              }
              const { label, title } = splitLabel(sec.heading.text);
              const flip = feature % 2 === 1;
              const Picture = FEATURE_MOCKS[feature] ?? null;
              const Icon = FEATURE_ICONS[feature++ % FEATURE_ICONS.length];
              return (
                <section key={s} className="grid w-full items-center gap-10 md:grid-cols-2 md:gap-x-12 lg:gap-x-20">
                  {Picture ? (
                    <div className={cn("grid aspect-[4/3] w-full place-items-center overflow-hidden rounded-3xl bg-raised [&>*]:w-[min(82%,404px)]", flip && "md:order-2")}>
                      <Picture />
                    </div>
                  ) : (
                    <Illustration icon={Icon} className={cn(flip && "md:order-2")} />
                  )}
                  <div className="grid content-center gap-4">
                    {label ? (
                      <span className="inline-flex justify-self-start rounded-full bg-primary/10 px-3.5 py-[5px] text-[13px] font-semibold tracking-[0.4px] text-primary-text uppercase">
                        <InlineText text={label} />
                      </span>
                    ) : null}
                    <h2 className="mt-1 text-[28px] leading-[1.05] font-[652] tracking-[-0.6px] text-balance md:text-[56px]">
                      <InlineText text={title} />
                    </h2>
                    <MarkdownBlocks blocks={text} className="mt-1 max-w-[520px] text-base leading-[1.6] text-muted-foreground" />
                  </div>
                </section>
              );
            })}
          </div>
        );
      })}
      <SiteFooter className="mt-20" />
    </div>
  );
}
