import { describe, expect, it } from 'vitest'
import { EX, todoApp } from '../src/examples/todo.ts'
import { createStore, loadStore, type StoreKind } from '../src/node/load.ts'
import { A11Y, C, MOD, NS, SEM, STY } from '../src/ns.ts'
import type { Delta } from '../src/rdf.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { ALL_LAYERS, inputQuads, SCREEN_LAYERS, setup, todo } from './helpers.ts'

const page = EX + 'page'

/** Rebuild the same input in a fresh store and project it from scratch. */
/** A projection of exactly `input` (ontology included), from scratch, in a store of its own. */
function fresh(kind: StoreKind, input: ReturnType<typeof inputQuads>, opts: Parameters<Runtime['project']>[0]) {
  const store = createStore(kind)
  for (const q of input) store.add(store.factory.quad(q.subject, q.predicate, q.object))
  return Object.assign(
    new Runtime(store).project(opts, (e) => {
      throw e
    }),
    { dispose: () => store.dispose?.() },
  )
}

describe('implementations', () => {
  const reference = (() => {
    const { screen } = setup('oxigraph', { prefer: 'sparql' })
    return toHTML(screen.index, page)
  })()

  it('renders the expected structure', () => {
    expect(reference).toContain('<ul aria-label="Todos" data-sem-c="list">')
    expect(reference).toContain('<h1 data-sem-c="heading">Todos</h1>')
    expect(reference).toContain('<button data-sem-c="button" data-sem-intent="primary" type="button">Add</button>')
    expect(reference).toContain(`<label for="${EX}newTodo/~input">New todo</label>`)
    // ex:priority is 0, 9, 8, 7, 6 for t1..t5
    const order = [...reference.matchAll(/<label for="[^"]+~check">([^<]+)</g)].map((m) => m[1])
    expect(order).toEqual([
      'Write the core ontology',
      'Draw the provenance overlay',
      'Wire up behaviour',
      'Benchmark the stores',
      'Sketch the style layer',
    ])
  })

  it.each([
    ['oxigraph', 'function'],
    ['hybrid', 'sparql'],
    ['hybrid', 'function'],
    ['n3', 'function'],
    ['wat', 'sparql'],
    ['wat', 'function'],
    ['rust', 'sparql'],
    ['rust', 'function'],
  ] as const)('%s + %s renders the same HTML as oxigraph + sparql', (kind, prefer) => {
    const { screen } = setup(kind, { prefer })
    expect(toHTML(screen.index, page)).toBe(reference)
  })

  it('bulk and per-focus SPARQL evaluation agree', () => {
    const bulk = setup('oxigraph', { prefer: 'sparql', bulkThreshold: 1 }, 40)
    const single = setup('oxigraph', { prefer: 'sparql', bulkThreshold: Infinity }, 40)
    expect(bulk.screen.engine.stats.bulkQueries).toBeGreaterThan(0)
    expect(single.screen.engine.stats.bulkQueries).toBe(0)
    expect(toHTML(bulk.screen.index, page)).toBe(toHTML(single.screen.index, page))
  })

  it('projects the same graph onto the text modality', () => {
    const { runtime } = setup('oxigraph')
    const text = runtime.project({ modality: MOD.Text, name: 'text' })
    expect(toText(text.index, page)).toBe(
      [
        '# TODOS',
        'New todo: [_]',
        '  Lower priority numbers sort first.',
        '[ Add ] [ Toggle density ]',
        '  [x] Write the core ontology',
        '  [ ] Draw the provenance overlay',
        '  [x] Wire up behaviour',
        '  [ ] Benchmark the stores',
        '  [ ] Sketch the style layer',
      ].join('\n'),
    )
  })
})

describe('incremental updates', () => {
  const steps = (t: ReturnType<typeof todo>): [string, Delta][] => [
    ['toggle an item', t.set('t2', 'done', true)],
    ['rename an item', t.set('t3', NS.rdfs + 'label', 'Renamed')],
    ['reorder an item', t.set('t5', 'priority', -10)],
    ['add an item', t.addItem('t99', 'Brand new', 3)],
    ['remove an item', t.removeItem('t1')],
    ['type into the field', t.set('newTodo', C.value, 'hello')],
    ['show a validation error', t.set('newTodo', C.error, 'Required')],
    ['clear the error', t.set('newTodo', C.error, undefined)],
    ['change density', t.set('page', STY.density, undefined)],
    ['relabel the list', t.set('todos', C.label, 'Things')],
    ['change the sort key', { remove: t.set('todos', C.sortBy, undefined).remove, add: [] }],
    ['remove a component from its stack', t.set('actions', C.children, undefined)],
  ]

  // Exact dependencies (docs/IVM.md, phase 3): SPARQL rules re-run from their own patterns, what they
  // declare (sem:follows, sem:watches, sem:readsMinted) ignored - and still match a from-scratch run.
  for (const [kind, prefer, exact] of [
    ['oxigraph', 'sparql', false],
    ['n3', 'function', false],
    ['wat', 'sparql', false],
    ['rust', 'sparql', false],
    ['wat', 'sparql', true],
  ] as const) {
    it(`matches a from-scratch projection after every step (${kind} + ${prefer}${exact ? ', exact dependencies' : ''})`, () => {
      const opts = { modality: MOD.Screen, layers: ALL_LAYERS, prefer, provenance: kind !== 'n3', exactDependencies: exact }
      const layers = kind === 'n3' ? SCREEN_LAYERS : ALL_LAYERS
      const { store, runtime, screen } = setup(kind, { ...opts, layers })
      const text = runtime.project({ modality: MOD.Text, prefer, name: 'text', exactDependencies: exact })
      for (const [name, delta] of steps(todo(store))) {
        runtime.apply(delta)
        const expected = fresh(kind, inputQuads(store), { ...opts, layers })
        const expectedText = fresh(kind, inputQuads(store), { modality: MOD.Text, prefer, name: 'text' })
        expect(toHTML(screen.index, page), name).toBe(toHTML(expected.index, page))
        expect(toText(text.index, page), name).toBe(toText(expectedText.index, page))
        expected.dispose()
        expectedText.dispose()
      }
    }, 120_000)
  }

  it('re-renders only what changed', () => {
    const { store, runtime, screen } = setup('oxigraph', { prefer: 'sparql' }, 200)
    const t = todo(store)
    const before = { ...screen.engine.stats }
    // Data-item changes reach only the item's rendering (it follows c:of); the
    // item instance itself is unchanged, so its style hooks do not re-run.
    runtime.apply(t.set('t7', 'done', true))
    expect(screen.engine.stats.ruleRuns - before.ruleRuns).toBe(1)
    const mid = { ...screen.engine.stats }
    // A label change re-runs the item's rendering and its member-wise list evaluation, which
    // reads the label (c:itemLabel) for a sortable list's drag name (sem:memberWatchesVia).
    runtime.apply(t.set('t7', NS.rdfs + 'label', 'x'))
    expect(screen.engine.stats.ruleRuns - mid.ruleRuns).toBe(2)
    // A sort-key change re-places that one item (its member-wise list evaluation
    // reads the key) and, since the SPARQL item rule watches everything on its
    // data item, re-runs that item too, with no change in its output.
    const reorder = { ...screen.engine.stats }
    const added = screen.engine.stats.derivedAdded
    runtime.apply(t.set('t7', 'priority', 1000))
    expect(screen.engine.stats.ruleRuns - reorder.ruleRuns).toBe(2)
    expect(screen.engine.stats.derivedAdded - added).toBeLessThanOrEqual(2)
  })

  it('re-renders only what changed, exactly: a sort-key change re-runs nothing that does not read it', () => {
    const { store, runtime, screen } = setup('oxigraph', { prefer: 'sparql', exactDependencies: true }, 200)
    const t = todo(store)
    const ran = (change: Delta) => {
      const before = screen.engine.stats.ruleRuns
      runtime.apply(change)
      return screen.engine.stats.ruleRuns - before
    }
    // The item's rendering for done; for a label, it, the member-wise list, and the viewer's terms
    // (l10n:Terms reads every labelled node, to pick a label by language: what it declares misses that).
    expect(ran(t.set('t7', 'done', true))).toBe(1)
    expect(ran(t.set('t7', NS.rdfs + 'label', 'x'))).toBe(3)
    // The item's rendering never reads ex:priority (its patterns say so): only the list, which places the item by it.
    expect(ran(t.set('t7', 'priority', 1000))).toBe(1)
  })
})

describe('reconfiguration and layers', () => {
  it('toggles the debug layer and provenance attributes', () => {
    const { screen } = setup('oxigraph', { provenance: true })
    expect(toHTML(screen.index, page)).not.toContain('data-sem-rule')
    screen.engine.reconfigure({ layers: new Set(ALL_LAYERS) })
    expect(toHTML(screen.index, page)).toContain(`data-sem-rule="${NS.c}ButtonOnScreen-sparql"`)
    screen.engine.reconfigure({ layers: new Set(SCREEN_LAYERS) })
    expect(toHTML(screen.index, page)).not.toContain('data-sem-rule')
  })

  it('toggles layers incrementally with the same result as projecting from scratch', () => {
    const extra = (layers: string[]) => fresh('oxigraph', inputQuads(store), { modality: MOD.Screen, layers, provenance: true })
    const { store, screen } = setup('oxigraph', { provenance: true, layers: ALL_LAYERS })
    for (const layers of [SCREEN_LAYERS, [STY.Layer], [], ALL_LAYERS, [A11Y.Layer, SEM.DebugLayer]]) {
      screen.engine.reconfigure({ layers: new Set(layers) })
      expect(toHTML(screen.index, page), layers.join(' ')).toBe(toHTML(extra(layers).index, page))
    }
  })

  it('switches modality in place', () => {
    const { screen } = setup('oxigraph')
    screen.engine.reconfigure({ modality: MOD.Text })
    expect(toText(screen.index, page).split('\n')[1]).toBe('New todo: [_]')
    expect(toHTML(screen.index, page)).not.toContain('<button')
    screen.engine.reconfigure({ modality: MOD.Screen })
    expect(toHTML(screen.index, page)).toContain('<button')
  })

  it('records PROV-O provenance for every derived node', () => {
    const { store, screen } = setup('oxigraph', { provenance: true })
    const f = store.factory
    const one = (s: string, p: string) => store.match(f.namedNode(s), f.namedNode(p), null, screen.engine.graph).map((q) => q.object.value)
    const item = `${EX}todos/~i-${encodeURIComponent(EX + 't2')}`
    // The label element was generated by the item rule's activity (text nodes are covered by it)...
    expect(one(item + '/~label-text', NS.prov + 'wasGeneratedBy')).toEqual([])
    const [activity] = one(item + '/~label', NS.prov + 'wasGeneratedBy')
    expect(activity).toBe(item + '/~prov-ListItemOnScreen-sparql')
    const [association] = one(activity!, NS.prov + 'qualifiedAssociation')
    expect(one(association!, NS.prov + 'hadPlan')).toEqual([NS.c + 'ListItemOnScreen-sparql'])
    expect(one(activity!, NS.prov + 'wasAssociatedWith')).toEqual([screen.engine.agent.value])
    // ...which used the item instance and, through sem:follows c:of, the data item.
    expect(one(activity!, NS.prov + 'used').sort()).toEqual([EX + 't2', item].sort())
    // The item instance itself was generated by the list's evaluation for that item; its root was decorated by the style layer.
    expect(one(item, NS.prov + 'wasGeneratedBy')).toEqual([`${EX}todos/~prov-ListMembers-sparql-${encodeURIComponent(EX + 't2')}`])
    expect(one(item + '/~root', NS.prov + 'wasInfluencedBy')).toEqual([item + '/~prov-HookAttributes-sparql'])
  })

  it('explains where a node came from', () => {
    const { screen } = setup('oxigraph')
    expect(screen.engine.explain(EX + 'add/~label')).toEqual({ rule: NS.c + 'ButtonOnScreen-sparql', focus: EX + 'add' })
  })

  it('reference-counts triples asserted by more than one rule', () => {
    // A third-party layer that also asserts the input's type attribute.
    const extra = `
      @prefix sem: <${NS.sem}> . @prefix c: <${NS.c}> . @prefix mod: <${NS.mod}> .
      <urn:x:Dup> a sem:Rule ; sem:targets c:TextField ; sem:modality mod:Screen ; sem:stratum 5 ; sem:layer <urn:x:Layer> ;
        sem:construct """CONSTRUCT { ?i rdfhtml:type "text" } WHERE { $this a c:TextField . BIND(IRI(CONCAT(STR($this), "/~input")) AS ?i) }""" .`
    const { screen } = setup('oxigraph', { layers: [...SCREEN_LAYERS, 'urn:x:Layer'] }, 3, [extra])
    expect(toHTML(screen.index, page)).toContain('type="text"')
    screen.engine.reconfigure({ layers: new Set(SCREEN_LAYERS) })
    expect(toHTML(screen.index, page)).toContain('type="text"')
  })

  it('rejects rules that invalidate an earlier stratum', () => {
    const extra = `
      @prefix sem: <${NS.sem}> . @prefix c: <${NS.c}> .
      <urn:x:Bad> a sem:Rule ; sem:targets c:Button ; sem:stratum 50 ;
        sem:construct """CONSTRUCT { ?x a c:Button ; c:label "spawned" } WHERE { $this a c:Button . BIND(IRI(CONCAT(STR($this), "/~spawn")) AS ?x) }""" .`
    const store = loadStore('oxigraph', todoApp(1), extra)
    expect(() => new Runtime(store).project({ modality: MOD.Screen })).toThrow(/Stratification violation.*sem:inputOnly/)
  })

  it('sem:watches narrows changes through sem:follows too (#54; docs/COMPONENTS.md)', () => {
    const extra = `
      @prefix sem: <${NS.sem}> . @prefix ex: <urn:w:> .
      <urn:w:Rule> a sem:Rule ; sem:targets ex:Shown ; sem:stratum 1 ; sem:follows ex:of ; sem:watches ex:of , ex:note ;
        sem:construct """CONSTRUCT { $this <urn:w:seen> ?n } WHERE { $this <urn:w:of> ?d . ?d <urn:w:note> ?n }""" .
      ex:a a ex:Shown ; ex:of ex:d . ex:d ex:note "one" ; ex:other "x" .`
    const store = loadStore('oxigraph', todoApp(1), extra)
    const runtime = new Runtime(store)
    const screen = runtime.project({ modality: MOD.Screen })
    const f = store.factory
    const runs = () => screen.engine.stats.byRule.get('urn:w:Rule')?.runs ?? 0
    const seen = () => store.match(f.namedNode('urn:w:a'), f.namedNode('urn:w:seen'), null).map((q) => q.object.value)
    expect(seen()).toEqual(['one'])
    const before = runs()
    // A watched predicate of the followed node re-runs it...
    runtime.apply({ remove: store.match(f.namedNode('urn:w:d'), f.namedNode('urn:w:note'), null), add: [f.quad(f.namedNode('urn:w:d'), f.namedNode('urn:w:note'), f.literal('two'))] })
    expect(seen()).toEqual(['two'])
    expect(runs()).toBe(before + 1)
    // ...an unwatched one does not.
    runtime.apply({ remove: [], add: [f.quad(f.namedNode('urn:w:d'), f.namedNode('urn:w:other'), f.literal('y'))] })
    expect(runs()).toBe(before + 1)
  })

  it('a SPARQL rule without sem:watches watches the predicates its query names (#153)', () => {
    const extra = `
      @prefix sem: <${NS.sem}> . @prefix ex: <urn:w:> .
      <urn:w:Named> a sem:Rule ; sem:targets ex:Shown ; sem:stratum 1 ; sem:follows ex:of ;
        sem:construct """CONSTRUCT { $this <urn:w:seen> ?n } WHERE { $this <urn:w:of> ?d . ?d <urn:w:note> ?n }""" .
      <urn:w:Any> a sem:Rule ; sem:targets ex:Shown ; sem:stratum 1 ;
        sem:construct """CONSTRUCT { $this <urn:w:has> ?p } WHERE { $this ?p ?o FILTER(?p = <urn:w:own>) }""" .
      ex:a a ex:Shown ; ex:of ex:d ; ex:own "x" . ex:d ex:note "one" ; ex:other "x" .`
    const store = loadStore('oxigraph', todoApp(1), extra)
    const runtime = new Runtime(store)
    const screen = runtime.project({ modality: MOD.Screen })
    const f = store.factory
    const nn = (s: string) => f.namedNode('urn:w:' + s)
    const runs = (rule: string) => screen.engine.stats.byRule.get('urn:w:' + rule)?.runs ?? 0
    const seen = () => store.match(nn('a'), nn('seen'), null).map((q) => q.object.value)
    const set = (s: string, p: string, v: string) => runtime.apply({ remove: store.match(nn(s), nn(p), null), add: [f.quad(nn(s), nn(p), f.literal(v))] })
    expect(seen()).toEqual(['one'])
    const named = runs('Named')
    // A predicate the query names, on the followed node, re-runs it...
    set('d', 'note', 'two')
    expect(seen()).toEqual(['two'])
    expect(runs('Named')).toBe(named + 1)
    // ...others do not: on the followed node, or on the focus itself.
    set('d', 'other', 'y')
    const any = runs('Any')
    set('a', 'own', 'y')
    expect(runs('Named')).toBe(named + 1)
    // A rule whose query takes any predicate of its focus re-runs for any of them.
    expect(runs('Any')).toBe(any + 1)
  })

  it('refuses blank nodes in rule output', () => {
    const extra = `
      @prefix sem: <${NS.sem}> . @prefix c: <${NS.c}> .
      <urn:x:Blank> a sem:Rule ; sem:targets c:Button ; sem:stratum 1 ;
        sem:construct """CONSTRUCT { $this sem:note [ sem:x 1 ] } WHERE { $this a c:Button }""" .`
    const store = loadStore('oxigraph', todoApp(1), extra)
    expect(() => new Runtime(store).project({ modality: MOD.Screen })).toThrow(/blank node/)
  })

  it('treats the debug layer as optional', () => {
    const { screen } = setup('oxigraph', { layers: [SEM.DebugLayer] })
    expect(toHTML(screen.index, page)).not.toContain('data-sem-c')
  })
})

describe('bulk attributability', () => {
  it('evaluates per focus any SPARQL rule whose template writes about nodes not minted from the focus', async () => {
    const { attributable } = await import('../src/engine/rules.ts')
    expect(attributable('CONSTRUCT { ?root sem:renders $this . ?a ord:immediatelyPrecedes ?b } WHERE { BIND(IRI(CONCAT(STR($this), "/~root")) AS ?root) }')).toBe(false)
    expect(
      attributable(
        'CONSTRUCT { ?root sem:renders $this ; rdfhtml:hasChild ?icon . ?icon rdfhtml:data "a. b" } WHERE { BIND(IRI(CONCAT(STR($this), "/~root")) AS ?root) BIND(IF(BOUND(?x), IRI(CONCAT(STR(?root), "-icon")), ?none) AS ?icon) }',
      ),
    ).toBe(true)
  })
})
