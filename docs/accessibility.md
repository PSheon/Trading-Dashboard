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
