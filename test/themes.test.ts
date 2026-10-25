import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { NS, SEM, STY } from '../src/ns.ts'
import { compileStyles } from '../src/style/compile.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const STRUCTURAL = ['cupertino', 'tracker', 'classic', 'doodle', 'fluent']
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
    expect(themes.map((t) => t.slug)).toEqual(['blueprint', 'classic', 'cupertino', 'doodle', 'fluent', 'paper', 'semblance', 'sunset', 'terminal', 'tracker'])
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
    // per-theme descendant rules exist only for the structural themes, and each is guarded
    // against leaking into a differently themed subtree below it (see the next block)
    const descendant = [...css.matchAll(/^ {2}\[data-sem-theme="([a-z]+)"\] [^{\s][^{\n]*\{/gm)].map((m) => m[1])
    expect(new Set(descendant)).toEqual(new Set(STRUCTURAL))
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
    expect(count('semblance')).toBe(7)
    for (const slug of ['paper', 'terminal', 'blueprint', 'sunset']) expect(count(slug), slug).toBe(6)
    // structural themes: two composition tiles (controls, frames), two schemes, two contrasts, ramps
    for (const slug of STRUCTURAL) expect(count(slug), slug).toBe(7)
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
      '◇Semblance', '¶Paper', '▮Terminal', '⌗Blueprint', '◓Sunset', '⌘Cupertino', '▀Tracker', '⊞Classic', '✎Doodle', '◫Fluent',
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

describe('structural themes', () => {
  /** Every compiled rule as [layer, selector, body]. */
  const rules = (() => {
    const out: [string, string, string][] = []
    let layer = ''
    for (const line of css.split('\n')) {
      const l = /^@layer (sem\.\w+) \{$/.exec(line)
      if (l) layer = l[1]!
      const r = /^ {2}(.+?) \{ (.*) \}$/.exec(line)
      if (r) out.push([layer, r[1]!, r[2]!])
    }
    return out
  })()
  const guard = (slug: string) =>
    `:not(:where([data-sem-theme=${slug}] [data-sem-theme]:not([data-sem-theme=${slug}]), [data-sem-theme=${slug}] [data-sem-theme]:not([data-sem-theme=${slug}]) *))`
  const inside = (slug: string) => rules.filter(([, sel]) => sel.startsWith(`[data-sem-theme="${slug}"] `))
  const find = (slug: string, part: string) => {
    const r = inside(slug).find(([, sel]) => sel === `[data-sem-theme="${slug}"] ${part}${guard(slug)}`)
    if (!r) throw new Error(`${slug}: no rule for ${part}`)
    return r[2]
  }
  const FRAME = ':is([data-sem-c=window], [data-sem-c=palette])'
  const control = (...names: string[]) => `${FRAME} .sem-window-control:is(${names.map((n) => `[data-sem-control=${n}]`).join(', ')})`

  it('style what is inside the themed element, in the variants layer, each rule guarded against nested themes', () => {
    for (const slug of STRUCTURAL) {
      const own = inside(slug)
      expect(own.length, slug).toBeGreaterThan(40)
      for (const [layer, sel] of own) {
        expect(layer, sel).toBe('sem.variants')
        expect(sel, sel).toContain(guard(slug))
      }
      // the theme's own custom properties sit on the themed element, after its token block
      expect(rules.filter(([, sel]) => sel === `[data-sem-theme="${slug}"]`).map(([layer]) => layer)).toEqual(['sem.hooks', 'sem.variants'])
    }
    // rules that must beat an intent rule scope themselves with a state, in the intents layer
    for (const slug of STRUCTURAL) {
      const primary = rules.filter(([layer, sel]) => layer === 'sem.intents' && sel.includes('[data-sem-intent="primary"]') && sel.includes(`:where([data-sem-theme=${slug}] *)${guard(slug)}`))
      expect(primary.length, slug).toBeGreaterThan(0)
    }
  })

  it('rebuild the title bar of every frame', () => {
    // Cupertino: traffic lights on the left (close is the last control, ordered first), the title centred over the bar
    expect(find('cupertino', control('close'))).toMatch(/(?=.*order: -3;)(?=.*#ff5f57)/)
    expect(find('cupertino', control('maximize', 'restore'))).toContain('#28c840')
    expect(find('cupertino', `${FRAME} .sem-window-bar strong`)).toMatch(/position: absolute;.*text-align: center/)
    // Tracker: a yellow tab only as wide as its title, close box first
    expect(find('tracker', `${FRAME} .sem-window-bar`)).toContain('justify-self: start')
    expect(find('tracker', control('close'))).toContain('order: -1')
    expect(rules.find(([, sel]) => sel === '[data-sem-theme="tracker"]' )).toBeDefined()
    // Classic: a navy caption gradient from the bevel kit, square raised controls
    expect(find('classic', `${FRAME} .sem-window-bar`)).toContain('background: var(--bv-title)')
    expect(find('classic', `${FRAME} .sem-window-control`)).toContain('box-shadow: var(--bv-raised)')
    const classicVars = rules.filter(([, sel]) => sel === '[data-sem-theme="classic"]')[1]![2]
    expect(classicVars).toMatch(/--bv-title: linear-gradient\(90deg, light-dark\(#000080/)
    // Doodle: inked strokes on wobbly corners
    expect(find('doodle', `${FRAME}`)).toContain('border-radius: var(--wob-c)')
    // Fluent: wide flat caption buttons on the right, close red under the pointer, the window's icon before the title
    expect(find('fluent', `${FRAME} .sem-window-control`)).toMatch(/(?=.*width: 46px)(?=.*border-radius: 0)/)
    expect(find('fluent', `${control('close')}:hover`)).toContain('background: #c42b1c')
    expect(rules.some(([, sel, body]) => sel.startsWith('[data-sem-theme="fluent"] ') && sel.endsWith('::before') && sel.includes('.sem-window-bar strong') && body.includes('width: 16px'))).toBe(true)
  })

  it('restyle controls, not only colours', () => {
    expect(find('cupertino', ':is([data-sem-c=segmented], [data-sem-c=theme-switcher]) button[aria-pressed=true]')).toContain('var(--mac-thumb-shadow)')
    expect(find('classic', '[data-sem-c=tabs] [role=tab][aria-selected=true]')).toContain('margin-bottom: -2px')
    expect(find('tracker', '[data-sem-c=tabs] [role=tab]')).toContain('clip-path: polygon(')
    expect(find('classic', '[data-sem-c=checkbox] > .sem-row > input:checked')).toContain('linear-gradient(45deg')
    expect(find('doodle', '[data-sem-c=text-field] input')).toContain('border-bottom: 2px solid var(--ink)')
    for (const slug of ['classic', 'tracker']) expect(find(slug, '*'), slug).toContain('border-radius: 0')
    // Fluent: the accent underline on a focused field, the accent pill on the selected tab and nav item, a growing knob
    expect(find('fluent', ':is([data-sem-c=text-field] input, [data-sem-c=text-area] > textarea):focus')).toMatch(/(?=.*border-bottom-color: var\(--sem-accent-9\))(?=.*inset 0 -1px 0 var\(--sem-accent-9\))/)
    expect(rules.some(([, sel, body]) => sel === `[data-sem-theme="fluent"] [data-sem-c=tabs] [role=tab][aria-selected=true]${guard('fluent')}::after` && body.includes('background: var(--sem-accent-9)'))).toBe(true)
    expect(rules.some(([, sel, body]) => sel === `[data-sem-theme="fluent"] :is([data-sem-c=nav-list] button[aria-pressed=true], [data-sem-c=nav-link][aria-current=page])${guard('fluent')}::before` && body.includes('height: 16px'))).toBe(true)
    expect(find('fluent', '[data-sem-c=toggle-switch] > button:not(:disabled):hover .sem-thumb')).toContain('width: 14px')
  })

  it('compose with contrast and motion', () => {
    for (const slug of STRUCTURAL) {
      const same = block(`[data-sem-contrast="high"][data-sem-theme="${slug}"]`)
      expect(layerOf(`[data-sem-contrast="high"][data-sem-theme="${slug}"]`)).toBe('sem.variants')
      expect(same.get('--sem-border')).toBe('var(--sem-gray-10)')
      expect(same.get('--s-focus')).toBe('3px solid light-dark(#000000, #ffffff)')
    }
    expect(block(`[data-sem-contrast="high"] :is(${STRUCTURAL.map((s) => `[data-sem-theme=${s}]`).join(', ')})`).get('--s-focus')).toContain('3px solid')
    // every transition and animation a structural rule declares runs on the duration tokens, which motion preference zeroes
    for (const slug of STRUCTURAL) {
      for (const [, sel, body] of inside(slug)) {
        for (const m of body.matchAll(/(?:^|; )(transition|animation)[\w-]*: ([^;]+)/g)) expect(m[2], sel).not.toMatch(/\d(ms|s)\b/)
      }
    }
  })

  it('keep frames in their tile on the Themes page, each control named by data-sem-control', () => {
    const m = mountShell()
    const sf = m.store.factory
    const app = sf.namedNode(UI + 'app')
    m.runtime.apply({
      remove: m.store.match(app, sf.namedNode(UI + 'galleryGroup'), null),
      add: [sf.quad(app, sf.namedNode(UI + 'galleryGroup'), sf.namedNode(UI + 'GroupThemes'))],
    })
    m.showPage('Components')
    const root = (local: string) => [...m.document.querySelectorAll('*')].find((el) => m.shell.keyOf(el) === `${UI}${local}/~root`) ?? null
    for (const slug of ['semblance', ...STRUCTURAL]) {
      const tile = root(`thf-${slug}`)!
      expect(tile.getAttribute('data-sem-theme')).toBe(slug)
      const bar = tile.querySelector('[data-sem-c=window] .sem-window-bar')!
      // the CSS finds each control by what it is
      expect([...bar.querySelectorAll('.sem-window-control')].map((c) => c.getAttribute('data-sem-control'))).toEqual(['minimize', 'maximize', 'close'])
      expect([...tile.querySelectorAll('[data-sem-c=palette] .sem-window-control')].map((c) => c.getAttribute('data-sem-control'))).toEqual(['close'])
    }
    // switching the shell to a structural theme is still one triple
    const option = (label: string) => [...root('themeSwitch')!.querySelectorAll('button')].find((b) => b.textContent!.includes(label))!
    m.fire(option('Classic'), 'click')
    expect(root('shell')!.getAttribute('data-sem-theme')).toBe('classic')
    expect(root('thf-cupertino')!.getAttribute('data-sem-theme')).toBe('cupertino')
  })
})

describe('long labels', () => {
  const lines = css.split('\n')
  const ruleAt = (selector: string) => lines.findIndex((l) => l.startsWith(`  ${selector} { `))

  it('wrap inside a nav list item and a menu item, over the inherited nowrap', () => {
    for (const selector of ['[data-sem-c="nav-list"] button', '[data-sem-c="menu-item"]']) {
      const decl = block(selector)
      expect(decl.get('white-space'), selector).toBe('normal')
      expect(decl.get('overflow-wrap'), selector).toBe('anywhere')
      expect(decl.get('text-align'), selector).toBe('start')
    }
    // The nav list is a segmented control, whose (horizontal, scrolling) options do not wrap: its
    // own rule comes later in the same layer, so it wins.
    const segmented = lines.findIndex((l) => l.startsWith('  [data-sem-c="segmented"] button, [data-sem-c="nav-list"] button, '))
    expect(segmented).toBeGreaterThan(-1)
    expect(lines[segmented]).toContain('white-space: nowrap')
    expect(layerOf('[data-sem-c="nav-list"] button')).toBe(layerOf(lines[segmented]!.trim().split(' { ')[0]!))
    expect(ruleAt('[data-sem-c="nav-list"] button')).toBeGreaterThan(segmented)
    // A menu's popup is never wider than the screen, so its items have somewhere to wrap.
    expect(block('[data-sem-c="menu"] > .sem-menu-popup').get('max-width')).toBe('min(360px, calc(100vw - 32px))')
  })

  it('no theme puts nowrap back on a nav list item or a menu item', () => {
    const offending = lines.filter((l) => /white-space: nowrap/.test(l) && /nav-list\] button|menu-item\]/.test(l) && !/visually-hidden/.test(l))
    expect(offending.filter((l) => !l.startsWith('  [data-sem-c="segmented"] button, '))).toEqual([])
  })

  it('align text logically, so it follows the writing direction (RTL)', () => {
    expect(lines.filter((l) => /text-align: (left|right)\b/.test(l))).toEqual([])
  })
})
