"use client";

import type { TraderWindow } from "@/lib/contracts";
import { Copy, Download, Share2, SquareArrowOutUpRight } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { Modal } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/i18n/provider";
import { SHARE_FORMATS, SHARE_PERIODS, isShareFormat, shareFileName, shareImagePath, type ShareFormat } from "@/lib/share-card";

const STYLE_KEY = "orbie_share_style";

function readFormat(): ShareFormat {
  try {
    const v = JSON.parse(localStorage.getItem(STYLE_KEY) ?? "{}")?.format;
    return isShareFormat(v) ? v : "landscape";
  } catch {
    return "landscape";
  }
}

const pngOf = (src: string) =>
  fetch(src).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.blob();
  });

/**
 * CopyDog's 分享交易員主頁: the trader's image card — its Spotlight style,
 * the only one CopyDog offers for a profile — in two formats (16:9 and
 * 4:5, the choice remembered), four periods (ALL first), 複製 (the PNG to
 * the clipboard) and 下載. The PNG comes from
 * /trader/<address>/share-image. As on CopyDog, a copy and a failed
 * download are confirmed by a toast; a download that works says nothing.
 */
export function ShareDialog({ open, onOpenChange, address, name }: { open: boolean; onOpenChange: (open: boolean) => void; address: string; name: string }) {
  const { t } = useI18n();
  const toast = useToast();
  // Mounted on opening (ShareButton), so the remembered format is read then.
  const [format, setFormat] = useState<ShareFormat>(() => (typeof window === "undefined" ? "landscape" : readFormat()));
  const [period, setPeriod] = useState<TraderWindow>("allTime");
  const [busy, setBusy] = useState<"copy" | "download" | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const pick = (f: ShareFormat) => {
    setFormat(f);
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify({ format: f }));
    } catch {
      // Private mode: the choice just isn't remembered.
    }
  };

  const src = shareImagePath(address, period, format);
  const file = `${shareFileName(name, period, format)}.png`;
  const size = SHARE_FORMATS[format];

  async function copy() {
    setBusy("copy");
    try {
      // The promise form keeps Safari's user-gesture requirement.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngOf(src) })]);
      toast.success(t("trader.share.copied"));
    } catch {
      toast.error(t("trader.share.copyFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    setBusy("download");
    try {
      const url = URL.createObjectURL(await pngOf(src));
      const a = document.createElement("a");
      a.href = url;
      a.download = file;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.error(t("trader.share.downloadFailed"));
    } finally {
      setBusy(null);
    }
  }


  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t("trader.share.title")} className="max-w-[680px]" bodyClassName="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-dotted border-border px-5 py-3">
        <div role="radiogroup" aria-label={t("trader.share.style")} className="flex items-center gap-2">
          {(Object.keys(SHARE_FORMATS) as ShareFormat[]).map((f) => {
            const d = SHARE_FORMATS[f];
            return (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={format === f}
                aria-label={`${t("shareCard.styleSpotlight")} · ${d.label}`}
                title={`${t("shareCard.styleSpotlight")} · ${d.label}`}
                onClick={() => pick(f)}
                className={cn(
                  "overflow-hidden rounded-lg border-2 bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  format === f ? "border-primary" : "border-border hover:border-border-strong",
                )}
                style={{ width: Math.round((d.w * 56) / d.h), height: 56 }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={shareImagePath(address, period, f)} alt="" className="size-full object-cover" loading="lazy" />
              </button>
            );
          })}
        </div>
        <Segmented
          variant="pill"
          value={period}
          onChange={setPeriod}
          label={t("trader.share.period")}
          options={SHARE_PERIODS.map(([value, label]) => ({ value, label }))}
        />
      </div>

      <div className="flex min-h-[499px] items-center justify-center bg-background md:min-h-[596px] bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:16px_16px] p-5">
        <div className="relative w-full" style={{ maxWidth: format === "landscape" ? 640 : Math.min(480, (size.w / size.h) * 440) }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={src}
            src={src}
            alt={t("trader.share.imageAlt", { name })}
            onLoad={() => setLoaded(src)}
            onError={() => setFailed(src)}
            className={cn("block h-auto w-full rounded-lg border border-border-strong transition-opacity", loaded === src ? "opacity-100" : "opacity-0")}
            style={{ aspectRatio: `${size.w} / ${size.h}` }}
            data-testid="share-image"
          />
          {loaded !== src ? (
            <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-raised text-xs text-muted-foreground" role="status">
              {failed === src ? t("trader.share.loadFailed") : t("common.loading")}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t-2 border-dotted border-border px-5 py-4">
        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={copy}
            disabled={busy !== null}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-raised text-sm font-semibold outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <Copy className="size-4" />
            {busy === "copy" ? t("trader.share.copying") : t("trader.share.copy")}
          </button>
          <button
            type="button"
            onClick={download}
            disabled={busy !== null}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary text-sm font-bold text-primary-foreground outline-none hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <Download className="size-4" />
            {busy === "download" ? t("trader.share.downloading") : t("trader.share.download")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The share icon next to the trader's name: opens the share card. */
export function ShareButton({ address, name, className, iconClassName, icon = "share" }: { address: string; name: string; className?: string; iconClassName?: string; /** CopyDog's phone bar uses an out-arrow box. */ icon?: "share" | "external" }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("trader.share.title")}
        title={t("trader.share.title")}
        aria-haspopup="dialog"
        className={cn("inline-flex shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
      >
        {icon === "external" ? <SquareArrowOutUpRight className={iconClassName} /> : <Share2 className={iconClassName} />}
      </button>
      {open ? <ShareDialog open={open} onOpenChange={setOpen} address={address} name={name} /> : null}
    </>
  );
}
