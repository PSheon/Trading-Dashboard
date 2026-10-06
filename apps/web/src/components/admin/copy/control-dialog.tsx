"use client";

import { useSaveToast } from "@/lib/use-action-toast";
import { useState } from "react";
import type { CopyControlCommand } from "@trading-dashboard/shared/contracts";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import { CONTROL_CONFIRM_WORD, useAdminCopyControl, type CopyControlTarget } from "@/lib/admin-copy";

export interface ControlRequest {
  target: CopyControlTarget;
  /** Shown as who is affected: "all users" or the user's email / id. */
  targetLabel: string;
  command: CopyControlCommand;
  /** The scope's revision as the page shows it now; sent as expectedRevision. */
  revision: number;
  /** What the command touches, from the page's own read models. */
  impact: { strategies: number; users?: number; exposureUsd: number | null };
}

const REASON_MIN = 3;
const REASON_MAX = 500;

/**
 * Confirmation for a platform- or user-level copy command: what it does,
 * what it touches, a required reason and the command's word typed out. A
 * 409 (someone else's command landed first) keeps the dialog open: the
 * page refetches, `request.revision` follows it, and the admin decides
 * again against the state now shown.
 */
export function ControlDialog({ request, onClose }: { request: ControlRequest | null; onClose: () => void }) {
  return (
    <Modal open={request !== null} onOpenChange={(open) => { if (!open) onClose(); }} title={<ControlTitle request={request} />}>
      {request ? <ControlForm key={`${request.command}:${request.targetLabel}`} request={request} onClose={onClose} /> : null}
    </Modal>
  );
}

function ControlTitle({ request }: { request: ControlRequest | null }) {
  const { t } = useI18n();
  return request ? t(`copyAdmin.commands.${request.command}`) : "";
}

function ControlForm({ request, onClose }: { request: ControlRequest; onClose: () => void }) {
  const { t, format } = useI18n();
  const saved = useSaveToast();
  const control = useAdminCopyControl();
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const word = CONTROL_CONFIRM_WORD[request.command];
  const reasonOk = reason.trim().length >= REASON_MIN;
  const armed = reasonOk && typed.trim().toUpperCase() === word;
  const stale = control.isError && control.error.code === "stale_revision";

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!armed || control.isPending) return;
        control.mutate(
          { target: request.target, command: request.command, reason: reason.trim(), expectedRevision: request.revision },
          saved({ onSuccess: onClose }),
        );
      }}
    >
      <p className="text-sm leading-relaxed text-muted-foreground">{t(`copyAdmin.commandHelp.${request.command}`)}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-raised p-3.5 text-xs">
        <dt className="text-muted-foreground">{t("copyAdmin.dialog.target")}</dt>
        <dd className="truncate text-right font-semibold">{request.targetLabel}</dd>
        {request.impact.users !== undefined ? (
          <>
            <dt className="text-muted-foreground">{t("copyAdmin.dialog.users")}</dt>
            <dd className="num text-right font-semibold">{format.num(request.impact.users, 0)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("copyAdmin.dialog.strategies")}</dt>
        <dd className="num text-right font-semibold">{format.num(request.impact.strategies, 0)}</dd>
        <dt className="text-muted-foreground">{t("copyAdmin.dialog.exposure")}</dt>
        <dd className="num text-right font-semibold">{request.impact.exposureUsd === null ? "—" : format.usd(request.impact.exposureUsd, { digits: 2 })}</dd>
        <dt className="text-muted-foreground">{t("copyAdmin.dialog.revision")}</dt>
        <dd className="num text-right font-semibold">{request.revision}</dd>
      </dl>
      <div className="grid gap-2">
        <Label htmlFor="copy-control-reason">{t("copyAdmin.dialog.reason")}</Label>
        <Textarea
          id="copy-control-reason"
          required
          minLength={REASON_MIN}
          maxLength={REASON_MAX}
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t("copyAdmin.dialog.reasonHint")}
          className="font-sans"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="copy-control-confirm">{t("copyAdmin.dialog.typeToConfirm", { word })}</Label>
        <Input id="copy-control-confirm" autoComplete="off" spellCheck={false} value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={word} />
      </div>
      {control.isError ? (
        <p role="alert" className="rounded-xl bg-negative-soft px-3.5 py-2.5 text-sm text-negative">
          {stale ? t("copyAdmin.dialog.stale") : t("copyAdmin.dialog.failed", { message: control.error.message })}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>{t("copyAdmin.dialog.cancel")}</Button>
        <Button type="submit" loading={control.isPending} disabled={!(control.isPending) && (!armed || control.isPending)}>
          {control.isPending ? t("copyAdmin.dialog.sending") : t("copyAdmin.dialog.confirm", { command: t(`copyAdmin.commands.${request.command}`) })}
        </Button>
      </div>
    </form>
  );
}
