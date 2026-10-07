"use client";
import encodeQR from "@paulmillr/qr";
import { TablePager } from "@/components/ui/table-pager";
import { useCursorPager } from "@/components/ui/use-cursor-pager";
import { DataList } from "@/components/ui/data-list";
import { Link, usePathname } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { TIME_ZONE_LABEL } from "@/i18n/config";
import { splitLocale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/lib/auth";
import { useLiveCopyDeployment } from "@/lib/copy-live-setup";
import { api, sessionKey } from "@/lib/api";
import { referralCheckSchema, type ReferralClaim } from "@/lib/contracts";
import {
  captureReferral,
  claimJournal,
  pendingReferral,
  pinReferral,
  referralClient,
  referralUnits,
  useReferralClaims,
  useReferralCaptureRecord,
  useReferralFriends,
  useReferralOverview,
} from "@/lib/referral";

/** Query/path hooks keep capture current during client navigation. */
export function ReferralRouteCapture() {
  const pathname = usePathname(),
    params = useSearchParams();
  const code =
    params.get("ref") ??
    /^\/r\/([A-Za-z0-9]{3,16})\/?$/.exec(pathname)?.[1] ??
    "";
  return <ReferralCapture code={code} />;
}

/** Global capture performs public validation; binding is the sole automatic, nonfinancial write. */
export function ReferralCapture({
  code,
  display = false,
}: {
  code?: string;
  display?: boolean;
}) {
  const { t } = useI18n(),
    auth = useAuth(),
    [pending, setPending] = useState(false),
    seen = useRef<string | null>(null);
  const [state, setState] = useState<"loading" | "valid" | "invalid" | "error">(
      "loading",
    ),
    [attempt, setAttempt] = useState(0);
  const capture = useReferralCaptureRecord(),
    belongsToOwner =
      !capture?.owner ||
      capture.owner === JSON.stringify([auth.mode, auth.identity]);
  const overview = useReferralOverview(pending && belongsToOwner),
    owner = overview.session.owner,
    refetch = overview.refetch;
  useEffect(() => {
    let active = true;
    const raw =
      code ??
      new URL(window.location.href).searchParams.get("ref") ??
      /^\/r\/([A-Za-z0-9]{3,16})\/?$/.exec(splitLocale(window.location.pathname).path)?.[1];
    if (!raw || !/^[A-Za-z0-9]{3,16}$/.test(raw)) {
      queueMicrotask(() => {
        if (active) {
          setState("invalid");
          setPending(!!pendingReferral());
        }
      });
      return () => {
        active = false;
      };
    }
    const canonical = raw.toUpperCase();
    if (seen.current === canonical) return;
    void api
      .get(`/referral/check/${canonical}`)
      .then((value) => {
        const checked = referralCheckSchema.parse(value);
        if (!active) return;
        if (checked.code !== canonical)
          throw new Error("referral_record_mismatch");
        if (checked.valid && captureReferral(canonical)) {
          seen.current = canonical;
          setPending(!!pendingReferral());
          setState("valid");
        } else setState(checked.valid ? "error" : "invalid");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [code, attempt]);
  useEffect(() => {
    let active = true;
    if (pending && auth.status === "signedIn" && auth.mode === "privy") {
      try {
        pinReferral(owner());
      } catch {
        queueMicrotask(() => {
          if (active) setState("error");
        });
      }
    }
    return () => {
      active = false;
    };
  }, [pending, auth.status, auth.mode, auth.identity, owner]);
  useEffect(() => {
    if (
      !pending ||
      !overview.data ||
      auth.status !== "signedIn" ||
      auth.mode !== "privy"
    )
      return;
    const client = referralClient(owner);
    void client
      .bind(overview.data)
      .then((result) => {
        if (result) {
          setPending(false);
          void refetch();
        }
      })
      .catch(() => undefined);
  }, [
    pending,
    overview.data,
    auth.status,
    auth.mode,
    auth.identity,
    owner,
    refetch,
  ]);
  return display ? (
    <div>
      <p role="status">
        {t(
          state === "valid"
            ? "referral.invitation"
            : state === "invalid"
              ? "referral.invalidCode"
              : state === "error"
                ? "referral.error"
                : "referral.loading",
        )}
      </p>
      {state === "error" ? (
        <Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
          {t("common.retry")}
        </Button>
      ) : null}
    </div>
  ) : null;
}
export function ReferralLanding({ code }: { code: string }) {
  const { t } = useI18n(),
    auth = useAuth();
  return (
    <section
      className="mx-auto max-w-lg space-y-4 py-8"
      aria-label={t("referral.title")}
    >
      <h1 className="type-h1">{t("referral.title")}</h1>
      <ReferralCapture code={code} display />
      <p className="text-sm text-muted-foreground">
        {t("referral.payoutUnavailable")}
      </p>
      {auth.status === "signedIn" ? (
        <Button asChild>
          <Link href="/settings?tab=referral&view=referral">
            {t("referral.title")}
          </Link>
        </Button>
      ) : (
        <Button
          disabled={auth.status === "disabled" || auth.status === "loading"}
          onClick={auth.login}
        >
          {t("common.signIn")}
        </Button>
      )}
    </section>
  );
}

export function ReferralSettings() {
  const auth = useAuth();
  if (auth.status !== "signedIn" || auth.mode !== "privy" || !auth.identity)
    return null;
  return <ReferralView key={JSON.stringify([auth.identity, sessionKey()])} />;
}
function LinkQr({ value, label }: { value: string; label: string }) {
  const grid = useMemo(
    () => encodeQR(value, "raw", { ecc: "medium", border: 4 }),
    [value],
  );
  return (
    <svg
      width="180"
      height="180"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${grid.length} ${grid.length}`}
      className="rounded-lg bg-white"
      shapeRendering="crispEdges"
    >
      <path
        fill="#111"
        d={grid
          .flatMap((row, y) =>
            row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : "")),
          )
          .join("")}
      />
    </svg>
  );
}
function ReferralView() {
  const toast = useToast();
  const { t, format } = useI18n(),
    auth = useAuth(),
    capture = useReferralCaptureRecord(),
    overview = useReferralOverview(),
    // The api says "testnet" for every actual copy; on a mainnet deployment that is 正式.
    liveNetwork = useLiveCopyDeployment()?.network ?? null;
  const friendsPager = useCursorPager<string>(), claimsPager = useCursorPager<string>();
  const friends = useReferralFriends(friendsPager.cursor ?? null),
    claims = useReferralClaims(claimsPager.cursor ?? null),
    client = referralClient(overview.session.owner);
  const [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [copied, setCopied] = useState(false),
    [original, setOriginal] = useState<ReferralClaim | null>(null);
  const [pendingCode, setPendingCode] = useState(() => client.pendingCode()),
    [claimKey] = useState(() => claimJournal(overview.session.owner()).read());
  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "",
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Which action runs (its button shows the orbit mark; the others wait).
  const [acting, setActing] = useState<string | null>(null);
  const action = async (fn: () => Promise<unknown>, name: string) => {
    setBusy(true);
    setActing(name);
    setError(false);
    try {
      await fn();
      if (name === "save") toast.success(t("toast.saved"));
      else if (name === "copy") toast.success(t("trader.share.copied"));
    } catch {
      toast.error(t("common.errors.failed"));
      if (alive.current) setError(true);
    } finally {
      if (alive.current) {
        setBusy(false);
        setActing(null);
        setPendingCode(client.pendingCode());
      }
    }
  };
  const data = overview.data,
    link = data && origin ? `${origin}${data.link}` : null;
  const deadline = data?.bindOpenUntil
    ? `${format.dateTime(data.bindOpenUntil)} ${TIME_ZONE_LABEL}`
    : null;
  return (
    <section aria-label={t("referral.title")} className="space-y-5 pt-5 pb-8">
      <h2 className="text-lg font-bold">{t("referral.title")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("referral.payoutUnavailable")}
      </p>
      {!data ? (
        <>
          <p role="status">
            {overview.isError ? t("referral.error") : t("referral.loading")}
          </p>
          <Button variant="secondary" loading={overview.isFetching} onClick={() => void overview.refetch()}>
            {t("common.retry")}
          </Button>
        </>
      ) : (
        <>
          <div className="space-y-2">
            <p className="font-mono">{data.code}</p>
            {link ? (
              <>
                <p className="break-all text-sm">{link}</p>
                <Button
                  variant="secondary"
                  loading={acting === "copy"}
                  onClick={() =>
                    void action(async () => {
                      if (!navigator.clipboard)
                        throw new Error("clipboard_unavailable");
                      await navigator.clipboard.writeText(link);
                      if (alive.current) setCopied(true);
                    }, "copy")
                  }
                >
                  {t(copied ? "referral.copied" : "referral.copyLink")}
                </Button>
                <details>
                  <summary className="cursor-pointer">
                    {t("referral.qr")}
                  </summary>
                  <LinkQr value={link} label={t("referral.qr")} />
                </details>
              </>
            ) : null}
          </div>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || pendingCode) return;
              void action(async () => {
                await client.setCode(code);
                await overview.refetch();
                if (alive.current) setCode("");
              }, "save");
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              {t("referral.customCode")}
              <input
                name="referralCode"
                className="orbit-card rounded-xl! p-2"
                value={code}
                minLength={3}
                maxLength={16}
                pattern="[A-Za-z0-9]{3,16}"
                required
                disabled={!!pendingCode || busy}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <Button loading={acting === "save"} disabled={acting !== "save" && (busy || !!pendingCode)}>
              {t("referral.save")}
            </Button>
          </form>
          {pendingCode ? (
            <div>
              <p>{t("referral.pending")}</p>
              <Button
                variant="secondary"
                loading={acting === "recoverCode"}
                disabled={busy && acting !== "recoverCode"}
                onClick={() =>
                  void action(async () => {
                    await client.recoverCode();
                    await overview.refetch();
                  }, "recoverCode")
                }
              >
                {t("referral.checkOriginal")}
              </Button>
            </div>
          ) : null}
          <p className="text-sm">
            {data.referred
              ? t("referral.bound")
              : deadline
                ? t("referral.deadline", { time: deadline })
                : t("referral.bindingClosed")}
          </p>
          {!data.policy.enabled ? (
            <p className="text-sm text-muted-foreground">
              {t("referral.policyInactive")}
            </p>
          ) : null}
          <p className="text-sm">
            {data.policy.rewardBps === null
              ? t("referral.rateUnknown")
              : t("referral.rate", { rate: `${data.policy.rewardBps / 100}%` })}
          </p>
          <p className="text-sm">
            {data.policy.minClaimUnits === null
              ? t("referral.minimumUnknown")
              : t("referral.minimum", {
                  amount: referralUnits(data.policy.minClaimUnits),
                })}
          </p>
          <dl className="grid grid-cols-2 gap-3">
            {(["earned", "available", "pending", "claimed"] as const).map(
              (key) => (
                <div key={key}>
                  <dt className="text-xs text-muted-foreground">
                    {t(
                      `referral.${key === "pending" ? "pendingBalance" : key}`,
                    )}
                  </dt>
                  <dd className="font-mono">
                    {referralUnits(data.balances[key])} USDC
                  </dd>
                </div>
              ),
            )}
          </dl>
          <Button disabled>{t("referral.claim")}</Button>
        </>
      )}
      {capture?.attempted &&
      capture.owner === JSON.stringify([auth.mode, auth.identity]) &&
      data &&
      !data.referred ? (
        <div>
          <p>{t("referral.pending")}</p>
          <p className="font-mono">{capture.code}</p>
          <Button
            variant="secondary"
            loading={overview.isFetching}
            disabled={busy}
            onClick={() => void overview.refetch()}
          >
            {t("referral.checkOriginal")}
          </Button>
        </div>
      ) : null}
      {claimKey || original ? (
        <div>
          {!original || ["unknown", "sending"].includes(original.status) ? (
            <p>{t("referral.pending")}</p>
          ) : null}
          <Button
            loading={acting === "recoverClaim"}
            disabled={busy && acting !== "recoverClaim"}
            variant="secondary"
            onClick={() =>
              void action(async () => {
                const found = await client.recoverClaim();
                if (alive.current) setOriginal(found);
              }, "recoverClaim")
            }
          >
            {t("referral.checkOriginal")}
          </Button>
          {original ? <ClaimRow claim={original} /> : null}
        </div>
      ) : null}
      {error ? <p role="alert">{t("referral.error")}</p> : null}
      <h3 className="font-semibold">{t("referral.friends")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("referral.copyingHint")}
      </p>
      {friends.data ? (
        <>
          <p>
            {t("referral.friendCounts", {
              invited: String(friends.data.invited),
              copying: String(friends.data.copying),
            })}
          </p>
          <DataList variant="rows">
            {friends.data.items.map((f) => (
              <li key={f.id}>
                {f.label} ·{" "}
                <time dateTime={f.joinedAt}>
                  {format.dateTime(f.joinedAt)} {TIME_ZONE_LABEL}
                </time>
                {f.copyingModes.map((mode) => (
                  <span
                    key={mode}
                    className="ml-2 rounded bg-raised px-2 text-xs"
                  >
                    {t(
                      mode === "paper" ? "referral.paper" : liveNetwork === "mainnet" ? "mode.live" : "referral.testnet",
                    )}
                  </span>
                ))}
              </li>
            ))}
          </DataList>

        </>
      ) : (
        <>
          <p role="status">
            {t(friends.isError ? "referral.error" : "referral.loading")}
          </p>
          <Button variant="secondary" loading={friends.isFetching} onClick={() => void friends.refetch()}>
            {t("common.retry")}
          </Button>
        </>
      )}
      <TablePager page={friendsPager.page} hasNext={!friends.isError && friends.data?.nextCursor != null} busy={friends.isFetching} onPage={(page) => friendsPager.onPage(page, friends.data?.nextCursor)} />
      <h3 className="font-semibold">{t("referral.claims")}</h3>
      {claims.data ? (
        <>
          <DataList>
            {claims.data.items.map((c) => (
              <li key={c.id}>
                <ClaimRow
                  claim={c}
                  busy={busy}
                  checking={acting === `claim:${c.id}`}
                  onCheck={() =>
                    void action(async () => {
                      const found = await client.readClaim(c);
                      if (alive.current) setOriginal(found);
                    }, `claim:${c.id}`)
                  }
                />
              </li>
            ))}
          </DataList>
          {!claims.data.items.length ? <p>{t("referral.noClaims")}</p> : null}

        </>
      ) : (
        <>
          <p role="status">
            {t(claims.isError ? "referral.error" : "referral.loading")}
          </p>
          <Button variant="secondary" loading={claims.isFetching} onClick={() => void claims.refetch()}>
            {t("common.retry")}
          </Button>
        </>
      )}
      <TablePager page={claimsPager.page} hasNext={!claims.isError && claims.data?.nextCursor != null} busy={claims.isFetching} onPage={(page) => claimsPager.onPage(page, claims.data?.nextCursor)} />
    </section>
  );
}
function ClaimRow({
  claim,
  onCheck,
  busy,
  checking = false,
}: {
  claim: ReferralClaim;
  onCheck?: () => void;
  busy?: boolean;
  /** This row's check is the one running. */
  checking?: boolean;
}) {
  const { t, format } = useI18n();
  return (
    <article className="space-y-1 break-all rounded-lg border border-border p-3 text-sm">
      <p>
        {referralUnits(claim.amountUnits)} USDC ·{" "}
        {t(`referral.states.${claim.status}`)}
      </p>
      <p>
        {t("referral.mainnet")} · {claim.destination}
      </p>
      <p className="font-mono">{claim.id}</p>
      <time dateTime={claim.updatedAt}>
        {format.dateTime(claim.updatedAt)} {TIME_ZONE_LABEL}
      </time>
      {onCheck ? (
        <Button variant="secondary" loading={checking} disabled={busy && !checking} onClick={onCheck}>
          {t("referral.checkOriginal")}
        </Button>
      ) : null}
    </article>
  );
}
