import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { compileStyles } from '../src/style/compile.ts'

describe('rows that line up', () => {
  const css = compileStyles(loadStore('n3'))

  it('pos:Subgrid takes its columns from the grid it is in', () => {
    const rule = css.match(/\[data-sem-layout="subgrid"\][^{]*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule![1]).toMatch(/grid-template-columns:\s*subgrid/)
    expect(rule![1]).toMatch(/grid-column:\s*1 \/ -1/)
  })

  it('a switch takes no part in layout, so tracks reach through it', () => {
    expect(css).toMatch(/\[data-sem-c="?switch"?\][^{,]*\{[^}]*display:\s*contents/)
    expect(css).toMatch(/\[data-sem-c="?switch"?\] > :not\(\[hidden\]\)[^{]*\{[^}]*display:\s*contents/)
  })

  it('form controls fit the column they are given, whatever the engine thinks their minimum is', () => {
    const controls = css.match(/:where\(input:not\(\[type=checkbox\][^{]*\{([^}]*)\}/)![1]!
    expect(controls).toMatch(/min-width:\s*0/)
    expect(controls).toMatch(/max-width:\s*100%/)
    const field = css.match(/\[data-sem-c="?text-field"?\]\s*\{([^}]*)\}/)![1]!
    expect(field).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/)
    expect(field).toMatch(/min-width:\s*0/)
  })

  it("a frame's body inset is the theme's general rule: no theme replaces it", () => {
    // Theme rules sit in a later layer, so a padding there would override the general inset (and
    // the "content's own inset wins" constraint) for every window in that theme.
    const themed = [...css.matchAll(/([^{}]*\.sem-window-body[^{}]*)\{([^}]*)\}/g)].filter(([, sel]) => sel!.includes('data-sem-theme'))
    expect(themed.filter(([, , body]) => /(^|;|\s)padding\s*:/.test(body!)).map(([, sel]) => sel!.trim().slice(0, 80))).toEqual([])
  })

  it('a measure caps how wide a component grows and centres it, for every measure, by token', () => {
    for (const m of ['reading', 'page', 'wide']) {
      const rule = css.match(new RegExp(`\\[data-sem-measure="${m}"\\][^{]*\\{([^}]*)\\}`))
      expect(rule, m).not.toBeNull()
      expect(rule![1]).toMatch(new RegExp(`max-inline-size:\\s*var\\(--sem-measure-${m}\\)`))
      expect(rule![1]).toMatch(/margin-inline:\s*auto/)
      expect(rule![1]).toMatch(/inline-size:\s*100%/)
    }
    expect(css).toMatch(/--sem-measure-page:\s*1120px/)
  })
})
