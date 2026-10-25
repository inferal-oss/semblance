// Single-line controls share one box (issue #34). The form from a shape put a text field, a date,
// a select and a number side by side, and they came out three heights: each was its padding plus
// whatever the engine draws inside (a native select ignores vertical padding, a date input adds its
// segments). Nothing in the theme said how tall a single-line control is, so no test could notice.
//
// Layout cannot be measured without a browser, so this checks the cascade instead: every rule of
// the compiled stylesheet that matches a single-line control of the form - in every theme, light
// and dark, at phone and desktop width, left to right and right to left, at rest and in every state
// (hover, focus, invalid) - gives its block size only as the shared box does, keeps the border box,
// and leaves a select drawn by the theme with its chevron.
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { NS, RDF_TYPE, SEM } from '../src/ns.ts'
import { compileStyles } from '../src/style/compile.ts'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const BOX = 'var(--control-h, var(--sem-control-height))'

/** Every style rule of the compiled stylesheet: the media condition it sits under, its selectors, its declarations. */
function parseRules(css: string) {
  const rules: { media: string; selectors: string[]; decls: [string, string][] }[] = []
  let media = ''
  let keyframes = false
  for (const line of css.split('\n')) {
    if (line.startsWith('@keyframes')) keyframes = true
    else if (line.startsWith('@')) keyframes = false
    if (keyframes) continue
    const m = /^ {2}@media (.+) \{$/.exec(line)
    if (m) media = m[1]!
    else if (/^ {2}\}$/.test(line)) media = ''
    const r = /^ {2,4}([^@].*?) \{ (.*) \}$/.exec(line)
    if (!r) continue
    const decls = r[2]!
      .split(/;\s*(?![^(]*\))/)
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()] as [string, string])
    rules.push({ media, selectors: splitTop(r[1]!), decls })
  }
  return rules
}

/** Split a selector list at its top-level commas. */
function splitTop(list: string) {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      out.push(list.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(list.slice(start).trim())
  return out
}

/** Does a width media condition hold at this viewport width? */
function holds(media: string, width: number) {
  if (!media) return true
  return media.split(',').some((alt) =>
    [...alt.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, k, v]) => (k === 'min' ? width >= +v! : width <= +v!)),
  )
}

// Interaction states (and full screen) are treated as holding, so a hover or focus rule cannot change a height either;
// :dir() is the nearest dir attribute (the demo sets it on <html>). Pseudo-elements style a control's
// insides, which a fixed border box contains.
// A state becomes a condition that always holds (removing it could leave an empty :is() argument).
const STATES = /:(hover|focus-visible|focus-within|focus|active|placeholder-shown|user-invalid|fullscreen)(?![-\w])/g
const normalize = (sel: string) => sel.replace(STATES, ':not([data-test-never])').replace(/:dir\((rtl|ltr)\)/g, ':is([dir=$1] *, [dir=$1])')

const HEIGHT = new Set(['height', 'block-size', 'min-height', 'min-block-size', 'max-height', 'max-block-size'])

describe('single-line controls share one box', () => {
  const store = loadStore('n3')
  const css = compileStyles(store)
  const rules = parseRules(css)
  const themes = store
    .match(null, store.factory.namedNode(RDF_TYPE), store.factory.namedNode(NS.sty + 'Theme'))
    .map((q) => store.match(q.subject, store.factory.namedNode(SEM.slug), null)[0]!.object.value)
    .sort()

  it('the token and the shared rule are there', () => {
    expect(css).toMatch(/--sem-control-height: 38px/)
    expect(themes).toEqual(expect.arrayContaining(['semblance', 'paper', 'terminal', 'blueprint', 'sunset', 'cupertino', 'tracker', 'classic', 'doodle', 'fluent']))
  })

  it('every rule that reaches a control of the form from a shape gives it the shared block size, in every theme, scheme, width and direction', () => {
    const h = mountSite('oxigraph', 'sparql')
    const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
    const click = (el: Element) => {
      h.fire(el, 'click')
      h.shell.flush()
    }
    click([...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Examples' && visible(b))!)
    click([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === 'A form from a shape' && visible(b))!)
    const form = h.shell.nodeOf(UI + 'ex-shapes-form/~root') as HTMLElement
    const controls = [...form.querySelectorAll('[data-sem-c=shape-field] :is(input:not([type=checkbox]), select)')] as HTMLElement[]
    // text, email, date, select, number: every single-line kind the form derives
    expect(controls.map((c) => c.localName + ':' + (c.getAttribute('type') ?? ''))).toEqual(['input:text', 'input:text', 'input:date', 'select:', 'input:number'])

    const html = h.document.documentElement
    const themed = form.closest('[data-sem-theme]') as HTMLElement
    expect(themed).toBeTruthy()
    const problems = new Set<string>()
    let checked = 0
    for (const theme of themes)
      for (const scheme of ['light', 'dark'])
        for (const width of [375, 1280])
          for (const dir of ['ltr', 'rtl']) {
            themed.setAttribute('data-sem-theme', theme)
            themed.setAttribute('data-sem-color-scheme', scheme)
            html.setAttribute('dir', dir)
            for (const control of controls) {
              const where = `${theme}/${scheme}/${width}px/${dir} ${control.localName}[type=${control.getAttribute('type') ?? ''}]`
              let box = 0
              for (const rule of rules) {
                if (!holds(rule.media, width)) continue
                const sels = rule.selectors.filter((s) => !s.includes('::'))
                const matches = sels.some((s) => {
                  try {
                    return control.matches(normalize(s))
                  } catch {
                    // a selector the test's engine cannot read must not size a control
                    if (rule.decls.some(([p]) => HEIGHT.has(p) || p === 'box-sizing')) problems.add(`unreadable selector sizes controls: ${s}`)
                    return false
                  }
                })
                if (!matches) continue
                checked++
                for (const [p, v] of rule.decls) {
                  const at = `${where}: ${p}: ${v} from ${rule.selectors.join(', ').slice(0, 140)}`
                  if (p === 'height' || p === 'block-size') {
                    if (v === BOX) box++
                    else problems.add(at)
                  } else if (HEIGHT.has(p) && !['0', 'none', 'auto'].includes(v)) problems.add(at)
                  else if (p === 'box-sizing' && v !== 'border-box') problems.add(at)
                  else if (control.localName === 'select' && p === 'appearance' && v !== 'none') problems.add(at)
                  // the shorthand would wipe the chevron (background-image) of a select
                  else if (control.localName === 'select' && p === 'background') problems.add(at)
                }
              }
              if (!box) problems.add(`${where}: no shared block size`)
            }
          }
    expect([...problems]).toEqual([])
    expect(checked).toBeGreaterThan(themes.length * 8 * controls.length)
  })
})
