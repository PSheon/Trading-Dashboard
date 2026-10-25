// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FaqList, faqSections } from "@/components/content/faq";
import { contentBlocks } from "@/lib/content";

/** /help keeps CopyDog's FAQ scope (Paul, 2026-10-25): what it is, the data
 * source, how copying works, fees, safety of funds, supported markets; each
 * answer at most two short sentences, no domain, no testnet-only wording. */
describe("FAQ", () => {
  const QUESTIONS = {
    "zh-TW": ["Orbie 是什麼？", "「公開測試」是什麼意思？", "什麼是 Hyperliquid？", "Orbie 支援哪些市場？", "Orbie 的資料從哪裡來？", "跟單怎麼運作？", "Orbie 怎麼收費？", "我的資金安全嗎？誰控制我的錢包？", "Orbie 下單時能動用我的資金嗎？", "跟單有什麼風險？", "Orbie 提供投資建議嗎？"],
    en: ["What is Orbie?", "What does \"public beta\" mean?", "What is Hyperliquid?", "Which markets does Orbie support?", "Where does Orbie's data come from?", "How does copy trading work?", "How does Orbie make money?", "Are my funds safe? Who controls my wallet?", "Can Orbie touch my funds when it trades for me?", "What are the risks of copy trading?", "Does Orbie give investment advice?"],
  } as const;

  for (const locale of ["zh-TW", "en"] as const) {
    it(`${locale}: only the CopyDog-scope questions, each answered in one paragraph of at most two sentences`, () => {
      const doc = new DOMParser().parseFromString(renderToStaticMarkup(<FaqList sections={faqSections(contentBlocks("faq", locale))} />), "text/html");
      const questions = [...doc.querySelectorAll("button[aria-expanded]")];
      expect(questions.map((q) => q.textContent)).toEqual(QUESTIONS[locale]);
      for (const question of questions) {
        const answer = doc.getElementById(question.getAttribute("aria-controls")!)!;
        // One paragraph, no list or table.
        expect(answer.querySelectorAll("p"), question.textContent!).toHaveLength(1);
        expect(answer.querySelector("ul,ol,table"), question.textContent!).toBeNull();
        const text = answer.textContent!.trim();
        const sentences = text.split(locale === "zh-TW" ? /[。！？]/ : /[.!?](?:\s|$)/).filter((s) => s.trim());
        expect(sentences.length, text).toBeLessThanOrEqual(2);
        expect([...text].length, text).toBeLessThanOrEqual(locale === "zh-TW" ? 70 : 220);
      }
      const all = doc.body.textContent!;
      expect(all).not.toContain("app.orbie.fun");
      expect(all).not.toMatch(/測試網|testnet/i);
    });
  }
});
