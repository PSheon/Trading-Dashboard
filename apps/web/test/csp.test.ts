import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, newNonce, privyAuthOrigins } from "../src/lib/csp";

const parse = (policy: string) =>
  Object.fromEntries(policy.split("; ").map((d) => { const [name, ...values] = d.split(" "); return [name, values]; }));

describe("Content-Security-Policy", () => {
  it("allows scripts only by nonce (strict-dynamic), without unsafe-inline or unsafe-eval in production", () => {
    const p = parse(contentSecurityPolicy({ nonce: "abc123==", dev: false }));
    expect(p["script-src"]).toEqual(expect.arrayContaining(["'nonce-abc123=='", "'strict-dynamic'"]));
    expect(p["script-src"]).not.toContain("'unsafe-inline'");
    expect(p["script-src"]).not.toContain("'unsafe-eval'");
    expect(p["object-src"]).toEqual(["'none'"]);
    expect(p["frame-ancestors"]).toEqual(["'none'"]);
    expect(p["base-uri"]).toEqual(["'self'"]);
    expect(p).toHaveProperty("upgrade-insecure-requests");
    expect(parse(contentSecurityPolicy({ nonce: "x", dev: true }))["script-src"]).toContain("'unsafe-eval'");
  });

  it("connects only to ourselves, Privy, Hyperliquid, Arbitrum RPC and t.me", () => {
    const connect = parse(contentSecurityPolicy({ nonce: "n", dev: false }))["connect-src"];
    for (const origin of ["'self'", "https://auth.privy.io", "https://*.rpc.privy.systems", "wss://api.hyperliquid.xyz", "https://api.hyperliquid.xyz",
      "wss://api.hyperliquid-testnet.xyz", "https://api.hyperliquid-testnet.xyz", "https://arb1.arbitrum.io", "https://sepolia-rollup.arbitrum.io", "https://t.me"]) {
      expect(connect).toContain(origin);
    }
    expect(connect).not.toContain("https:");
    expect(connect).not.toContain("*");
  });

  it("makes a fresh nonce each time", () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(a);
  });

  it("allows the Privy app's custom auth domain for its iframe and API, configurable per deployment", () => {
    const origins = privyAuthOrigins("https://privy.example.com, http://insecure.example, https://x.example/path, not a url");
    expect(origins).toEqual(["https://privy.orbie.fun", "https://privy.stage.orbie.fun", "https://privy.example.com"]);
    const p = parse(contentSecurityPolicy({ nonce: "n", dev: false, privyOrigins: origins }));
    for (const d of ["connect-src", "frame-src", "child-src"]) expect(p[d]).toEqual(expect.arrayContaining(origins));
    expect(p["script-src"]).not.toContain("https://privy.example.com");
  });
});
