"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Download } from "lucide-react";
import { Modal } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/i18n/provider";
import { APP_NAME } from "@/lib/config";

export interface TradeShareSnapshot {
  market: string;
  side: string;
  pnl: string;
  positive: boolean;
  entry: string;
  exit: string;
  detail: string;
  capturedAt: string;
  source: string;
}

/** The caller freezes the displayed values when opening. Later live mids
 * cannot silently change the preview or downloaded image. No account
 * secrets, external images, or network fetches enter this canvas. */
export function TradeShareDialog({ snapshot, onClose }: { snapshot: TradeShareSnapshot; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [portrait, setPortrait] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (cancelled || !canvas.current) return;
      const c = canvas.current;
      const ctx = c.getContext("2d");
      if (!ctx) { setFailed(true); return; }
      const width = 960, height = portrait ? 1200 : 540;
      c.width = width; c.height = height;
      ctx.fillStyle = "#100d22"; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#ff793b"; ctx.fillRect(0, 0, width, 8);
      const font = getComputedStyle(c).fontFamily;
      const line = (text: string, x: number, y: number, size: number, color: string) => {
        ctx.fillStyle = color;
        ctx.font = `600 ${size}px ${font}`;
        while (ctx.measureText(text).width > width - x * 2 && size > 12) ctx.font = `600 ${--size}px ${font}`;
        ctx.fillText(text, x, y);
      };
      const offset = portrait ? 180 : 0;
      line(APP_NAME, 48, 68, 32, "#faf7f1");
      line(`${snapshot.market} · ${snapshot.side}`, 48, 142 + offset, 36, "#faf7f1");
      line(snapshot.pnl, 48, 245 + offset, 78, snapshot.positive ? "#24d7a5" : "#ff4b6b");
      line(`${snapshot.entry} → ${snapshot.exit}`, 48, 320 + offset, 30, "#faf7f1");
      line(snapshot.detail, 48, 374 + offset, 22, "#b9b3cd");
      ctx.fillStyle = "#302941"; ctx.fillRect(48, height - 114, width - 96, 1);
      line(snapshot.capturedAt, 48, height - 72, 17, "#b9b3cd");
      line(snapshot.source, 48, height - 34, 15, "#b9b3cd");
      setReady(true);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [snapshot, portrait]);

  function blob(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!canvas.current || !ready) return reject(new Error("Image unavailable"));
      canvas.current.toBlob((value) => value ? resolve(value) : reject(new Error("Image unavailable")), "image/png");
    });
  }
  async function save(copy: boolean) {
    setBusy(true);
    try {
      if (copy) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob() })]);
        toast.success(t("trader.share.copied"));
      } else {
        const url = URL.createObjectURL(await blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = `orbie-${snapshot.market.replace(/[^a-zA-Z0-9_-]/g, "-")}-${portrait ? "portrait" : "landscape"}.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch { toast.error(t(copy ? "trader.share.copyFailed" : "trader.share.downloadFailed")); }
    finally { setBusy(false); }
  }
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={t("common.share")} className="max-w-[680px]">
    <div className="mb-4 flex gap-2" role="radiogroup" aria-label={t("trader.share.style")}>
      {[false, true].map((value) => <Button key={String(value)} role="radio" aria-checked={portrait === value} variant={portrait === value ? "default" : "secondary"} onClick={() => { if (value === portrait) return; setReady(false); setFailed(false); setPortrait(value); }} disabled={busy}>{value ? "4:5" : "16:9"}</Button>)}
    </div>
    <canvas ref={canvas} role="img" aria-label={`${snapshot.market} ${snapshot.pnl} ${snapshot.capturedAt}`} className="mx-auto h-auto w-full rounded-xl" style={{ maxWidth: portrait ? 340 : undefined, aspectRatio: portrait ? "4 / 5" : "16 / 9" }} />
    {!ready ? <p role="status" className="mt-3 text-sm text-muted-foreground">{t(failed ? "trader.share.loadFailed" : "common.loading")}</p> : null}
    <div className="mt-4 grid grid-cols-2 gap-3">
      <Button variant="secondary" disabled={!ready || busy} onClick={() => void save(true)}><Copy />{t("trader.share.copy")}</Button>
      <Button disabled={!ready || busy} onClick={() => void save(false)}><Download />{t("trader.share.download")}</Button>
    </div>
  </Modal>;
}
