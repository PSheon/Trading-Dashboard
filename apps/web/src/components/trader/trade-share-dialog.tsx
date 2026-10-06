"use client";

import { useEffect, useState } from "react";
import { Copy, Download } from "lucide-react";
import { cn } from "cn";

import { Modal } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/i18n/provider";
import { fetchAsSession } from "@/lib/api";
import { SHARE_FORMATS, isShareFormat, type ShareFormat } from "@/lib/share-card";
import { TRADE_CARD_STYLES, isTradeCardStyle, tradeCardQuery, type TradeCardStyle } from "@/lib/trade-card";
import { OrbitSpinner } from "@/components/ui/orbit-spinner";

/** Where a card comes from: a trader's public trade or position
 * (/trader/<address>/share-image?kind=…) or one of the signed-in person's
 * own copies (/portfolio/share-image?kind=…, fetched with their session). */
export interface TradeCardSource {
  path: string;
  auth: boolean;
  kind: "trade" | "position";
  /** File name without style / format / extension. */
  fileBase: string;
  /** For the image's alt text. */
  label: string;
}

const STYLE_KEY = "orbie_trade_share_style";
function remembered(): { style: TradeCardStyle; format: ShareFormat } {
  try {
    const v = JSON.parse(localStorage.getItem(STYLE_KEY) ?? "{}") as { style?: string; format?: string };
    return { style: isTradeCardStyle(v.style) ? v.style : "card", format: isShareFormat(v.format) ? v.format : "landscape" };
  } catch {
    return { style: "card", format: "landscape" };
  }
}

const urlOf = (source: TradeCardSource, style: TradeCardStyle, format: ShareFormat) => `${source.path}&${tradeCardQuery(style, format)}`;

async function pngOf(source: Pick<TradeCardSource, "auth">, url: string, signal?: AbortSignal): Promise<Blob> {
  const res = source.auth ? await fetchAsSession(url, signal) : await fetch(url, { signal });
  if (!res.ok || !res.headers.get("content-type")?.startsWith("image/png")) throw new Error(String(res.status));
  return res.blob();
}

/** A card image: a plain <img> for public cards, a blob for the owner's own. */
function useCardImage(source: TradeCardSource, url: string): { src: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string; src: string | null; failed: boolean }>({ url: "", src: null, failed: false });
  const auth = source.auth;
  useEffect(() => {
    if (!auth) return;
    const abort = new AbortController();
    let objectUrl: string | null = null;
    pngOf({ auth }, url, abort.signal)
      .then((blob) => { objectUrl = URL.createObjectURL(blob); setState({ url, src: objectUrl, failed: false }); })
      .catch(() => { if (!abort.signal.aborted) setState({ url, src: null, failed: true }); });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [auth, url]);
  if (!auth) return { src: url, failed: false };
  return state.url === url ? { src: state.src, failed: state.failed } : { src: null, failed: false };
}

function Thumb({ source, style, format, active, label, onPick }: { source: TradeCardSource; style: TradeCardStyle; format: ShareFormat; active: boolean; label: string; onPick: () => void }) {
  const d = SHARE_FORMATS[format];
  const { src } = useCardImage(source, urlOf(source, style, format));
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={label}
      title={label}
      onClick={onPick}
      className={cn("overflow-hidden rounded-lg border-2 bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "border-primary" : "border-border hover:border-border-strong")}
      style={{ width: Math.round((d.w * 56) / d.h), height: 56 }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt="" className="size-full object-cover" loading="lazy" /> : null}
    </button>
  );
}

/**
 * CopyDog's Share Trade / Share Position: App Card (dark) and Poster (a
 * light sheet, mint for a gain, rose for a loss), each in 16:9 and 4:5 (the
 * choice remembered), 複製 and 下載. Every image is rendered by the server
 * from data it reads itself, within the share-image rate limit.
 */
export function TradeShareDialog({ source, onClose }: { source: TradeCardSource; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [choice, setChoice] = useState(() => (typeof window === "undefined" ? { style: "card" as TradeCardStyle, format: "landscape" as ShareFormat } : remembered()));
  const [busy, setBusy] = useState<"copy" | "download" | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [errored, setErrored] = useState<string | null>(null);
  const url = urlOf(source, choice.style, choice.format);
  const image = useCardImage(source, url);
  const size = SHARE_FORMATS[choice.format];
  const styleLabel = (s: TradeCardStyle) => t(s === "card" ? "shareCard.styleCard" : "shareCard.stylePoster");
  const pick = (style: TradeCardStyle, format: ShareFormat) => {
    setChoice({ style, format });
    try { localStorage.setItem(STYLE_KEY, JSON.stringify({ style, format })); } catch { /* not remembered */ }
  };
  const ready = image.src !== null && (source.auth || loaded === url);
  const failed = image.failed || errored === url;

  async function copy() {
    if (busy) return;
    setBusy("copy");
    try {
      // The promise form keeps Safari's user-gesture requirement.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngOf(source, url) })]);
      toast.success(t("trader.share.copied"));
    } catch {
      toast.error(t("trader.share.copyFailed"));
    } finally {
      setBusy(null);
    }
  }
  async function download() {
    if (busy) return;
    setBusy("download");
    try {
      const href = URL.createObjectURL(await pngOf(source, url));
      const a = document.createElement("a");
      a.href = href;
      a.download = `${source.fileBase}-${choice.style}-${choice.format}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch {
      toast.error(t("trader.share.downloadFailed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={t(source.kind === "trade" ? "shareCard.tradeTitle" : "shareCard.positionTitle")} className="max-w-[680px]" bodyClassName="p-0">
      <div className="flex flex-wrap items-center gap-2 border-b-2 border-dotted border-border px-5 py-3" role="radiogroup" aria-label={t("trader.share.style")}>
        {(["landscape", "portrait"] as const).flatMap((format) => TRADE_CARD_STYLES.map(({ key }) => (
          <Thumb key={`${key}-${format}`} source={source} style={key} format={format} active={choice.style === key && choice.format === format}
            label={`${styleLabel(key)} · ${SHARE_FORMATS[format].label}`} onPick={() => pick(key, format)} />
        )))}
      </div>
      <div className="flex min-h-[420px] items-center justify-center bg-background bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:16px_16px] p-5 md:min-h-[560px]">
        <div className="relative w-full" style={{ maxWidth: choice.format === "landscape" ? 640 : Math.min(480, (size.w / size.h) * 440) }}>
          {image.src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={image.src}
              alt={t("shareCard.imageAlt", { label: source.label })}
              onLoad={() => setLoaded(url)}
              onError={() => setErrored(url)}
              className={cn("block h-auto w-full rounded-lg border border-border-strong transition-opacity", ready ? "opacity-100" : "opacity-0")}
              style={{ aspectRatio: `${size.w} / ${size.h}` }}
              data-testid="trade-card-image"
            />
          ) : <div style={{ aspectRatio: `${size.w} / ${size.h}` }} />}
          {!ready ? (
            <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-raised text-xs text-muted-foreground" role="status">
              {failed ? t("trader.share.loadFailed") : t("common.loading")}
            </div>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5 border-t-2 border-dotted border-border px-5 py-4">
        <button type="button" onClick={copy} aria-busy={busy === "copy" || undefined} disabled={(busy !== null && busy !== "copy") || !ready}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-raised text-sm font-semibold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
          {busy === "copy" ? <OrbitSpinner className="size-4" /> : <Copy className="size-4" />}{busy === "copy" ? t("trader.share.copying") : t("trader.share.copy")}
        </button>
        <button type="button" onClick={download} aria-busy={busy === "download" || undefined} disabled={(busy !== null && busy !== "download") || !ready}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary text-sm font-bold text-primary-foreground outline-none hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
          {busy === "download" ? <OrbitSpinner className="size-4" /> : <Download className="size-4" />}{busy === "download" ? t("trader.share.downloading") : t("trader.share.download")}
        </button>
      </div>
    </Modal>
  );
}

/** A trader's closed trade or open position on their page. */
export function traderCardSource(address: string, kind: "trade" | "position", key: string, label: string): TradeCardSource {
  const q = kind === "trade" ? `id=${encodeURIComponent(key)}` : `coin=${encodeURIComponent(key)}`;
  return { path: `/trader/${address.toLowerCase()}/share-image?kind=${kind}&${q}`, auth: false, kind, fileBase: `orbie-${label.replace(/[^\w-]+/g, "-").slice(0, 16)}-${kind}`, label };
}

/** One of the signed-in person's own copy trades or positions. */
export function copyCardSource(kind: "trade" | "position", key: { id?: string; strategyId?: number; coin?: string }, label: string): TradeCardSource {
  const q = kind === "trade" ? `id=${encodeURIComponent(key.id ?? "")}` : `strategyId=${key.strategyId}&coin=${encodeURIComponent(key.coin ?? "")}`;
  return { path: `/portfolio/share-image?kind=${kind}&${q}`, auth: true, kind, fileBase: `orbie-paper-${label.replace(/[^\w-]+/g, "-").slice(0, 16)}-${kind}`, label };
}
