"use client";

import { LogIn, type LucideIcon } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useT } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="font-display text-[1.75rem] leading-tight md:text-[2.5rem]">{title}</h1>
        {subtitle ? <p className="mt-2 max-w-2xl text-sm font-bold text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionHeader({
  title,
  action,
  className,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3.5 flex items-center justify-between gap-3", className)}>
      <h2 className="font-display text-xl leading-tight md:text-[1.375rem]">{title}</h2>
      {action}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {Icon ? (
        <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-raised text-primary-text">
          <Icon className="size-7" strokeWidth={2.2} />
        </div>
      ) : null}
      <p className="font-display text-xl">{title}</p>
      {body ? <p className="mt-2 max-w-sm text-sm leading-relaxed font-bold text-muted-foreground">{body}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <p className="text-sm text-negative">{t("common.error")}</p>
      {message ? <p className="max-w-md font-mono text-xs break-all text-subtle-foreground">{message}</p> : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      ) : null}
    </div>
  );
}

/** Shown in place of signed-in-only content. */
export function SignInPrompt({
  title,
  body,
  icon = LogIn,
  className,
}: {
  title: React.ReactNode;
  body?: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  const t = useT();
  const { status, login } = useAuth();
  const button = (
    <Button size="lg" onClick={login} disabled={status === "disabled" || status === "loading"}>
      {t("common.signIn")}
    </Button>
  );
  return (
    <EmptyState
      icon={icon}
      title={title}
      body={body}
      className={className}
      action={
        status === "disabled" ? (
          <Tooltip content={t("topbar.loginUnavailable")}>
            <span tabIndex={0}>{button}</span>
          </Tooltip>
        ) : (
          button
        )
      }
    />
  );
}

export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return <section className={cn("rounded-2xl bg-card shadow-[0_0_0_2px_var(--card-ring)] [--seg-track:var(--inset)]", className)} {...props} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("ui-skeleton rounded-lg bg-raised", className)} />;
}
