// Shared checks that renderings have both implementations and that they agree.
import { readFileSync } from 'node:fs'
import { Parser, Store } from 'n3'
import { expect } from 'vitest'
import { mountShell } from './harness.ts'

const SEM = 'https://semblance.dev/ns/core#'
const UI = 'https://semblance.dev/demo#'

/**
 * The renderings declared in the given ontology files (relative to ontology/)
 * that lack a SPARQL rule (and are not sem:functionOnly) or lack a function rule.
 */
export function implementationGaps(files: string[]): { noSparql: string[]; noFunction: string[] } {
  const store = new Store()
  for (const file of files) store.addQuads(new Parser().parse(readFileSync(new URL(`../ontology/${file}`, import.meta.url), 'utf8')))
  const noSparql: string[] = []
  const noFunction: string[] = []
  for (const q of store.getQuads(null, SEM + 'targets', null, null)) {
    const rendering = q.subject
    const rules = store.getQuads(null, SEM + 'implements', rendering, null).map((r) => r.subject)
    const has = (p: string) => rules.some((r) => store.getQuads(r, SEM + p, null, null).length > 0)
    const name = rendering.value.replace(/^.*[#/]/, '')
    if (!has('construct') && !store.getQuads(rendering, SEM + 'functionOnly', null, null).length) noSparql.push(name)
    if (!has('function')) noFunction.push(name)
  }
  return { noSparql: noSparql.sort(), noFunction: noFunction.sort() }
}

/**
 * Render the demo with SPARQL rules preferred and with function rules preferred,
 * show each page / gallery group, and require identical HTML.
 */
export function expectSameRendering(groups: string[], pages: ('Playground' | 'Performance' | 'Components')[] = []) {
  const shells = (['sparql', 'function'] as const).map((prefer) => mountShell(5, 'oxigraph', prefer))
  const html = () => shells.map((h) => h.document.getElementById('app')!.innerHTML)
  for (const page of pages) {
    for (const h of shells) h.showPage(page)
    const [a, b] = html()
    expect(a, `page ${page}: SPARQL and function renderings differ`).toBe(b)
  }
  for (const group of groups) {
    for (const h of shells) {
      const f = h.store.factory
      const app = f.namedNode(UI + 'app')
      const p = f.namedNode(UI + 'galleryGroup')
      h.showPage('Components')
      h.runtime.apply({ remove: h.store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + group))] })
      h.shell.flush()
    }
    const [a, b] = html()
    if (a !== b) {
      // Point at the first difference, not two megabytes of HTML.
      let i = 0
      while (i < a!.length && a![i] === b![i]) i++
      expect(a!.slice(Math.max(0, i - 300), i + 300), `group ${group}: SPARQL and function renderings differ`).toBe(b!.slice(Math.max(0, i - 300), i + 300))
    }
  }
}
