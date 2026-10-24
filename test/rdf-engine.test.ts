// The rdf-engine builds (rdf-engine/, `npm run engine:build`) as Semblance stores.
// They have no SPARQL yet, so they run function rules and are held to N3.js,
// the other store without SPARQL: same quads loaded, same HTML rendered.
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EX } from '../src/examples/todo.ts'
import { loadStore } from '../src/node/load.ts'
import { quadKey } from '../src/rdf.ts'
import { toHTML } from '../src/render/serialize.ts'
import { mountShell } from './harness.ts'
import { setup } from './helpers.ts'

const built = (['rust', 'wat'] as const).filter((k) => existsSync(new URL(`../rdf-engine/build/${k}.wasm`, import.meta.url)))
const page = EX + 'page'

describe.skipIf(!built.length).each(built)('%s engine store', (kind) => {
  it('loads the ontology to the same quads as N3.js', () => {
    const keys = (k: typeof kind | 'n3') => {
      const quads = loadStore(k).match(null, null, null, null)
      const ground = quads.filter((q) => q.subject.termType !== 'BlankNode' && q.object.termType !== 'BlankNode')
      return { count: quads.length, ground: ground.map(quadKey).sort() }
    }
    const [engine, n3] = [keys(kind), keys('n3')]
    expect(engine.count).toBe(n3.count)
    expect(engine.ground).toEqual(n3.ground)
  })

  it('renders the todo page like N3.js', () => {
    const html = (k: typeof kind | 'n3') => toHTML(setup(k, { prefer: 'function' }).screen.index, page)
    expect(html(kind)).toBe(html('n3'))
  })

  it('renders every page of the shell like N3.js, and follows the same interactions', () => {
    const shells = [mountShell(5, kind, 'function'), mountShell(5, 'n3', 'function')]
    const html = () => shells.map((h) => h.document.getElementById('app')!.innerHTML)
    for (const page of ['Playground', 'Performance', 'Components'] as const) {
      for (const h of shells) h.showPage(page)
      const [a, b] = html()
      expect(a, page).toBe(b)
    }
  })
})
