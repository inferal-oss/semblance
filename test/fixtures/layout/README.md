# Layout recordings

Box trees of real pages, measured in Chromium's headless shell by `scripts/layout-check.ts`
(src/layout/measure.ts), for `test/layout-check.test.ts`. Names: `<label>_<page>_<width>_<theme>[_<lang>][_rtl].json`.

| label | checkout | what it shows |
|---|---|---|
| 34-before / 34-after | 999e2af / 19ae80a | #34: single-line controls of one form at different heights |
| 53-before-longlabel / 53-after-longlabel | 08b62ec / 27d4e65, each with `ui:NvRules`'s label lengthened to "Regelauswertungsreihenfolge" in demo/gallery/navigation.ttl | #53: nav items run out of their list (no label on the site was long enough) |
| 320-before / 320-after | 70de219 / 71686f3 | a progress bar and a docked panel wider than a 320px screen |
| 375-before / 375-after | a050a46 / a5fc6b7 | gallery pages 443-1038px wide at 375px |
| 57-main / 57-after | 879f31a (main) / main with PR #125 merged (re-recorded 2026-10-27, resuming the watchdog's suspended update) | #57: the checkout's code and phone fields not lining up |
| today | 879f31a (main); the themes page re-recorded on 881439e with #195 | main at 320px |

Re-record one with, for example:

    npx tsx scripts/layout-check.ts --root <checkout> --label 34-before --out test/fixtures/layout \
      --pages examples/shape-form --widths 1280 --themes semblance,classic,cupertino
