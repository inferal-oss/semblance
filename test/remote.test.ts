// The remote-sources effect (src/remote.ts, docs/REMOTE.md) over the example's page
// (examples/remote) and the reference server: the initial load, changes from the store and
// to it, a refused write, reconnecting after a gap, and what a change from the store costs.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseHTML } from 'linkedom'
import { DataFactory, Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { SourceServer } from '../src/node/source-server.ts'
import { MOD, NS, SOURCES_GRAPH } from '../src/ns.ts'
import { type Endpoint, httpTransport, RemoteSources, type SourceTransport } from '../src/remote.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import type { Pattern } from '../src/source-protocol.ts'
import { DEFAULT_LAYERS } from '../src/web/mount.ts'

const EX = 'https://example.org/remote#'
const SRC = NS.src
const read = (f: string) => readFileSync(new URL('../examples/remote/' + f, import.meta.url), 'utf8')
const app = read('app.ttl')
const todos = read('todos.ttl')
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
const n3 = DataFactory
const ttl = (s: string) => new Parser({ format: 'text/turtle' }).parse(`@prefix ex: <${EX}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n${s} .`)

/** The example's store, with `extra` statements no page binds to and `more` todos beyond its three. */
function store(opts: { extra?: number; more?: number; logSize?: number } = {}) {
  const server = new SourceServer({
    logSize: opts.logSize,
    validate: ({ add }) => (add.some((q) => q.predicate.value === LABEL && q.object.value.length > 40) ? 'A todo is at most 40 characters.' : undefined),
  })
  server.load(todos)
  const nn = n3.namedNode
  const add = [
    ...Array.from({ length: opts.extra ?? 0 }, (_, i) => n3.quad(nn(`${EX}other${i}`), nn(EX + 'note'), n3.literal(String(i)))),
    ...Array.from({ length: opts.more ?? 0 }, (_, i) => [
      n3.quad(nn(`${EX}m${i}`), nn(NS.rdf + 'type'), nn(EX + 'Todo')),
      n3.quad(nn(`${EX}m${i}`), nn(LABEL), n3.literal(`More ${i}`)),
      n3.quad(nn(`${EX}m${i}`), nn(EX + 'created'), n3.literal(`2026-10-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`, nn(NS.xsd + 'dateTime'))),
      n3.quad(nn(`${EX}todos`), nn(NS.c + 'item'), nn(`${EX}m${i}`)),
    ]).flat(),
  ]
  if (add.length) server.change({ add, remove: [] })
  return server
}

/** The server in-process, as a transport that can be cut off (down) and whose stream can be dropped. */
function local(server: SourceServer) {
  const t = {
    down: false,
    follow(patterns: Pattern[], after: number | undefined, on: (event: string, data: unknown) => void, signal: AbortSignal) {
      return new Promise<void>((resolve, reject) => {
        if (t.down) return reject(new Error('unreachable'))
        let stop = () => {}
        stop = server.subscribe(patterns, after, on, () => (stop(), reject(new Error('dropped'))))
        signal.addEventListener('abort', () => (stop(), resolve()), { once: true })
      })
    },
    async write(req: Parameters<SourceTransport['write']>[0]) {
      await Promise.resolve()
      if (t.down) throw new Error('unreachable')
      return server.write(req)
    },
  }
  return t
}

function mount(endpoint: Endpoint | SourceTransport | undefined, kind: 'wat' | 'oxigraph' = 'wat') {
  const s = loadStore(kind, app)
  const runtime = new Runtime(s)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, name: 'screen', roots: [EX + 'page'] }, (e) => {
    throw e
  })
  const { document, window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const renderer = new DomRenderer(screen.index, document.getElementById('app')!, EX + 'page')
  renderer.flush()
  const bus = new EventBus(runtime, screen)
  bus.attach(renderer, () => renderer.flush())
  const sources = new RemoteSources(runtime, { endpoints: endpoint ? { [EX + 'store']: endpoint } : {}, bus, onChange: () => renderer.flush(), backoff: { minMs: 1, maxMs: 5 } })
  sources.attach()
  const f = s.factory
  const nn = (x: string) => f.namedNode(x)
  const labels = () => [...document.querySelectorAll('[data-sem-c=list] label')].map((l) => l.textContent)
  const fire = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true }))
  const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!
  const add = (label: string) => {
    const input = document.querySelector('[data-sem-c=text-field] input') as HTMLInputElement
    input.value = label
    fire(input, 'input')
    fire(button('Add'), 'click')
  }
  const tick = (label: string) => {
    const l = [...document.querySelectorAll('[data-sem-c=list] label')].find((x) => x.textContent === label)!
    const box = l.previousElementSibling as HTMLInputElement
    box.checked = !box.checked
    fire(box, 'change')
  }
  const state = () => s.match(nn(EX + 'store'), nn(SRC + 'state'), null, nn(SOURCES_GRAPH))[0]?.object.value
  const members = (kind: string) => s.match(null, nn(NS.rdf + 'type'), nn(SRC + kind), nn(SOURCES_GRAPH)).map((q) => q.subject)
  const badge = () => document.querySelector('[data-sem-c=badge]')!.textContent
  return { store: s, runtime, screen, document, sources, labels, add, tick, button, fire, state, members, badge, nn }
}

/** Let the effect's promises and timers run. */
const turn = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await turn(2)
  }
}

describe('remote sources', () => {
  it('waits for the store, busy, and shows what it loads', async () => {
    // A store that never answers: the list waits for it.
    const h = mount({ follow: () => new Promise(() => {}), write: () => new Promise(() => {}) })
    expect(h.state()).toBe(SRC + 'Loading')
    expect(h.document.querySelector('[data-sem-c=list]')!.getAttribute('aria-busy')).toBe('true')
    expect(h.labels()).toEqual([])

    const server = store()
    const g = mount(local(server))
    expect(g.state()).toBe(SRC + 'Live')
    expect(g.labels()).toEqual(['Write the core ontology', 'Sketch the style layer', 'Wire up behaviour'])
    expect(g.document.querySelector('[data-sem-c=list]')!.getAttribute('aria-busy')).toBe(null)
    expect(g.badge()).toBe('Live')
    expect(g.members('Snapshot')).toHaveLength(1)
  })

  it('leaves a source the host gave no endpoint unbound', () => {
    const h = mount(undefined)
    expect(h.state()).toBe(SRC + 'Unbound')
    expect(h.labels()).toEqual([])
  })

  it("takes the store's changes as they come", () => {
    const server = store()
    const h = mount(local(server))
    server.change({ add: ttl(`ex:t2 rdfs:label "Sketch the theme"`), remove: ttl(`ex:t2 rdfs:label "Sketch the style layer"`) })
    expect(h.labels()).toEqual(['Write the core ontology', 'Sketch the theme', 'Wire up behaviour'])
    // A todo that joins: sent whole, with its link.
    server.change({ add: ttl(`ex:t4 a ex:Todo ; rdfs:label "Ship it" ; ex:created "2026-11-04T09:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> . ex:todos <${NS.c}item> ex:t4`), remove: [] })
    expect(h.labels()).toEqual(['Write the core ontology', 'Sketch the theme', 'Wire up behaviour', 'Ship it'])
    expect(h.members('Received')).toHaveLength(2)
    expect(h.store.match(h.nn(EX + 'store'), h.nn(SRC + 'cursor'), null, h.nn(SOURCES_GRAPH))[0]!.object.value).toBe(String(server.cursor))
  })

  it("sends the page's changes to the store, each as one write, tied to its event", async () => {
    const server = store()
    const h = mount(local(server))
    h.tick('Sketch the style layer')
    await turn()
    h.add('Buy milk')
    await h.sources.settled()
    expect(server.store.getQuads(n3.namedNode(EX + 't2'), n3.namedNode(EX + 'done'), null, null).map((q) => q.object.value)).toEqual(['true'])
    const added = server.store.getQuads(null, n3.namedNode(LABEL), n3.literal('Buy milk'), null)
    expect(added).toHaveLength(1)
    expect(server.store.getQuads(n3.namedNode(EX + 'todos'), null, added[0]!.subject, null)).toHaveLength(1)
    // The field's own value is the page's, not the store's.
    expect(server.store.getQuads(n3.namedNode(EX + 'newTodo'), null, null, null)).toHaveLength(0)
    const writes = h.members('Write')
    expect(writes).toHaveLength(2)
    expect(h.members('Confirmed')).toHaveLength(2)
    for (const w of writes) expect(h.store.match(w, h.nn(NS.prov + 'wasInformedBy'), null, h.nn(SOURCES_GRAPH))).toHaveLength(1)
    // The store sends the writes back (tagged), which changes nothing in this page; another page sees them.
    expect(h.labels()).toContain('Buy milk')
    const other = mount(local(server))
    expect(other.labels()).toContain('Buy milk')
    // Clear done: removals go too, and reach the other page.
    other.fire(other.button('Clear done'), 'click')
    await other.sources.settled()
    expect(h.labels()).toEqual(['Wire up behaviour', 'Buy milk'])
    expect(server.store.getQuads(n3.namedNode(EX + 't1'), null, null, null)).toHaveLength(0)
  })

  it('puts back what the store holds when it refuses a write, and says why', async () => {
    const server = store()
    const h = mount(local(server))
    h.add('This label is certainly far longer than forty characters')
    expect(h.labels()).toContain('This label is certainly far longer than forty characters')
    await h.sources.settled()
    expect(h.labels()).toEqual(['Write the core ontology', 'Sketch the style layer', 'Wire up behaviour'])
    expect(h.members('Refused')).toHaveLength(1)
    expect(h.badge()).toBe('A todo is at most 40 characters.')
    expect(server.store.getQuads(null, n3.namedNode(LABEL), null, null)).toHaveLength(3)
  })

  it('refuses a write made from a state changed elsewhere, and shows the change', async () => {
    const server = store()
    const h = mount(local(server))
    // The page's tick and another client's at once: the store takes the other's first.
    const elsewhere = { add: ttl(`ex:t2 ex:done true`), remove: ttl(`ex:t2 ex:done false`) }
    h.tick('Sketch the style layer')
    server.change(elsewhere)
    h.tick('Sketch the style layer') // and back, before the first write was answered
    await h.sources.settled()
    // The first write removed `done false`, which the store no longer held: refused as stale. The
    // second removed `done true`, which it holds: taken. Page and store agree on the page's last word.
    expect(h.store.match(null, h.nn(SRC + 'reason'), h.store.factory.literal('stale'), h.nn(SOURCES_GRAPH))).toHaveLength(1)
    const done = server.store.getQuads(n3.namedNode(EX + 't2'), n3.namedNode(EX + 'done'), null, null).map((q) => q.object.value)
    expect(done).toEqual(['false'])
    expect(h.store.match(h.nn(EX + 't2'), h.nn(EX + 'done'), null, h.store.factory.defaultGraph()).map((q) => q.object.value)).toEqual(done)
  })

  it('reconnects after a gap and takes what it missed, or the whole part when the gap is too long', async () => {
    for (const logSize of [100, 1]) {
      const server = store({ logSize })
      const t = local(server)
      const h = mount(t)
      t.down = true
      server.drop()
      await until(() => h.state() === SRC + 'Reconnecting')
      expect(h.badge()).toBe('Reconnecting')
      expect(h.document.querySelector('[data-sem-c=list]')!.getAttribute('aria-busy')).toBe('true')
      // Meanwhile: a todo goes, another's label changes; and this page ticks one (its write waits).
      server.change({ add: [], remove: [...server.store.getQuads(n3.namedNode(EX + 't1'), null, null, null), ...server.store.getQuads(null, null, n3.namedNode(EX + 't1'), null)] })
      server.change({ add: ttl(`ex:t3 rdfs:label "Wire it all up"`), remove: ttl(`ex:t3 rdfs:label "Wire up behaviour"`) })
      h.tick('Sketch the style layer')
      t.down = false
      await until(() => h.state() === SRC + 'Live')
      await h.sources.settled()
      expect(h.labels()).toEqual(['Sketch the style layer', 'Wire it all up'])
      expect(h.badge()).toBe('Live')
      expect(server.store.getQuads(n3.namedNode(EX + 't2'), n3.namedNode(EX + 'done'), null, null).map((q) => q.object.value)).toEqual(['true'])
      const snapshots = h.members('Snapshot')
      expect(snapshots).toHaveLength(logSize === 1 ? 2 : 1)
      if (logSize === 1) expect(h.store.match(null, h.nn(SRC + 'reset'), null, h.nn(SOURCES_GRAPH))).toHaveLength(1)
      h.sources.stop()
    }
  })

  it("costs what a change from the store changes, not the store's size", () => {
    const measure = (opts: { extra?: number; more?: number }) => {
      const server = store(opts)
      const h = mount(local(server), 'wat')
      const counters = { read: 0 }
      const match = h.store.match
      h.store.match = (...args) => (counters.read++, match.apply(h.store, args))
      const before = { runs: h.screen.engine.stats.ruleRuns, written: h.screen.engine.stats.derivedAdded + h.screen.engine.stats.derivedRemoved, checks: server.work.checks }
      server.change({ add: ttl(`ex:t2 rdfs:label "Sketch the theme"`), remove: ttl(`ex:t2 rdfs:label "Sketch the style layer"`) })
      h.store.match = match
      expect(h.labels()).toContain('Sketch the theme')
      return {
        ruleRuns: h.screen.engine.stats.ruleRuns - before.runs,
        written: h.screen.engine.stats.derivedAdded + h.screen.engine.stats.derivedRemoved - before.written,
        serverChecks: server.work.checks - before.checks,
        reads: counters.read,
      }
    }
    const small = measure({ extra: 10 })
    expect(measure({ extra: 20_000 })).toEqual(small)
    // And not the size of the page's part of it either: the list renders member-wise.
    expect(measure({ extra: 10, more: 60 })).toEqual(small)
  })

  it('speaks the protocol over HTTP', async () => {
    const server = store()
    const handle = server.handler('/store/')
    const http = createServer((req, res) => void (handle(req, res) || res.writeHead(404).end()))
    await new Promise<void>((r) => http.listen(0, r))
    const url = `http://localhost:${(http.address() as AddressInfo).port}/store/`
    try {
      const h = mount(httpTransport({ url }))
      await until(() => h.state() === SRC + 'Live')
      expect(h.labels()).toHaveLength(3)
      h.add('Over the wire')
      await h.sources.settled()
      expect(server.store.getQuads(null, n3.namedNode(LABEL), n3.literal('Over the wire'), null)).toHaveLength(1)
      server.change({ add: ttl(`ex:t3 rdfs:label "Wired"`), remove: ttl(`ex:t3 rdfs:label "Wire up behaviour"`) })
      await until(() => h.labels().includes('Wired'))
      h.sources.stop()
    } finally {
      server.drop()
      http.closeAllConnections()
      await new Promise((r) => http.close(r))
    }
  })
})
