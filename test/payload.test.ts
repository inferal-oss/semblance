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
