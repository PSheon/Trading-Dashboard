import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FaqList } from "../src/components/content/faq";
import { Segmented } from "../src/components/ui/segmented";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

/** Tailwind v4's preflight resets `cursor` on buttons; CopyDog shows the
 * hand on every control that acts on click and not-allowed on disabled
 * ones. The base rule in globals.css restores that for the whole app. */
describe("cursor: pointer on interactive elements", () => {
  it("globals.css gives the hand to buttons, links, tabs, menu items, options, radios, switches, summaries and labels", () => {
    const rule = /button:not\(:disabled\),[\s\S]*?\{\s*cursor: pointer;\s*\}/.exec(css)?.[0] ?? "";
    for (const selector of ['[role="button"]:not([aria-disabled="true"])', '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="radio"]:not(:disabled)', '[role="switch"]:not(:disabled)', "a[href]", "summary", "label[for]", "select:not(:disabled)"]) {
      expect(rule, selector).toContain(selector);
    }
    expect(css).toMatch(/button:disabled,\s*\[aria-disabled="true"\],[\s\S]*?\{\s*cursor: not-allowed;\s*\}/);
  });

  it("renders the controls the rule targets: segmented options as role=radio buttons, FAQ questions as summaries", () => {
    const wrap = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}>{node}</I18nProvider>);
    const segmented = wrap(<Segmented value="a" onChange={() => {}} label="x" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />);
    expect(segmented.match(/<button[^>]*role="radio"/g)).toHaveLength(2);
    const faq = wrap(<FaqList sections={[{ title: null, questions: [{ question: "Q", answer: [{ type: "paragraph", text: "A" }] }] }]} />);
    expect(faq).toContain("<summary");
    expect(faq).toContain("cursor-pointer");
  });
});
