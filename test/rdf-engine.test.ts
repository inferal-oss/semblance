// The rdf-engine builds (rdf-engine/, `npm run engine:build`) as Semblance stores.
// A build is held to the stores Semblance already has: the same quads loaded as
// N3.js, and the same HTML rendered as Oxigraph (with SPARQL rules, once the
// build runs SPARQL) or as N3.js (function rules, until then).
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EX } from '../src/examples/todo.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { quadKey } from '../src/rdf.ts'
import { toHTML } from '../src/render/serialize.ts'
import { mountShell } from './harness.ts'
import { setup } from './helpers.ts'

const built = (['rust', 'wat'] as const).filter((k) => existsSync(new URL(`../rdf-engine/build/${k}.wasm`, import.meta.url)))
const page = EX + 'page'

/** The first difference between two strings, with some context. */
function expectSame(a: string, b: string, label: string) {
  if (a === b) return
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  expect(a.slice(Math.max(0, i - 300), i + 300), label).toBe(b.slice(Math.max(0, i - 300), i + 300))
}

describe.skipIf(!built.length).each(built)('%s engine store', (kind) => {
  const sparql = built.length ? loadStore(kind).sparql : false
  // A store with the same abilities to compare against.
  const reference: StoreKind = sparql ? 'oxigraph' : 'n3'

  it('loads the ontology to the same quads as N3.js', () => {
    const keys = (k: StoreKind) => {
      const quads = loadStore(k).match(null, null, null, null)
      const ground = quads.filter((q) => q.subject.termType !== 'BlankNode' && q.object.termType !== 'BlankNode')
      return { count: quads.length, ground: ground.map(quadKey).sort() }
    }
    const [engine, n3] = [keys(kind), keys('n3')]
    expect(engine.count).toBe(n3.count)
    expect(engine.ground).toEqual(n3.ground)
  })

  for (const prefer of sparql ? (['function', 'sparql'] as const) : (['function'] as const)) {
    it(`renders the todo page like ${reference} (${prefer} rules)`, () => {
      const html = (k: StoreKind) => toHTML(setup(k, { prefer }).screen.index, page)
      expectSame(html(kind), html(reference), 'todo page')
    })

    it(`renders every page of the shell like ${reference} (${prefer} rules)`, () => {
      const shells = [mountShell(5, kind, prefer), mountShell(5, reference, prefer)]
      const html = () => shells.map((h) => h.document.getElementById('app')!.innerHTML)
      for (const p of ['Playground', 'Performance', 'Components'] as const) {
        for (const h of shells) h.showPage(p)
        const [a, b] = html()
        expectSame(a!, b!, p)
      }
    })
  }
})
