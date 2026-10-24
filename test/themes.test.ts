import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { NS, SEM, STY } from '../src/ns.ts'
import { compileStyles } from '../src/style/compile.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const store = loadStore('n3')
const css = compileStyles(store)
const f = store.factory
const themes = store
  .match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(NS.sty + 'Theme'))
  .map((q) => ({ iri: q.subject.value, slug: store.match(q.subject, f.namedNode(SEM.slug), null)[0]!.object.value }))
  .sort((a, b) => (a.slug < b.slug ? -1 : 1))

/** The declarations of the first rule whose selector is exactly `selector`, as a map. */
function block(selector: string): Map<string, string> {
  const at = css.indexOf(`  ${selector} { `)
  if (at < 0) throw new Error(`no rule for ${selector}`)
  const body = css.slice(at + selector.length + 5, css.indexOf(' }\n', at))
  const out = new Map<string, string>()
  // split on ';' outside parentheses (values contain url("...;...") and nested functions)
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ';' && depth === 0) {
      const decl = body.slice(start, i).trim()
      const colon = decl.indexOf(':')
      out.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim())
      start = i + 1
    }
  }
  return out
}
const rootTokens = block(':root')
const layerOf = (selector: string) => {
  const at = css.indexOf(`  ${selector} { `)
  const layers = [...css.slice(0, at).matchAll(/@layer (sem\.\w+) \{/g)]
  return layers.at(-1)?.[1]
}

// --- contrast --------------------------------------------------------------------------------
function resolve(theme: Map<string, string>, name: string, side: 0 | 1): string {
  let v = theme.get(`--sem-${name}`) ?? rootTokens.get(`--sem-${name}`)
  if (!v) throw new Error(`no --sem-${name}`)
  for (let i = 0; i < 5; i++) {
    const ref = /^var\(--sem-([\w-]+)\)$/.exec(v)
    if (!ref) break
    v = theme.get(`--sem-${ref[1]}`) ?? rootTokens.get(`--sem-${ref[1]}`)!
  }
  const pair = /^light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\)$/i.exec(v)
  if (pair) return pair[side + 1]!
  if (/^#[0-9a-f]{6}$/i.test(v)) return v
  throw new Error(`--sem-${name} is not a plain color: ${v}`)
}
const luminance = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

// Text roles every theme must keep readable, in both schemes: [foreground, background, minimum].
const textRoles: [string, string, number][] = [
  ['text', 'surface', 7], ['text', 'canvas', 7], ['text', 'surface-sunken', 7], ['text', 'surface-overlay', 7],
  ['muted', 'surface', 4.5], ['muted', 'canvas', 4.5], ['muted', 'surface-sunken', 4.5], ['muted', 'surface-hover', 4.5],
  ['accent', 'surface', 4.5], ['accent', 'canvas', 4.5], ['accent-11', 'surface', 4.5], ['accent-11', 'accent-3', 4.5],
  ['on-accent', 'accent', 4.5], ['gray-1', 'gray-12', 7], ['tooltip-fg', 'tooltip-bg', 7],
]
// ...and what the new themes guarantee beyond the default (solids, status text).
const solidRoles: [string, string, number][] = [
  ['accent-contrast', 'accent-9', 4.5],
  ['on-status', 'info-9', 4.5], ['on-status', 'success-9', 4.5], ['on-status', 'danger-9', 4.5],
  ['danger', 'surface', 4.5], ['success', 'surface', 4.5],
  ...['info', 'success', 'warning', 'danger'].flatMap((s): [string, string, number][] => [[`${s}-11`, `${s}-3`, 4.5], [`${s}-11`, 'surface', 4.5]]),
]

describe('themes are values of a hookable axis', () => {
  it('declares sty:theme as a hooked property over sty:Theme individuals', () => {
    expect(store.match(f.namedNode(NS.sty + 'theme'), f.namedNode(STY.hookAttribute), null)[0]?.object.value).toBe('data-sem-theme')
    expect(themes.map((t) => t.slug)).toEqual(['blueprint', 'paper', 'semblance', 'sunset', 'terminal'])
    for (const t of themes) {
      const labels = store.match(f.namedNode(t.iri), f.namedNode(NS.rdfs + 'label'), null).map((q) => q.object)
      expect(labels.some((l) => l.termType === 'Literal' && l.language === 'en'), t.slug).toBe(true)
      expect(store.match(f.namedNode(t.iri), f.namedNode(SEM.order), null)).toHaveLength(1)
      expect(store.match(f.namedNode(t.iri), f.namedNode(SEM.symbol), null)).toHaveLength(1)
    }
  })

  it('compiles each theme into one hooks-layer block that re-declares the role tokens', () => {
    const sets = themes.map((t) => {
      const sel = `[data-sem-theme="${t.slug}"]`
      expect(layerOf(sel), t.slug).toBe('sem.hooks')
      return [t.slug, block(sel)] as const
    })
    const roles = ['canvas', 'surface', 'surface-sunken', 'surface-overlay', 'text', 'muted', 'faint', 'border', 'border-strong', 'accent', 'accent-strong', 'accent-soft', 'on-accent', 'ring', 'font', 'radius', 'radius-card', 'shadow-raised', 'motion']
    for (const [slug, decls] of sets) {
      for (const r of roles) expect(decls.has(`--sem-${r}`), `${slug} --sem-${r}`).toBe(true)
      for (let i = 1; i <= 12; i++) expect(decls.has(`--sem-gray-${i}`) && decls.has(`--sem-accent-${i}`), `${slug} step ${i}`).toBe(true)
      expect(decls.get('background'), slug).toBe('var(--sem-backdrop)')
    }
    // Every theme declares the same set, so a theme nested in another never inherits from it.
    const keys = sets.map(([, d]) => [...d.keys()].sort().join(' '))
    expect(new Set(keys).size).toBe(1)
    // Every :root token derived with var() is restated (it is resolved where it is declared).
    const derived = [...rootTokens].filter(([k, v]) => v.includes('var(--sem-') && sets[0]![1].has(k)).map(([k]) => k)
    expect(derived).toEqual(expect.arrayContaining(['--sem-canvas', '--sem-accent-soft', '--sem-ring', '--sem-motion']))
    for (const [k, v] of rootTokens) {
      if (!v.includes('var(--sem-')) continue
      const inputs = [...v.matchAll(/var\((--sem-[\w-]+)\)/g)].map((m) => m[1]!)
      if (inputs.some((i) => sets.some(([, d]) => d.has(i)))) expect(sets.every(([, d]) => d.has(k)), k).toBe(true)
    }
  })

  it('leaves durations and spacing alone, so motion preference and density still apply', () => {
    for (const t of themes) {
      const decls = block(`[data-sem-theme="${t.slug}"]`)
      for (const k of decls.keys()) expect(k, t.slug).not.toMatch(/^--sem-(duration|space-|font-size)/)
    }
  })

  it('lets contrast and motion preference win over a theme, on the element and beneath it', () => {
    const at = (s: string) => css.indexOf(`  ${s} { `)
    for (const t of themes) {
      expect(at('[data-sem-contrast="high"]')).toBeGreaterThan(at(`[data-sem-theme="${t.slug}"]`))
      expect(at('[data-sem-motion="reduced"]')).toBeGreaterThan(at(`[data-sem-theme="${t.slug}"]`))
      // High contrast restated in the theme's own ramps, on the same element...
      const same = block(`[data-sem-contrast="high"][data-sem-theme="${t.slug}"]`)
      expect(layerOf(`[data-sem-contrast="high"][data-sem-theme="${t.slug}"]`)).toBe('sem.variants')
      expect(same.get('--sem-border')).toBe('var(--sem-gray-10)')
    }
    // ...and for a themed subtree under a high-contrast (or reduced-motion) ancestor.
    expect(block('[data-sem-contrast="high"] [data-sem-theme]').get('--sem-text')).toContain('var(--sem-gray-12)')
    expect(block('[data-sem-motion="reduced"] [data-sem-theme]').get('--sem-spring')).toBe('linear')
  })

  it('keeps text roles readable in Day and Night', () => {
    const failures: string[] = []
    for (const t of themes) {
      const decls = block(`[data-sem-theme="${t.slug}"]`)
      const pairs = t.slug === 'semblance' ? textRoles : [...textRoles, ...solidRoles]
      for (const [fg, bg, min] of pairs) {
        for (const side of [0, 1] as const) {
          const r = ratio(resolve(decls, fg, side), resolve(decls, bg, side))
          if (r < min) failures.push(`${t.slug} ${side ? 'night' : 'day'} ${fg} on ${bg}: ${r.toFixed(2)} < ${min}`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('reads theme-level tokens in generic rules, so the nearest theme wins', () => {
    for (const sel of ['[data-sem-theme] [data-sem-c="heading"]::after', '[data-sem-theme] [data-sem-c="progress"] .sem-fill', '[data-sem-theme] [data-sem-tone="accent"]']) {
      expect(layerOf(sel), sel).toBe('sem.components')
      for (const v of block(sel).values()) expect(v, sel).toMatch(/var\(--sem-/)
    }
    // no per-theme descendant rules (they would leak into a differently themed subtree)
    expect(css).not.toMatch(/\[data-sem-theme="[a-z]+"\] [^{\s][^{]*\{/)
  })
})

describe('switching themes', () => {
  const open = () => {
    const m = mountShell()
    const app = f.namedNode(UI + 'app')
    const sf = m.store.factory
    m.runtime.apply({
      remove: m.store.match(sf.namedNode(app.value), sf.namedNode(UI + 'galleryGroup'), null),
      add: [sf.quad(sf.namedNode(app.value), sf.namedNode(UI + 'galleryGroup'), sf.namedNode(UI + 'GroupThemes'))],
    })
    m.showPage('Components')
    // The DOM node rendered for a component's root (DOM nodes are keyed by RDF/HTML node IRI).
    const root = (local: string) => [...m.document.querySelectorAll('*')].find((el) => m.shell.keyOf(el) === `${UI}${local}/~root`) ?? null
    return { ...m, root }
  }

  it('scopes a theme to the subtree that carries it', () => {
    const { document, root } = open()
    const themed = [...document.querySelectorAll('[data-sem-theme]')]
    const count = (slug: string) => themed.filter((e) => e.getAttribute('data-sem-theme') === slug).length
    // the shell, plus one composition, two schemes and the ramps per theme; two contrast tiles per non-default theme
    expect(count('semblance')).toBe(5)
    for (const slug of ['paper', 'terminal', 'blueprint', 'sunset']) expect(count(slug), slug).toBe(6)
    const paper = root('th-paper')!
    expect(paper.getAttribute('data-sem-theme')).toBe('paper')
    expect(paper.querySelector('[data-sem-c=heading]')).not.toBeNull()
    const night = root('th-terminal-dark')!
    expect(night.getAttribute('data-sem-color-scheme')).toBe('dark')
    expect(root('th-sunset-high')!.getAttribute('data-sem-contrast')).toBe('high')
  })

  it('re-themes the whole shell from the theme switch (one triple)', () => {
    const { fire, store: s, root } = open()
    const shellRoot = () => root('shell')!
    const option = (label: string) =>
      [...root('themeSwitch')!.querySelectorAll('button')].find((b) => b.textContent!.includes(label))!
    expect([...root('themeSwitch')!.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      '◇Semblance', '¶Paper', '▮Terminal', '⌗Blueprint', '◓Sunset',
    ])
    fire(option('Paper'), 'click')
    expect(shellRoot().getAttribute('data-sem-theme')).toBe('paper')
    expect(option('Paper').getAttribute('aria-pressed')).toBe('true')
    fire(option('Terminal'), 'click')
    expect(shellRoot().getAttribute('data-sem-theme')).toBe('terminal')
    const values = s.match(s.factory.namedNode(UI + 'shell'), s.factory.namedNode(NS.sty + 'theme'), null).map((q) => q.object.value)
    expect(values).toEqual([NS.sty + 'Terminal'])
    // a scoped theme is unaffected by the shell's
    expect(root('th-paper')!.getAttribute('data-sem-theme')).toBe('paper')
  })
})
