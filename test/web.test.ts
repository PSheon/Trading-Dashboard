import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { proxy } from "../src/proxy";

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

describe("proxy", () => {
  afterEach(() => {
    delete process.env.APP_PASSWORD;
  });

  it("lets everything through without a password configured", () => {
    expect(proxy(new NextRequest("http://x/")).status).toBe(200);
  });

  it("requires the password when one is configured", () => {
    process.env.APP_PASSWORD = "s3cret";
    const req = (auth?: string) => new NextRequest("http://x/", { headers: auth ? { authorization: auth } : {} });
    expect(proxy(req()).status).toBe(401);
    expect(proxy(req()).headers.get("www-authenticate")).toContain("Basic");
    expect(proxy(req(basic("any", "wrong"))).status).toBe(401);
    expect(proxy(req(basic("any", "s3cret"))).status).toBe(200);
    expect(proxy(req(basic("a:b", "s3cret"))).status).toBe(401); // the first colon splits user from password
  });
});

describe("client bundle", () => {
  it("client components import nothing server-side from lib", () => {
    const allowed = new Set(["@/lib/format", "@/lib/universe", "@/lib/activity"]);
    const files = [
      ...readdirSync("src/components").map((f) => path.join("src/components", f)),
      "src/app/page.tsx",
    ].filter((f) => /\.tsx?$/.test(f) && readFileSync(f, "utf8").startsWith('"use client"'));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/^import (type )?[^"]+from "(@\/lib\/[^"]+)"/gm)) {
        if (!m[1]) expect(allowed.has(m[2]), `${f} imports ${m[2]}`).toBe(true);
      }
    }
  });
});
