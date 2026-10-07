// Copy harness — the follower: the Privy test account in a real browser on
// the local web. It logs in (email + OTP from Privy's test credentials, read
// with the app secret in this process and never printed), reads its access
// token for api calls, and confirms a one-click setup from the portfolio's
// 繼續設定: the browser signs the consent and the deposit and calls
// addSigners, exactly as a person's would.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { ROOT } from "./lib.mjs";

const webRequire = createRequire(resolve(ROOT, "apps/web/package.json"));

export async function launch({ headless = true, cdpEndpoint = process.env.HARNESS_CDP_ENDPOINT } = {}) {
  const { chromium } = webRequire("@playwright/test");
  // CDP attaches to the existing shared Chrome; it does not launch another.
  return cdpEndpoint ? chromium.connectOverCDP(cdpEndpoint) : chromium.launch({ headless });
}

/** Privy's test account for the app (email + fixed OTP). The secret stays in this process. */
export async function privyTestCredentials(env) {
  const id = env.PRIVY_APP_ID, secret = env.PRIVY_APP_SECRET;
  if (!id || !secret) throw new Error("PRIVY_APP_ID / PRIVY_APP_SECRET are missing from .env");
  const response = await fetch(`https://api.privy.io/v1/apps/${id}/test_credentials`, {
    headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "privy-app-id": id },
  });
  if (!response.ok) throw new Error(`Privy test credentials: HTTP ${response.status}`);
  const cred = (await response.json()).data?.[0];
  if (!cred?.email || !cred?.otp_code) throw new Error("Privy test credentials: none enabled for this app");
  return { email: cred.email, otp: String(cred.otp_code) };
}

/** @typedef {(event: string, data?: Record<string, unknown>) => void} Log */
/** A logged-in page plus an api client that always sends the page's current Privy token.
 * @param {any} browser @param {{ web: string, api: string, env: Record<string, string>, log?: Log }} options */
export async function login(browser, { web, api, env, log = () => {} }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-TW" });
  // The local web is `next dev`: its dev overlay (a stale build error, an HMR
  // warning) would sit over the page and take the clicks. Hidden here, and
  // what it said is logged, so it never decides a run.
  // (CSSOM, not a <style>: the page's CSP refuses inline styles.)
  await context.addInitScript(() => {
    const hide = () => document.querySelectorAll("nextjs-portal").forEach((el) => /** @type {HTMLElement} */ (el).style.setProperty("display", "none", "important"));
    new MutationObserver(hide).observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
  const devErrors = new Set();
  page.on("console", (m) => { if (m.type() === "error" && devErrors.size < 20) { const text = m.text().slice(0, 200); if (!devErrors.has(text)) { devErrors.add(text); log("web_console_error", { text }); } } });
  page.on("pageerror", (e) => log("web_page_error", { message: e.message.slice(0, 300) }));
  const cred = await privyTestCredentials(env);
  await page.goto(`${web}/zh-TW/portfolio`, { waitUntil: "domcontentloaded" });
  const signIn = page.locator("button", { hasText: /^(登入|Sign in)$/ }).first();
  await signIn.waitFor({ timeout: 60_000 });
  // Privy's SDK loads after hydration: the button may need a moment to answer.
  for (let i = 0; i < 20; i++) {
    await signIn.click().catch(() => {});
    if (await page.locator('input[type="email"], input#email-input').count()) break;
    await page.waitForTimeout(1000);
  }
  const email = page.locator('input[type="email"], input#email-input').first();
  await email.waitFor({ timeout: 30_000 });
  await email.fill(cred.email);
  await page.keyboard.press("Enter");
  const otp = page.locator('input[autocomplete="one-time-code"], input[name="code-0"], input[inputmode="numeric"]').first();
  await otp.waitFor({ timeout: 30_000 });
  await otp.focus();
  await page.keyboard.type(cred.otp, { delay: 60 });
  const token = async () => {
    const raw = await page.evaluate(() => localStorage.getItem("privy:token"));
    if (!raw) throw new Error("no Privy token in the page (signed out?)");
    return JSON.parse(raw);
  };
  const client = apiClient(api, token);
  // Signed in once /me answers with the embedded wallet.
  let me = null;
  for (let i = 0; i < 60 && !me?.walletAddress; i++) {
    await page.waitForTimeout(1000);
    try { me = await client.get("/me"); } catch { me = null; }
  }
  if (!me?.walletAddress) throw new Error("login: /me has no embedded wallet after 60 s");
  log("login", { userId: me.id, wallet: me.walletAddress });
  return { context, page, token, client, me: { ...me, walletAddress: me.walletAddress.toLowerCase() } };
}

export class ApiError extends Error {
  constructor(method, path, status, body) {
    const code = body?.error?.code ?? body?.code ?? null;
    super(`${method} ${path} → ${status} ${code ?? ""} ${body?.message ?? ""}`.trim());
    this.status = status; this.body = body; this.code = code;
  }
}
/** The api answers `{ data }` (or the bare value on older routes). */
export function apiClient(base, token) {
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    // Errors: { success: false, statusCode, message, error: { code }, meta }.
    if (!response.ok) throw new ApiError(method, path, response.status, json);
    return json && typeof json === "object" && "data" in json ? json.data : json;
  };
  return { get: (path) => call("GET", path), post: (path, body = {}) => call("POST", path, body) };
}

/**
 * Portfolio → the copy whose setup waits for consent → 繼續設定 → Orbie's
 * confirm sheet → 確認並開始. The browser signs the consent and the deposit,
 * then adds the worker signer (Privy addSigners); only then does it POST
 * /confirm. `dryRun` aborts that POST (nothing is deposited), which still
 * proves the two signatures and addSigners succeeded. Any /confirm for a
 * different setup is aborted.
 */
/** @param {any} page @param {{ web: string, setupId: string, dryRun?: boolean, log?: Log, timeoutMs?: number }} options */
export async function confirmFromPortfolio(page, { web, setupId, dryRun = false, log = () => {}, timeoutMs = 150_000 }) {
  /** @type {{ confirmRequest: any, confirmStatus: number | null, confirmBody: any, wrongSetup: string | null, alert: string | null, privy: string[] }} */
  const seen = { confirmRequest: null, confirmStatus: null, confirmBody: null, wrongSetup: null, alert: null, privy: [] };
  // Privy's own calls while confirming (method, path, status; never bodies): addSigners shows as a signers update.
  let watching = false;
  const onPrivy = (r) => {
    const url = new URL(r.url());
    if (!watching || !/privy\.io$/.test(url.hostname) || r.request().method() === "GET" || r.request().method() === "OPTIONS") return;
    seen.privy.push(`${r.request().method()} ${url.pathname.replace(/[0-9a-z]{20,}/g, ":id")} ${r.status()}`);
  };
  page.on("response", onPrivy);
  await page.route("**/me/copy/live/setups/*/confirm", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const body = route.request().postDataJSON?.() ?? null;
    seen.confirmRequest = { setupId: id, consentSignature: Boolean(body?.consentSignature), fundingSignature: Boolean(body?.fundingSignature) };
    if (id !== setupId) { seen.wrongSetup = id; return route.abort(); }
    if (dryRun) return route.abort();
    return route.continue();
  });
  page.on("response", async (r) => {
    if (!/\/me\/copy\/live\/setups\/[^/]+\/confirm$/.test(new URL(r.url()).pathname)) return;
    seen.confirmStatus = r.status();
    try { seen.confirmBody = await r.json(); } catch { /* not json */ }
  });
  // The supported deep-link migrates through the global mode store to this
  // deployment's actual network. The runner already verified testnet.
  await page.goto(`${web}/zh-TW/portfolio?view=real`, { waitUntil: "domcontentloaded" });
  const cards = page.getByTestId("live-copy-card").filter({ visible: true });
  await cards.first().waitFor({ timeout: 60_000 });
  const resume = page.getByTestId("live-copy-sheet").getByRole("button", { name: "繼續設定", exact: true });
  let found = false;
  for (let i = 0, n = await cards.count(); i < n && !found; i++) {
    await cards.nth(i).click();
    await page.getByTestId("live-copy-sheet").waitFor({ timeout: 15_000 });
    if (await resume.isVisible().catch(() => false) || await resume.waitFor({ timeout: 3000 }).then(() => true, () => false)) { found = true; break; }
    await page.keyboard.press("Escape");
    await page.getByTestId("live-copy-sheet").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  }
  if (!found) throw new Error("portfolio: no copy shows 繼續設定");
  await resume.click();
  const confirm = page.getByRole("dialog", { name: "確認跟單設定" });
  await confirm.getByTestId("live-copy-terms").waitFor({ timeout: 60_000 });
  const terms = (await confirm.getByTestId("live-copy-terms").innerText()).replace(/\s*\n\s*/g, " | ");
  log("confirm_sheet", { terms: terms.slice(0, 300) });
  const t0 = Date.now();
  watching = true;
  await confirm.getByRole("button", { name: "確認並開始" }).click();
  let outcome = null;
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(1000);
    if (seen.wrongSetup) { outcome = "wrong_setup"; break; }
    if (dryRun && seen.confirmRequest) { outcome = "confirm_intercepted"; break; }
    if (seen.confirmStatus !== null) { outcome = seen.confirmStatus === 200 ? "confirmed" : "confirm_refused"; break; }
    const alert = await confirm.getByRole("alert").count() ? await confirm.getByRole("alert").innerText().catch(() => null) : null;
    if (alert) { outcome = "alert"; seen.alert = alert; break; }
  }
  watching = false;
  page.off("response", onPrivy);
  await page.unroute("**/me/copy/live/setups/*/confirm");
  return { outcome: outcome ?? "timeout", ms: Date.now() - t0, ...seen };
}
