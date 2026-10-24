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
})
