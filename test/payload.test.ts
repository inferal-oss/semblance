import { describe, expect, it } from 'vitest'
import { bytesLabel, looksLikeJson } from '../src/components/payload.ts'
import { MOD } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { mountShell } from './harness.ts'
import { expectSameRendering, implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const C = 'https://semblance.dev/ns/component#'

/** The demo shell on the Data gallery page, driven only through DOM events. */
function inspection(prefer: 'sparql' | 'function' = 'sparql') {
  const shell = mountShell(5, 'oxigraph', prefer)
  const { store, runtime } = shell
  const f = store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  shell.showPage('Components')
  runtime.apply({ remove: store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupData'))] })
  shell.shell.flush()
  const root = (iri: string) => [...shell.document.querySelectorAll('*')].find((e) => shell.shell.keyOf(e) === `${iri}/~root`) as HTMLElement
  const byId = (id: string) => root(UI + id)
  const click = (el: Element) => shell.fire(el, 'click')
  const objects = (s: string, p: string) => store.match(f.namedNode(s), f.namedNode(p), null).map((q) => q.object.value)
  return { ...shell, root, byId, click, objects }
}

describe('payload components', () => {
  it('have a function and (unless explained) a SPARQL implementation of every rendering', () => {
    expect(implementationGaps(['components/payload.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  it('render the same with SPARQL and function rules', () => {
    expectSameRendering(['GroupData'])
  })

  it('renders a text sketch of each', () => {
    const { runtime } = inspection('function')
    const text = runtime.project({ modality: MOD.Text, name: 'text-payload', roots: [UI + 'dt-payload'] })
    expect(toText(text.index, UI + 'dt-json-order').split('\n').slice(0, 3)).toEqual(['▾ order: {7}', '    id: "ord_1042"', '    status: "paid"'])
    expect(toText(text.index, UI + 'dt-hex-greeting').split('\n')[0]).toBe('00000000  48 65 6c 6c 6f 2c 20 53 65 6d 62 6c 61 6e 63 65  |Hello, Semblance|')
    expect(toText(text.index, UI + 'dt-body-bound').split('\n')[0]).toMatch(/^\[Text\] Hex  text\/plain · \d+ B$/)
  })

  it('size and JSON detection agree with what the SPARQL rule computes', () => {
    expect(bytesLabel(312)).toBe('312 B')
    expect(bytesLabel(4710)).toBe('4.6 KiB')
    expect(bytesLabel(2048)).toBe('2 KiB')
    expect(looksLikeJson('  \n{"a":1}')).toBe(true)
    expect(looksLikeJson('[1]')).toBe(true)
    expect(looksLikeJson('hello {')).toBe(false)
  })
})

// The hex view and the JSON tree in SPARQL (#7): bytes by sx:utf8Hex, rows and characters by sx:chars,
// the JSON parsed by sx:json; the same as their function twins, on screen and as text, as payloads and
// limits change. On wat (Oxigraph has no sx: functions, so it runs the twins either way).
describe('payload views, SPARQL and function rules alike (wat)', () => {
  const sites = () =>
    (['sparql', 'function'] as const).map((prefer) => {
      const h = mountShell(5, 'wat', prefer)
      const f = h.store.factory
      const app = f.namedNode(UI + 'app')
      const group = f.namedNode(UI + 'galleryGroup')
      h.showPage('Components')
      h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupData'))] })
      h.shell.flush()
      return { ...h, text: h.runtime.project({ modality: MOD.Text, prefer, name: 'text-payload', roots: [UI + 'dt-payload'] }) }
    })
  type H = ReturnType<typeof sites>[number]
  const html = (h: H, id: string) => [...h.document.querySelectorAll('*')].find((e) => h.shell.keyOf(e) === `${UI}${id}/~root`)?.outerHTML
  const same = (hs: H[], id: string, what: string) => {
    const [a, b] = hs.map((h) => html(h, id))
    expect(a, what).toBeDefined()
    expect(a, what).toBe(b)
    const [ta, tb] = hs.map((h) => toText(h.text.index, UI + id))
    expect(ta, what).toBe(tb)
  }
  const set = (hs: H[], id: string, p: string, value?: string, datatype?: string) => {
    for (const h of hs) {
      const f = h.store.factory
      const s = f.namedNode(UI + id)
      const add = value === undefined ? [] : [f.quad(s, f.namedNode(p), datatype ? f.literal(value, f.namedNode(datatype)) : f.literal(value))]
      h.runtime.apply({ remove: h.store.match(s, f.namedNode(p), null), add })
      h.shell.flush()
    }
  }

  it('chooses the SPARQL rules on wat', () => {
    const rules = (sites()[0]!.screen.engine as unknown as { rules: { slot: string; kind: string }[] }).rules
    for (const slot of ['HexViewRendering', 'JsonTreeRendering']) expect(rules.find((r) => r.slot === C + slot)?.kind, slot).toBe('sparql')
  })

  it('builds the same JSON tree of any payload, as it opens and closes', () => {
    const hs = sites()
    const id = 'dt-json-order'
    same(hs, id, 'at start')
    const tree = (h: H) => [...h.document.querySelectorAll('*')].find((e) => h.shell.keyOf(e) === `${UI}${id}/~root`)
    const item = (h: H, key: string) =>
      [...tree(h)!.querySelectorAll('[role=treeitem]')].find((li) => li.querySelector(':scope > .sem-row > .sem-label')?.textContent === key)!
    const press = (h: H, el: Element, key: string) => {
      const e = new h.window.Event('keydown', { bubbles: true, cancelable: true })
      Object.assign(e, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
      el.dispatchEvent(e)
    }
    const act = (what: string, f: (h: H) => void) => {
      for (const h of hs) {
        f(h)
        h.shell.flush()
      }
      same(hs, id, what)
      const [a, b] = hs.map(nodes)
      expect(a, what).toEqual(b)
    }
    // The nodes each side mints, and the tree's open and closed paths.
    const nodes = (h: H) =>
      h.store
        .match(null, h.store.factory.namedNode(C + 'inTree'), h.store.factory.namedNode(UI + id))
        .flatMap((q) => h.store.match(q.subject, null, null))
        .concat(h.store.match(h.store.factory.namedNode(UI + id), null, null).filter((q) => /Path$/.test(q.predicate.value)))
        .filter((q) => !q.predicate.value.startsWith('http://www.w3.org/ns/prov#'))
        .map((q) => `${q.graph.value} ${q.subject.value} ${q.predicate.value} ${q.object.termType === 'Literal' ? JSON.stringify(q.object.value) + '^^' + q.object.datatype.value : q.object.value}`)
        .filter((line, i, all) => all.indexOf(line) === i)
        .sort()
    const paths = (h: H, p: string) => h.store.match(h.store.factory.namedNode(UI + id), h.store.factory.namedNode(C + p), null).map((q) => q.object.value).sort()
    // By pointer, by key and by keyboard (Right opens, Left closes, Down moves).
    act('open tags', (h) => h.fire(item(h, 'tags').querySelector('.sem-twisty')!, 'click'))
    act('close customer by its key', (h) => h.fire(item(h, 'customer').querySelector('.sem-label')!, 'click'))
    act('open customer again', (h) => h.fire(item(h, 'customer').querySelector('.sem-twisty')!, 'click'))
    act('open items/0 by Right', (h) => press(h, item(h, 'items').querySelector(':scope > [role=group] .sem-label')!, 'ArrowRight'))
    act('down a row', (h) => press(h, item(h, 'items').querySelector(':scope > .sem-row > .sem-label')!, 'ArrowDown'))
    act('close items by Left', (h) => press(h, item(h, 'items').querySelector(':scope > .sem-row > .sem-label')!, 'ArrowLeft'))
    for (const h of hs) expect(paths(h, 'expandedPath')).toEqual(['/customer', '/customer/tags', '/items/0'])
    for (const h of hs) expect(paths(h, 'collapsedPath')).toEqual(['/items'])
    act('close the root', (h) => h.fire(item(h, 'order').querySelector('.sem-twisty')!, 'click'))
    act('open the root', (h) => h.fire(item(h, 'order').querySelector('.sem-twisty')!, 'click'))
    const INT = 'http://www.w3.org/2001/XMLSchema#integer'
    for (const depth of ['0', '1', '3', '9']) {
      set(hs, id, C + 'expandDepth', depth, INT)
      same(hs, id, 'expandDepth ' + depth)
    }
    for (const [what, value] of [
      ['duplicate keys', '{"a": 1, "b": {"x": true}, "a": {"y": [1, 2]}, "c": null, "b": 2}'],
      ['array-index names first', '{"z": 1, "10": 2, "2": 3, "01": 4, "-1": 5, "4294967295": 6, "4294967294": 7, "": 8}'],
      ['numbers re-spelled', '[1.50, -2e3, 0.1e1, 1e21, 1E-7, -0, 1e400, 262475353774415.625, 0.000001, 123456789012345678901234567890]'],
      ['escaped strings', String.raw`{"q\"uote": "a\"b\\c\/d", "ctl": "\b\t\n\f\r\u0001\u001f", "uni": "€ 😀 €", "lone": "\ud800", "sl/ash~tilde": "x", "~": {"/": 1}}`],
      ['empty containers', '{"o": {}, "a": [], "n": [[], {}, [[]]]}'],
      ['deep nesting', '[[[[[[[[[[[[{"deep": [[[[["bottom"]]]]]}]]]]]]]]]]]]'],
      ['a scalar', '"just a string"'],
      ['null', 'null'],
      ['whitespace around', ' \n {"a" : [ 1 , 2 ] } \t'],
      ['invalid', '{"broken": '],
      ['empty', ''],
    ]) {
      set(hs, id, C + 'value', value)
      same(hs, id, what!)
      set(hs, id, C + 'expandDepth', '99', INT)
      same(hs, id, what + ', all open')
      // The same nodes; their order keys differ only where JavaScript's order is not the source's
      // (duplicate names, array-index names), since the function twin never sees source positions.
      const [a, b] = hs.map((h) => nodes(h).filter((x) => !x.includes(' https://semblance.dev/ns/core#orderKey ')))
      expect(a, what).toEqual(b)
      act(what + ', root closed', (h) => {
        const t = tree(h)?.querySelector('.sem-twisty')
        if (t) h.fire(t, 'click')
      })
      set(hs, id, C + 'collapsedPath')
      set(hs, id, C + 'expandedPath')
      set(hs, id, C + 'expandDepth', '1', INT)
    }
    set(hs, id, C + 'value')
    same(hs, id, 'no payload')
    // The body viewer's JSON tree: a payload bound through a selection.
    same(hs, 'dt-body-fixed', 'a body as JSON')
  })

  it('writes the same hex dump of any payload, up to its limit', () => {
    const hs = sites()
    same(hs, 'dt-hex-greeting', 'at start')
    const INT = 'http://www.w3.org/2001/XMLSchema#integer'
    for (const [what, value] of [
      ['empty', ''],
      ['sixteen bytes', '0123456789abcdef'],
      ['control characters and DEL', 'a\tb\u0000c\u007f\r\n~ '],
      ['four-byte characters', '😀 ok 𝄞 ✓ ü'.repeat(3)],
      ['longer than the limit', 'x'.repeat(63) + '€€'],
    ]) {
      set(hs, 'dt-hex-greeting', C + 'value', value)
      same(hs, 'dt-hex-greeting', what!)
    }
    for (const limit of ['1', '17', '1000000']) {
      set(hs, 'dt-hex-greeting', C + 'limit', limit, INT)
      same(hs, 'dt-hex-greeting', 'limit ' + limit)
    }
    set(hs, 'dt-hex-greeting', C + 'value')
    same(hs, 'dt-hex-greeting', 'no payload')
    // The body viewer's hex view: a payload bound through a selection.
    for (const h of hs) h.fire([...h.document.querySelectorAll('button')].find((b) => h.shell.keyOf(b) === UI + 'dt-body-fixed/~as-hex')!, 'click')
    same(hs, 'dt-body-fixed', 'a body as hex')
  })
})

for (const prefer of ['sparql', 'function'] as const) {
  describe(`c:JsonTree (${prefer})`, () => {
    it('shows keys in source order, sizes of containers and values by type, open to c:expandDepth', () => {
      const { byId } = inspection(prefer)
      const tree = byId('dt-json-order')
      expect(tree.getAttribute('role')).toBe('tree')
      expect(tree.getAttribute('aria-label')).toBe('order')
      expect(tree.getAttribute('data-sem-nav-items')).toContain('[role=treeitem]')
      const items = [...tree.querySelectorAll('[role=treeitem]')]
      const rows = items.map((li) => li.querySelector(':scope > .sem-row')!.textContent!.replace('▸', ''))
      // c:expandDepth 2: the root and its direct members are open, deeper containers closed.
      expect(rows).toEqual([
        'order{7}',
        'id"ord_1042"',
        'status"paid"',
        'total129.5',
        'giftfalse',
        'couponnull',
        'customer{3}',
        'name"Ada Lovelace"',
        'email"ada@example.org"',
        'tags[2]',
        'items[2]',
        '0{3}',
        '1{3}',
      ])
      expect(items[0]!.getAttribute('aria-level')).toBe('1')
      expect(items[6]!.getAttribute('aria-expanded')).toBe('true')
      expect(items[9]!.getAttribute('aria-expanded')).toBe('false')
      expect(items[3]!.hasAttribute('aria-expanded')).toBe(false)
      expect(items[3]!.querySelector('.sem-value')!.className).toBe('sem-value sem-json-number')
      expect(items[5]!.querySelector('.sem-value')!.className).toBe('sem-value sem-json-null')
    })

    it('opens and closes a container through graph state', () => {
      const { byId, click, objects } = inspection(prefer)
      const tree = () => byId('dt-json-order')
      const item = (key: string) => [...tree().querySelectorAll('[role=treeitem]')].find((li) => li.querySelector(':scope > .sem-row > .sem-label')!.textContent === key)!
      // Open "tags" (closed by depth): its path is recorded and its members appear.
      click(item('tags').querySelector('.sem-twisty')!)
      expect(objects(UI + 'dt-json-order', C + 'expandedPath')).toEqual(['/customer/tags'])
      expect(item('tags').getAttribute('aria-expanded')).toBe('true')
      expect([...item('tags').querySelectorAll(':scope > [role=group] .sem-value')].map((v) => v.textContent)).toEqual(['"vip"', '"beta"'])
      // Close "customer" (open by depth) by its key: it is recorded as collapsed.
      click(item('customer').querySelector('.sem-label')!)
      expect(objects(UI + 'dt-json-order', C + 'collapsedPath')).toEqual(['/customer'])
      expect(item('customer').getAttribute('aria-expanded')).toBe('false')
      expect(item('customer').querySelector('[role=group]')).toBeNull()
      expect(item('customer').querySelector('.sem-twisty')!.getAttribute('aria-label')).toBe('Expand customer')
      // And open again: the nested state it had comes back.
      click(item('customer').querySelector('.sem-twisty')!)
      expect(objects(UI + 'dt-json-order', C + 'collapsedPath')).toEqual([])
      expect(objects(UI + 'dt-json-order', C + 'expandedPath').sort()).toEqual(['/customer', '/customer/tags'])
      expect(item('tags').getAttribute('aria-expanded')).toBe('true')
    })

    it('shows invalid JSON as text, with a note', () => {
      const { store, runtime, shell, byId } = inspection(prefer)
      const f = store.factory
      const tree = f.namedNode(UI + 'dt-json-order')
      runtime.apply({ remove: store.match(tree, f.namedNode(C + 'value'), null), add: [f.quad(tree, f.namedNode(C + 'value'), f.literal('{"broken": '))] })
      shell.flush()
      const el = byId('dt-json-order')
      expect(el.querySelector('.sem-note')!.textContent).toBe('Not valid JSON; shown as text.')
      expect(el.querySelector('pre')!.textContent).toBe('{"broken": ')
    })
  })

  describe(`c:HexView (${prefer})`, () => {
    it('shows UTF-8 bytes sixteen to a row, with offsets and ASCII, up to c:limit', () => {
      const { byId } = inspection(prefer)
      const hex = byId('dt-hex-greeting')
      const rows = [...hex.querySelectorAll('tbody tr')]
      expect(rows).toHaveLength(4)
      expect(rows.map((r) => r.querySelector('.sem-offset')!.textContent)).toEqual(['00000000', '00000010', '00000020', '00000030'])
      expect(rows[0]!.querySelector('.sem-bytes')!.textContent).toBe('48 65 6c 6c 6f 2c 20 53 65 6d 62 6c 61 6e 63 65')
      expect(rows[0]!.querySelector('.sem-ascii')!.textContent).toBe('Hello, Semblance')
      // " — ü": the em dash is three bytes, ü two; neither is printable ASCII.
      expect(rows[1]!.querySelector('.sem-bytes')!.textContent!.startsWith('20 e2 80 94 20 c3 bc')).toBe(true)
      expect(rows[1]!.querySelector('.sem-ascii')!.textContent!.startsWith(' ... ..n')).toBe(true)
      const total = new TextEncoder().encode('Hello, Semblance — ünïcödé ✓\nGET /api/orders?limit=20 HTTP/1.1\r\nAccept: application/json\r\n').length
      expect(hex.querySelector('.sem-more')!.textContent).toBe(`… ${total - 64} more bytes`)
      expect(hex.querySelector('table')!.getAttribute('aria-label')).toBe(`${total} bytes`)
    })
  })

  describe(`c:BodyViewer (${prefer})`, () => {
    it('shows JSON as a tree by default, with its media type and size, and switches representation', () => {
      const { byId, click, objects } = inspection(prefer)
      const viewer = () => byId('dt-body-fixed')
      const buttons = () => [...viewer().querySelectorAll('.sem-views > button')]
      expect(buttons().map((b) => b.textContent)).toEqual(['Text', 'Hex', 'JSON'])
      expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
      const body = '{"id":"ord_1042","status":"paid","items":[{"sku":"LAMP-01","qty":2},{"sku":"DESK-07","qty":1}]}'
      expect(viewer().querySelector('.sem-meta')!.textContent).toBe(`application/json · ${body.length} B`)
      expect(viewer().querySelector('[role=tree]')).not.toBeNull()
      click(buttons()[1]!)
      expect(objects(UI + 'dt-body-fixed', C + 'representation')).toEqual([C + 'AsHex'])
      expect(buttons()[1]!.getAttribute('aria-pressed')).toBe('true')
      expect(viewer().querySelector('[role=tree]')).toBeNull()
      expect(viewer().querySelector('[data-sem-c=hex-view] tbody tr .sem-ascii')!.textContent).toBe('{"id":"ord_1042"')
      click(buttons()[0]!)
      expect(viewer().querySelector('pre')!.textContent).toBe(body)
      click(buttons()[2]!)
      expect(viewer().querySelector('[role=tree] [role=treeitem]')).not.toBeNull()
    })

    it('follows the subject it is bound to, offering JSON only for JSON', () => {
      const { byId, click, root } = inspection(prefer)
      const viewer = () => byId('dt-body-bound')
      const buttons = () => [...viewer().querySelectorAll('.sem-views > button')].map((b) => `${b.textContent}:${b.getAttribute('aria-pressed')}`)
      // A plain-text log: no JSON option, shown as text.
      expect(buttons()).toEqual(['Text:true', 'Hex:false'])
      expect(viewer().querySelector('pre')!.textContent!.split('\n')[0]).toBe('12:00:01 INFO  server listening on :8080')
      expect(viewer().querySelector('.sem-meta')!.textContent).toMatch(/^text\/plain · \d+ B$/)
      // Choosing another sample (the picker writes the bound property) re-binds the viewer.
      const picker = root(UI + 'dt-body-picker')
      click([...picker.querySelectorAll('button')].find((b) => b.textContent!.includes('Order'))!)
      expect(buttons()).toEqual(['Text:false', 'Hex:false', 'JSON:true'])
      expect(viewer().querySelector('[role=tree]')).not.toBeNull()
      click([...picker.querySelectorAll('button')].find((b) => b.textContent!.includes('CSV'))!)
      expect(buttons()).toEqual(['Text:true', 'Hex:false'])
      expect(viewer().querySelector('.sem-meta')!.textContent).toMatch(/^text\/csv · /)
    })

    it('says so when there is nothing to show', () => {
      const { store, runtime, shell, byId } = inspection(prefer)
      const f = store.factory
      runtime.apply({ remove: store.match(f.namedNode(UI + 'dt-body-pick'), null, null), add: [] })
      shell.flush()
      const viewer = byId('dt-body-bound')
      expect(viewer.tagName).toBe('P')
      expect(viewer.textContent).toBe('Pick a sample.')
    })
  })
}
