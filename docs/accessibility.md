# Accessibility verification

Playwright + axe-core checks WCAG 2 A/AA and 2.1 AA rules for discovery and
trader pages at 1280px and 390px, plus signed-in settings and user/site
administration. CI runs these fixture-mode checks alongside login/logout smoke.
They are not a WCAG conformance certification or coverage of live Privy dialogs.

The audit reproduced and fixed low secondary-text contrast on cards, unnamed
redundant mini-chart SVGs, and keyboard-inaccessible horizontally scrolling
tables. Secondary text now uses #9690b2; named charts retain their image label,
while redundant unlabeled sparklines are hidden from assistive technology.
Tables and active tab panels can receive focus with visible rings.

Activity tabs link their label/panel IDs and support Left/Right/Home/End with a
single tab stop; radio-style segmented controls support arrow navigation and
selection. Native Enter/Space still works. The skip link now explicitly says
skip to main content (both languages) and targets a focusable main element.
The CSV action has an accessible name even when its mobile text is hidden.

Initial public-page scans failed with contrast, SVG name and scroll-focus
findings; both viewport scans now pass. The tab keyboard test failed before the
change and passes afterward. Three additional signed-in routes pass scans.
Manual screen-reader reading order, all high-contrast/zoom modes, chart data
alternatives beyond nearby summaries, every dialog/error state, and real wallet
provider overlays still need human/device validation.

Patterns: [WAI tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) and
[WAI radios](https://www.w3.org/WAI/ARIA/apg/patterns/radio/).

## 2026-10-01 user-page sweep (axe-core 4.13 via @axe-core/playwright, headless Chromium)

Tags wcag2a, wcag2aa, wcag21a, wcag21aa and best-practice, at 1440×900 and
390×844, signed out, on home, explore, trader, coins, favorites, insights,
portfolio, settings, about, help, the login modal, the share dialog and the
copy panel (Privy's iframe excluded). Script and raw results:
`scratchpad/screens-parity-3/axe-scan.mjs`, `axe-before.json`, `axe-after.json`.

| Page | Before (1440 / 390) | After |
| --- | --- | --- |
| home | 1 serious (footer "coming soon" contrast 3.66) / 0 | 0 / 0 |
| explore | 1 serious (coin initials contrast 2.64) + 1 moderate (no h1) / 0 | 0 / 0 |
| trader, copy panel | 2 moderate (h3 after h1; two unnamed `aside`s) / 0 | 0 / 0 |
| coins | 1 serious (coin initials contrast) / 1 | 0 / 0 |
| insights | 1 serious (`aria-label` on 136 plain spans) / 1 | 0 / 0 |
| about | 2 serious (footer contrast; link told apart by colour only) / 2 | 0 / 0 |
| help | 2 serious (footer contrast) / 2 | 0 / 0 |
| favorites, portfolio, settings, login modal, share dialog | 0 / 0 | 0 / 0 |

Fixes: footer "coming soon" labels use the full secondary colour; coin
initials sit on a darker disc (white text ≥ 4.5:1); the coin stack is a
`role="img"` with its label; explore has a screen-reader-only h1 on desktop
(CopyDog's page shows no title there); profile-card section titles are h2;
the profile and copy-panel `aside`s are named (the trader's name, 跟單);
links inside document text are underlined. Toasts render in a polite live
region (`role="alert"` items, a labelled × each) and their motion, like the
about-page avatar stack, stops under `prefers-reduced-motion`. Every control
now shows the hand cursor (see `test/cursor.test.tsx`).

Still manual: screen-reader reading order, keyboard walkthroughs of the
signed-in dialogs (deposit, withdraw, export) and Privy's own modal.
