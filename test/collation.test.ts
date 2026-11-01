import { describe, expect, it } from 'vitest'
import type { Rule } from '../src/engine/rules.ts'
import { MOD, NS } from '../src/ns.ts'
import { toHTML } from '../src/render/serialize.ts'
import { mountShell } from './harness.ts'
import { setup, SCREEN_LAYERS } from './helpers.ts'

// Lists in the viewer's collation (#7): on Semblance's engines the SPARQL rules place their rows
// by an order key from sx:sortKey (case folded, accents stripped), as the function twins do, and
// render byte for byte the same in every language, after every step.
const X = 'https://example.org/collation#'
const KEY = 'https://semblance.dev/ns/keyboard#'
const graph = `
  @prefix c: <${NS.c}> . @prefix x: <${X}> . @prefix key: <${KEY}> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix sem: <https://semblance.dev/ns/core#> .
  x:list a c:ShortcutList .
  x:save a c:Button ; c:label "Save" , "Зберегти"@uk , "Speichern"@de , "حفظ"@ar ; key:shortcut "Mod+S" .
  x:open a c:Button ; c:label "Open" , "Відкрити"@uk , "Öffnen"@de , "فتح"@ar ; key:shortcut "mod + o" .
  x:undo a c:Button ; c:label "Undo" , "Скасувати"@uk , "Rückgängig"@de , "تراجع"@ar ; key:shortcut "Shift+Mod+z" .
  x:edit a c:Button ; c:label "édit" ; key:shortcut "Alt+e" .
  x:help a c:Button ; key:shortcut "F1" .
  x:coffee x:origin "Ethiopia" ; x:weight 1234.5 ; x:notes "Jasmine" , "Bergamot" , "Lemon"@en ; x:roaster x:acme .
  x:acme rdfs:label "Acme" , "Акме"@uk .
  x:origin rdfs:label "Origin" , "Походження"@uk . x:weight rdfs:label "Weight" ; c:unit "g" . x:notes rdfs:label "Notes" .
  x:fields a c:DescriptionList ; c:of x:coffee ; c:fields ( x:origin x:weight x:missing x:notes x:roaster ) .
  x:items a c:DescriptionList ; c:items ( x:i1 x:i2 x:i3 ) .
  x:i1 c:label "Status" , "Стан"@uk ; c:value "open" .
  x:i2 c:label "Body" ; c:content x:body .
  x:i3 c:label "Summary" ; c:value 42 ; c:content x:body2 .
  x:body a c:Text ; c:label "A body." . x:body2 a c:Text ; c:label "Another body." .
  x:exchange x:header x:h1 , x:h2 , x:h3 , x:h4 .
  x:h1 x:name "Content-Type" ; x:value "text/html" ; sem:order 2 .
  x:h2 x:name "Accept" ; x:value "*/*" ; sem:order 1 .
  x:h3 x:name "éTag" ; x:value "abc" .
  x:h4 x:name "date" ; x:value "today" .
  x:entries a c:DescriptionList ; c:of x:exchange ; c:entryProperty x:header ; c:keyProperty x:name ; c:valueProperty x:value .
  x:nothing a c:DescriptionList ; c:of x:coffee ; c:fields ( x:missing ) ; c:emptyText "Nothing here." , "Тут нічого."@uk .
`
const parts = ['list', 'fields', 'items', 'entries', 'nothing']
const LANGUAGES = [[], ['en'], ['de'], ['uk'], ['ar']]
const SLOTS = ['ShortcutListRendering', 'ShapeReportRendering', 'DescriptionPairs']

function mount(prefer: 'sparql' | 'function', languages: string[]) {
  const { store, runtime, screen } = setup('wat', { modality: MOD.Screen, layers: SCREEN_LAYERS, prefer, languages }, 1, [graph])
  const text = runtime.project({ modality: MOD.Text, prefer, languages, name: 'text' })
  const html = () => parts.map((p) => toHTML(screen.index, X + p) + '\n' + toHTML(text.index, X + p))
  return { store, runtime, screen, text, html }
}

describe('lists in the viewer collation, SPARQL (sx:sortKey) and function rules alike', () => {
  it('chooses the SPARQL rules on wat', () => {
    const { screen } = mount('sparql', ['de'])
    const rules = (screen.engine as unknown as { rules: Rule[] }).rules
    for (const slot of SLOTS) expect(rules.find((r) => r.slot === NS.c + slot)?.kind, slot).toBe('sparql')
  })

  for (const languages of LANGUAGES) {
    it(`renders the same (${languages.join(', ') || 'no preference'})`, () => {
      const [a, b] = (['sparql', 'function'] as const).map((prefer) => mount(prefer, languages).html())
      expect(a).toEqual(b)
    })
  }

  it('lists shortcuts in collation order, accents and case folded', () => {
    const [screen] = mount('sparql', ['en']).html()
    const order = ['édit', 'help', 'Open', 'Save', 'Undo'].map((label) => screen!.indexOf(`<dt>${label}</dt>`))
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true)
    expect(screen).toContain('<kbd class="sem-apple">⌘⇧Z</kbd><kbd class="sem-other">Ctrl+Shift+Z</kbd>')
  })

  it('describes fields, items and entries', () => {
    const [, fields, items, entries, nothing] = mount('sparql', ['en']).html()
    expect(fields).toContain('<dt>Weight</dt><dd>1,234.5 g</dd>')
    expect(fields).not.toContain('missing')
    expect(fields!.match(/<dt>Notes<\/dt><dd>([^<]*)<\/dd>/)![1]!.split(', ').sort()).toEqual(['Bergamot', 'Jasmine', 'Lemon'])
    expect(fields).toContain('<dt>roaster</dt><dd>Acme</dd>')
    expect(items).toContain('<dt>Status</dt><dd>open</dd>')
    expect(items).toContain('A body.')
    expect(items).toContain('Summary  42')
    expect(entries!.indexOf('Accept')).toBeLessThan(entries!.indexOf('Content-Type'))
    expect(entries!.indexOf('Content-Type')).toBeLessThan(entries!.indexOf('date'))
    expect(entries!.indexOf('date')).toBeLessThan(entries!.indexOf('éTag'))
    expect(nothing).toContain('Nothing here.')
  })

  it('stays the same as shortcuts and labels change anywhere in the graph', () => {
    const mounts = (['sparql', 'function'] as const).map((prefer) => mount(prefer, ['uk']))
    const step = (change: (m: (typeof mounts)[number]) => void) => {
      for (const m of mounts) change(m)
      expect(mounts[0]!.html()).toEqual(mounts[1]!.html())
    }
    step((m) => {
      const f = m.store.factory
      m.runtime.apply({ remove: [], add: [f.quad(f.namedNode(X + 'find'), f.namedNode(KEY + 'shortcut'), f.literal('Mod+F')), f.quad(f.namedNode(X + 'find'), f.namedNode(NS.c + 'label'), f.literal('Знайти'))] })
    })
    expect(mounts[0]!.html()[0]).toContain('Знайти')
    step((m) => {
      const f = m.store.factory
      m.runtime.apply({ remove: m.store.match(f.namedNode(X + 'open'), f.namedNode(KEY + 'shortcut'), null), add: [] })
    })
    expect(mounts[0]!.html()[0]).not.toContain('Відкрити')
    step((m) => {
      const f = m.store.factory
      const coffee = f.namedNode(X + 'coffee')
      m.runtime.apply({ remove: m.store.match(coffee, f.namedNode(X + 'weight'), null), add: [f.quad(coffee, f.namedNode(X + 'weight'), f.literal('250')), f.quad(coffee, f.namedNode(X + 'notes'), f.literal('Cocoa'))] })
    })
    expect(mounts[0]!.html()[1]).toContain('Cocoa')
    step((m) => {
      m.screen.engine.reconfigure({ languages: ['de'] })
      m.text.engine.reconfigure({ languages: ['de'] })
    })
  })
})

describe('the Layers gallery group (shortcuts, shape results), on wat', () => {
  const UI = 'https://semblance.dev/demo#'
  it('renders the same with SPARQL and with function rules, as a result goes away and the language changes', { timeout: 300_000 }, () => {
    const shells = (['sparql', 'function'] as const).map((prefer) => {
      const h = mountShell(5, 'wat', prefer)
      const f = h.store.factory
      const app = f.namedNode(UI + 'app')
      const group = f.namedNode(UI + 'galleryGroup')
      h.showPage('Components')
      h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupLayers'))] })
      h.shell.flush()
      return h
    })
    const html = (id: string) => shells.map((h) => (h.shell.nodeOf(`${UI}${id}/~root`) as Element).outerHTML)
    const same = () => {
      for (const id of ['shapeReport', 'shortcuts']) {
        const [a, b] = html(id)
        expect(a, id).toBe(b)
      }
    }
    same()
    expect(html('shapeReport')[0]!.match(/<li/g)).toHaveLength(3)
    for (const h of shells) {
      const f = h.store.factory
      h.runtime.apply({ remove: h.store.match(f.namedNode(UI + 'badBadge'), f.namedNode('https://semblance.dev/ns/style#tone'), null), add: [] })
      h.shell.flush()
    }
    same()
    expect(html('shapeReport')[0]!.match(/<li/g)).toHaveLength(2)
    for (const h of shells) h.screen.engine.reconfigure({ languages: ['uk'] }), h.shell.flush()
    same()
  })
})

describe('a specimen ontology section (the docs layer), on wat', () => {
  const UI = 'https://semblance.dev/demo#'
  it('renders the same with SPARQL and with function rules, closed, opened and in another language', { timeout: 300_000 }, () => {
    const shells = (['sparql', 'function'] as const).map((prefer) => {
      const h = mountShell(5, 'wat', prefer)
      const f = h.store.factory
      const app = f.namedNode(UI + 'app')
      const group = f.namedNode(UI + 'galleryGroup')
      h.showPage('Components')
      h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupFeedback'))] })
      h.shell.flush()
      return h
    })
    const spec = (h: (typeof shells)[number]) => h.shell.nodeOf(`${UI}fb-alerts-spec/~root`) as Element
    const same = () => {
      const [a, b] = shells.map((h) => h.document.getElementById('app')!.innerHTML)
      if (a !== b) {
        let i = 0
        while (i < a!.length && a![i] === b![i]) i++
        expect(a!.slice(Math.max(0, i - 300), i + 300)).toBe(b!.slice(Math.max(0, i - 300), i + 300))
      }
    }
    const rules = (shells[0]!.screen.engine as unknown as { rules: Rule[] }).rules
    expect(rules.find((r) => r.slot === NS.sem + 'SpecimenOntology')?.kind).toBe('sparql')
    same()
    expect(spec(shells[0]!).querySelector('.sem-docs-toggle')!.textContent).toContain('c:Alert')
    for (const h of shells) h.fire(spec(h).querySelector('.sem-docs-toggle')!, 'click'), h.shell.flush()
    same()
    expect(spec(shells[0]!).querySelector('[data-sem-c=class-doc]')).not.toBeNull()
    for (const h of shells) h.screen.engine.reconfigure({ languages: ['de'] }), h.shell.flush()
    same()
  })
})

// A tree (#7): its items are minted per open node, keyed by the path to them, and placed by an
// order key from sx:sortKey; the SPARQL rules hear children come and go through the tree's parent
// property, a property in the data (sem:inverseVia).
describe('a tree in the viewer collation, SPARQL and function rules alike', () => {
  const T = 'https://example.org/tree#'
  const trees = `
    @prefix c: <${NS.c}> . @prefix t: <${T}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix sem: <https://semblance.dev/ns/core#> . @prefix dnd: <https://semblance.dev/ns/dragdrop#> .
    t:root rdfs:label "Root" , "Корінь"@uk .
    t:b t:up t:root ; rdfs:label "beta" ; t:code "b" , "a" . t:a t:up t:root ; rdfs:label "Alpha" , "Альфа"@uk ; t:code 1234.5 .
    t:e t:up t:root ; rdfs:label "Éclair" . t:a1 t:up t:a , t:b ; rdfs:label "Leaf" .
    t:loop t:up t:a ; rdfs:label "Loop" . t:a t:up t:loop .
    t:select t:picked t:a1 .
    t:tree a c:Tree ; c:label "Things" , "Речі"@uk ; c:of t:root ; c:parentProperty t:up ; c:detailProperty t:code ;
      c:expandedNode t:root , t:a , t:b , t:loop ; c:controls t:select ; c:property t:picked .
    t:drops a c:Tree , dnd:DropTarget ; c:of t:root ; c:parentProperty t:up ; c:expandedNode t:root .
    t:nothing a c:Tree ; c:of t:root .
  `
  const ids = ['tree', 'drops', 'nothing']
  const mountTree = (prefer: 'sparql' | 'function', languages: string[]) => {
    const { store, runtime, screen } = setup('wat', { modality: MOD.Screen, layers: SCREEN_LAYERS, prefer, languages }, 1, [trees])
    const text = runtime.project({ modality: MOD.Text, prefer, languages, name: 'text' })
    const html = () => ids.map((p) => toHTML(screen.index, T + p) + '\n' + toHTML(text.index, T + p))
    return { store, runtime, screen, text, html }
  }

  it('chooses the SPARQL rules on wat', () => {
    const { screen } = mountTree('sparql', ['en'])
    const rules = (screen.engine as unknown as { rules: Rule[] }).rules
    for (const slot of ['TreeRendering', 'TreeItemRendering']) expect(rules.find((r) => r.slot === NS.c + slot)?.kind, slot).toBe('sparql')
  })

  for (const languages of LANGUAGES) {
    it(`renders the same (${languages.join(', ') || 'no preference'})`, () => {
      const [a, b] = (['sparql', 'function'] as const).map((prefer) => mountTree(prefer, languages).html())
      expect(a).toEqual(b)
    })
  }

  it('sorts siblings, keys items by path and stops at a cycle', () => {
    const [tree, drops] = mountTree('sparql', ['en']).html()
    const labels = [...tree!.matchAll(/class="sem-label"(?: type="button")?>([^<]*)</g)].map((m) => m[1])
    // Leaf under Alpha and under beta; Loop under Alpha, Alpha again under Loop (a leaf: on its own path).
    expect(labels).toEqual(['Root', 'Alpha', 'Leaf', 'Loop', 'Alpha', 'beta', 'Leaf', 'Éclair'])
    expect(tree).toContain('<code class="sem-detail">1,234.5</code>')
    expect(tree).toContain('<code class="sem-detail">a</code>')
    expect(tree).toContain('aria-selected="true"')
    expect(tree).toContain('▾ Root')
    expect(tree).toContain('      Leaf  ◂')
    expect(drops).toContain('data-sem-drop-zone')
  })

  it('stays the same as children come and go, nodes open, labels and the selection change', () => {
    const mounts = (['sparql', 'function'] as const).map((prefer) => mountTree(prefer, ['en']))
    const step = (change: (m: (typeof mounts)[number]) => void) => {
      for (const m of mounts) change(m)
      expect(mounts[0]!.html()).toEqual(mounts[1]!.html())
    }
    const n = (m: (typeof mounts)[number], local: string) => m.store.factory.namedNode(T + local)
    const add = (s: string, p: string, o: string) => (m: (typeof mounts)[number]) => m.runtime.apply({ remove: [], add: [m.store.factory.quad(n(m, s), n(m, p), n(m, o))] })
    step(add('c', 'up', 'root'))
    expect(mounts[0]!.html()[0]).toContain('>c<')
    step((m) => m.runtime.apply({ remove: m.store.match(n(m, 'a1'), n(m, 'up'), n(m, 'b')), add: [] }))
    step(add('e1', 'up', 'e'))
    step((m) => {
      const f = m.store.factory
      m.runtime.apply({ remove: [], add: [f.quad(n(m, 'tree'), f.namedNode(NS.c + 'expandedNode'), n(m, 'e'))] })
    })
    expect(mounts[0]!.html()[0]).toContain('>e1<')
    step((m) => {
      const f = m.store.factory
      m.runtime.apply({ remove: m.store.match(n(m, 'b'), f.namedNode('http://www.w3.org/2000/01/rdf-schema#label'), null), add: [f.quad(n(m, 'b'), f.namedNode('http://www.w3.org/2000/01/rdf-schema#label'), f.literal('Zeta'))] })
    })
    step((m) => m.runtime.apply({ remove: m.store.match(n(m, 'select'), n(m, 'picked'), null), add: [m.store.factory.quad(n(m, 'select'), n(m, 'picked'), n(m, 'e'))] }))
    step((m) => {
      m.screen.engine.reconfigure({ languages: ['uk'] })
      m.text.engine.reconfigure({ languages: ['uk'] })
    })
    expect(mounts[0]!.html()[0]).toContain('Альфа')
  })
})
