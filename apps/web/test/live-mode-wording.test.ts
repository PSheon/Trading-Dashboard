import { describe, expect, it } from 'vitest';
import { LOCALES, type Locale } from '@/i18n/config';
import { liveSetupMessages, liveSetupText } from '@/i18n/live-setup';
import { liveCopiesMessages, liveCopiesText } from '@/i18n/live-copies';
import { liveStopMessages } from '@/i18n/copy-live-stop';

/**
 * Real-money copying runs on mainnet (docs/decisions-2026-10-23.md): on a live
 * deployment no locale may still call the copy "testnet", and no locale may
 * fall back to the English mainnet words (the override table is complete).
 */
/** Each locale's words for the test network, as its base (testnet) texts use them. */
const TESTNET_WORDS: Record<Locale, RegExp> = {
  en: /testnet|test funds/i,
  'zh-TW': /測試網|測試資金/,
  'zh-CN': /测试网|测试资金/,
  ja: /テストネット|テスト資金/,
  ko: /테스트넷|테스트 자금/,
  es: /testnet|red de pruebas|fondos de prueba/i,
  pt: /testnet|rede de testes|fundos de teste/i,
  ru: /тестнет|тестов/i,
  id: /testnet|jaringan uji|dana uji/i,
  vi: /testnet|mạng thử nghiệm|tiền thử nghiệm/i,
  tr: /testnet|test ağı|test fonları/i,
};
const strings = (value: unknown, path = ''): [string, string][] => typeof value === 'string' ? [[path, value]]
  : typeof value === 'object' && value !== null ? Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k)) : [];
/** The leader's own network label (a testnet deployment may copy a testnet leader): named after the network it labels, so not a stale word. */
const NETWORK_LABELS = new Set(['testnetLeader', 'mainnetLeader']);
const testnetWorded = (locale: Locale, value: unknown) => strings(value).filter(([path, text]) => !NETWORK_LABELS.has(path) && (TESTNET_WORDS[locale].test(text) || TESTNET_WORDS.en.test(text))).map(([path, text]) => `${path}: ${text}`);

describe('live (mainnet) wording in every locale', () => {
  it('the base texts do name the test network in each locale (the words this test checks are the right ones)', () => {
    for (const locale of LOCALES) {
      expect(testnetWorded(locale, liveSetupMessages[locale]), locale).not.toEqual([]);
      expect(testnetWorded(locale, liveCopiesMessages[locale]), locale).not.toEqual([]);
    }
  });
  it.each(LOCALES)('%s: the setup texts of a live deployment never say testnet', locale => {
    expect(testnetWorded(locale, liveSetupText(locale, 'mainnet'))).toEqual([]);
  });
  it.each(LOCALES)('%s: the copy texts of a mainnet copy never say testnet', locale => {
    expect(testnetWorded(locale, liveCopiesText(locale, 'mainnet'))).toEqual([]);
  });
  it.each(LOCALES.filter(locale => locale !== 'en'))('%s: the live words are its own, not the English fallback', locale => {
    const setup = liveSetupText(locale, 'mainnet'), en = liveSetupText('en', 'mainnet');
    for (const key of ['testnet', 'testnetBalance', 'testnetNote', 'adoptDisabled', 'copying', 'networkValue', 'walletsHint'] as const) expect(setup[key], key).not.toBe(en[key]);
    for (const key of ['setup_unavailable', 'insufficient_main_balance'] as const) expect(setup.errors[key], key).not.toBe(en.errors[key]);
    const copies = liveCopiesText(locale, 'mainnet'), enCopies = liveCopiesText('en', 'mainnet');
    expect(copies.title).not.toBe(enCopies.title);
    expect(copies.hints.active).not.toBe(enCopies.hints.active);
  });
  it('the stop entry point names the mandate without a network (it serves both deployments)', () => {
    for (const locale of LOCALES) expect(testnetWorded(locale, liveStopMessages[locale].select), locale).toEqual([]);
  });
  it('a testnet deployment keeps its own words', () => {
    for (const locale of LOCALES) {
      expect(liveSetupText(locale, 'testnet')).toBe(liveSetupMessages[locale]);
      expect(liveCopiesText(locale, 'testnet')).toBe(liveCopiesMessages[locale]);
    }
  });
});
