import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Application, Request } from "express";
import { beforeAll, describe, expect, it } from "vitest";

import { clientAddress } from "../src/api/actions/action-stream.service.js";
import { clientKey } from "../src/common/http/client-key.js";
import { trustedProxyMatcher } from "../src/common/http/trusted-proxies.js";
import { validateEnvironment } from "../src/config/runtime-config.js";

/**
 * Stage on Railway: browser → Railway edge → `web` → (private network,
 * IPv6 fd12:…) → `api`. The web forwarder sends the browser's address as
 * the only X-Forwarded-For entry. docs/rate-limits.md has the settings.
 */
const STAGE = { API_TRUSTED_PROXY_CIDRS: "fd12::/16", STREAM_TRUSTED_PROXY_HOPS: "1" };
const WEB_PEER = "fd12:74d7:7e85:0:2000:1b:f6c2:1a2";
const BROWSER = "203.0.113.9";

/** `req.ip` as Express resolves it with the api's `trust proxy` setting (bootstrap/http.setup.ts). */
let app: Application;
beforeAll(async () => {
  @Module({})
  class Empty {}
  const nest = (await Test.createTestingModule({ imports: [Empty] }).compile()).createNestApplication({ logger: false });
  app = nest.getHttpAdapter().getInstance() as Application;
  app.set("trust proxy", STAGE.API_TRUSTED_PROXY_CIDRS.split(","));
});
function expressIp(peer: string, forwarded?: string): string | undefined {
  const req = Object.create((app as unknown as { request: object }).request) as Request;
  Object.assign(req, { app, headers: forwarded ? { "x-forwarded-for": forwarded } : {}, socket: { remoteAddress: peer }, connection: { remoteAddress: peer } });
  return req.ip;
}
const stream = (peer: string, forwarded?: string) =>
  clientAddress({ headers: forwarded ? { "x-forwarded-for": forwarded } : {}, socket: { remoteAddress: peer } } as never, Number(STAGE.STREAM_TRUSTED_PROXY_HOPS), trustedProxyMatcher(STAGE.API_TRUSTED_PROXY_CIDRS.split(",")));

describe("per-client identity behind the web service on Railway's private network (review 28)", () => {
  it("the Stage values pass environment validation's CIDR rule", () => {
    expect(() => validateEnvironment({ ...process.env, NODE_ENV: "test", ...STAGE })).not.toThrow();
  });

  it("rate limits and the page budget (req.ip): the browser the web service names, one bucket per browser", () => {
    expect(expressIp(WEB_PEER, BROWSER)).toBe(BROWSER);
    expect(clientKey(expressIp(WEB_PEER, "198.51.100.4"))).not.toBe(clientKey(expressIp(WEB_PEER, BROWSER)));
    // Another replica or deployment of web has another address in the same range.
    expect(expressIp("fd12:74d7:7e85:0:4000:2:aaaa:bbbb", BROWSER)).toBe(BROWSER);
  });

  it("a caller that is not the web service can't name its own address: the socket peer counts", () => {
    // Through the api's own public domain (Railway's edge) or any other route in.
    expect(expressIp("100.64.0.7", "6.6.6.6")).toBe("100.64.0.7");
    expect(stream("100.64.0.7", "6.6.6.6")).toBe("100.64.0.7");
    // The web service's own server-side calls that carry no address count as the web service.
    expect(expressIp(WEB_PEER)).toBe(WEB_PEER);
  });

  it("live-feed streams count per browser with STREAM_TRUSTED_PROXY_HOPS=1", () => {
    expect(stream(WEB_PEER, BROWSER)).toBe(BROWSER);
    expect(stream(WEB_PEER, "2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(stream(WEB_PEER)).toBe(clientKey(WEB_PEER));
  });

  it("with neither variable set (Stage today) every visitor is the web service", () => {
    const untrusted = trustedProxyMatcher([]);
    const one = clientAddress({ headers: { "x-forwarded-for": BROWSER }, socket: { remoteAddress: WEB_PEER } } as never, 0, untrusted);
    const other = clientAddress({ headers: { "x-forwarded-for": "198.51.100.4" }, socket: { remoteAddress: WEB_PEER } } as never, 0, untrusted);
    expect(one).toBe(other);
  });
});
