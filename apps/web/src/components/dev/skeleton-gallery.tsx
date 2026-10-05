"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/i18n/provider";
import { SAMPLE_TRADER } from "./skeleton-frame";
import { SKELETON_ITEMS, type SkeletonItem } from "./skeleton-items";

type State = "skeleton" | "loaded";
type Theme = "light" | "dark";
const WIDTHS = [390, 820, 1440] as const;
type Width = (typeof WIDTHS)[number];
const GROUPS = ["All", ...new Set(SKELETON_ITEMS.map((item) => item.group))];

/**
 * The skeleton gallery (/<locale>/dev/skeletons): every route's and
 * component's loading state on one page, each in a framed preview at a
 * phone, tablet or desktop width, with a switch (per item or for all)
 * between the skeleton and the loaded component, and light or dark.
 */
export function SkeletonGallery() {
  const { locale } = useI18n();
  const [state, setState] = useState<State>("skeleton");
  const [own, setOwn] = useState<Record<string, State>>({});
  const [theme, setTheme] = useState<Theme>("light");
  const [width, setWidth] = useState<Width>(1440);
  const [group, setGroup] = useState("All");
  const [address, setAddress] = useState(SAMPLE_TRADER);

  // A trader the local api knows (the home page's first), for the trader
  // items' loaded state.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/hl/discover/home", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { data?: { featured?: Array<{ address?: string }> } } | null) => {
        const found = body?.data?.featured?.[0]?.address;
        if (found) setAddress(found);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const setAll = (next: State) => {
    setState(next);
    setOwn({});
  };
  const items = SKELETON_ITEMS.filter((item) => group === "All" || item.group === group);

  return (
    <main className="mx-auto w-full max-w-[1600px] px-4 py-6 md:px-6">
      <header className="sticky top-0 z-10 -mx-4 mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <h1 className="type-h1 mr-auto">Loading skeletons</h1>
        <Control label="All items">
          <Segmented variant="pill" value={state} onChange={setAll} label="All items" options={[{ value: "skeleton", label: "Skeleton" }, { value: "loaded", label: "Loaded" }]} />
        </Control>
        <Control label="Theme">
          <Segmented variant="pill" value={theme} onChange={setTheme} label="Theme" options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        </Control>
        <Control label="Width">
          <Segmented variant="pill" value={String(width) as `${Width}`} onChange={(value) => setWidth(Number(value) as Width)} label="Width" options={WIDTHS.map((w) => ({ value: String(w) as `${Width}`, label: `${w}` }))} />
        </Control>
      </header>
      <nav aria-label="Groups" className="mb-6 flex flex-wrap gap-2">
        {GROUPS.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={group === name}
            onClick={() => setGroup(name)}
            className="h-9 rounded-full px-4 text-sm font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-primary aria-pressed:text-primary-foreground bg-raised text-muted-foreground hover:text-foreground"
          >
            {name}
          </button>
        ))}
      </nav>
      <p className="mb-6 max-w-3xl text-sm text-muted-foreground">
        Skeleton: the real component with its network held, so it stays in the loading state a visitor sees. Loaded: the same component with its data (the fixtures under NEXT_PUBLIC_API_FIXTURES=1, the local api otherwise; personal and admin pages use this browser&apos;s session). Each frame is the page at the chosen width, scaled to fit.
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
        {items.map((item) => (
          <GalleryItem
            key={item.id}
            item={item}
            locale={locale}
            state={own[item.id] ?? state}
            onState={(next) => setOwn((prev) => ({ ...prev, [item.id]: next }))}
            theme={theme}
            width={item.width ?? width}
            address={address}
          />
        ))}
      </div>
    </main>
  );
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-bold text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function GalleryItem({ item, locale, state, onState, theme, width, address }: { item: SkeletonItem; locale: string; state: State; onState: (next: State) => void; theme: Theme; width: number; address: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setRoom(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setRoom(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scale = room ? Math.min(1, room / width) : 1;
  const query = new URLSearchParams({ state, theme, address });
  if (item.query) for (const [key, value] of new URLSearchParams(item.query)) query.set(key, value);
  const src = `/${locale}/dev/skeletons/${item.id}?${query}`;
  return (
    <section aria-labelledby={`item-${item.id}`} className="min-w-0 rounded-2xl bg-raised p-3 md:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 id={`item-${item.id}`} className="type-h2 mr-auto text-base">
          {item.label}
          <span className="ml-2 text-xs font-bold text-muted-foreground">{item.group} · {width}px</span>
        </h2>
        <Segmented variant="pill" tone="sub" value={state} onChange={onState} label={`${item.label}: state`} options={[{ value: "skeleton", label: "Skeleton" }, { value: "loaded", label: "Loaded" }]} />
        <a href={src} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-bold text-muted-foreground hover:text-foreground">
          Open <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>
      <div ref={box} className="relative w-full overflow-hidden rounded-xl border border-border" style={{ height: item.height * scale }}>
        <iframe
          key={src}
          src={src}
          title={`${item.label} (${state})`}
          loading="lazy"
          className="absolute top-0 left-0 block origin-top-left border-0 bg-background"
          style={{ width, height: item.height, transform: `scale(${scale})` }}
        />
      </div>
    </section>
  );
}
