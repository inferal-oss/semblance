// The page, bound to the store by hand (docs/REMOTE.md, "The pattern"): the todos arrive as a
// snapshot and then as deltas, each applied to the runtime as one change; the page's own
// changes to them go back as writes, one at a time, and a refused write is repaired with what
// the store holds.
import { mount } from '@inferal-oss/semblance/web'
import { concerns, type DeltaMessage, fromNTriples, type Pattern, serverSentEvents, type Snapshot, toNTriples, type WriteResult } from '@inferal-oss/semblance'
import type { Quad, Term } from '@rdfjs/types'
import app from './app.ttl?raw'

const EX = 'https://example.org/remote#'
const C = 'https://semblance.dev/ns/component#'
const STY = 'https://semblance.dev/ns/style#'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const STORE = '/store/'

const { runtime, flush } = await mount(document.getElementById('app')!, { root: EX + 'page', graphs: [app] })
const store = runtime.store
const f = store.factory

// The part of the store this page needs: every todo, and the list's links to them.
const patterns: Pattern[] = [{ class: EX + 'Todo' }, { subject: EX + 'todos', predicate: C + 'item' }]
const typesOf = (s: Term) => new Set(store.match(s, f.namedNode(RDF_TYPE), null, f.defaultGraph()).map((q) => q.object.value))

// What the store sends is applied as it is, and is not a write.
let fromStore = false
function apply(add: Quad[], remove: Quad[]) {
  fromStore = true
  try {
    runtime.apply({ add, remove })
  } finally {
    fromStore = false
  }
  flush()
}

function status(label: string, tone?: string) {
  const s = f.namedNode(EX + 'status')
  apply([f.quad(s, f.namedNode(C + 'label'), f.literal(label)), ...(tone ? [f.quad(s, f.namedNode(STY + 'tone'), f.namedNode(STY + tone))] : [])], [
    ...store.match(s, f.namedNode(C + 'label'), null, f.defaultGraph()),
    ...store.match(s, f.namedNode(STY + 'tone'), null, f.defaultGraph()),
  ])
}

// Reads: a snapshot, then deltas; after a break, resume from the cursor.
let cursor: number | undefined
async function follow() {
  for (let attempt = 0; ; attempt++) {
    try {
      const url = `${STORE}changes?patterns=${encodeURIComponent(JSON.stringify(patterns))}${cursor === undefined ? '' : `&after=${cursor}`}`
      const res = await fetch(url, { headers: { accept: 'text/event-stream' } })
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`)
      for await (const { event, data } of serverSentEvents(res.body)) {
        const m = JSON.parse(data)
        if (event === 'snapshot') {
          const snap = m as Snapshot
          const add = fromNTriples(snap.add, f)
          // A reset replaces what the page holds of the store.
          const keep = new Set(add.map((q) => q.subject.value + ' ' + q.predicate.value + ' ' + q.object.value))
          const remove = snap.reset ? store.match(null, null, null, f.defaultGraph()).filter((q) => concerns(q, patterns, typesOf) && !keep.has(q.subject.value + ' ' + q.predicate.value + ' ' + q.object.value)) : []
          apply(add, remove)
        } else if (event === 'delta') {
          const d = m as DeltaMessage
          apply(fromNTriples(d.add, f), fromNTriples(d.remove, f))
        }
        cursor = m.cursor
        attempt = 0
        status('Live', 'Success')
      }
      throw new Error('the stream ended')
    } catch (e) {
      status('Reconnecting', 'Warning')
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 10_000)))
    }
  }
}
void follow()

// Writes: the page's changes to what the store covers, per tick, sent one at a time.
let batch: { add: Quad[]; remove: Quad[] } | undefined
const queue: { id: string; add: Quad[]; remove: Quad[] }[] = []
let sending = false
let ids = 0
runtime.onInput((graph, delta) => {
  if (graph !== undefined || fromStore) return
  const add = delta.add.filter((q) => concerns(q, patterns, typesOf))
  // A removed statement is judged by the subject's types before the change: a removed todo has lost its type by now.
  const removedTypes = (s: Term) => new Set([...typesOf(s), ...delta.remove.filter((q) => q.subject.equals(s) && q.predicate.value === RDF_TYPE).map((q) => q.object.value)])
  const remove = delta.remove.filter((q) => concerns(q, patterns, removedTypes))
  if (!add.length && !remove.length) return
  if (!batch) {
    batch = { add: [], remove: [] }
    queueMicrotask(() => {
      queue.push({ id: `${Date.now().toString(36)}-${++ids}`, ...batch! })
      batch = undefined
      void send()
    })
  }
  batch.add.push(...add)
  batch.remove.push(...remove)
})

async function send() {
  if (sending) return
  sending = true
  try {
    while (queue.length) {
      const w = queue[0]!
      let result: WriteResult
      try {
        const res = await fetch(`${STORE}writes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: w.id, add: toNTriples(w.add), remove: toNTriples(w.remove) }) })
        result = await res.json()
      } catch {
        // The store is out of reach: the write waits, and is sent when it answers again.
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }
      queue.shift()
      if (!result.ok) {
        apply(fromNTriples(result.repair.add, f), fromNTriples(result.repair.remove, f))
        status(result.reason === 'stale' ? 'Changed elsewhere: shown as it is now' : result.reason, 'Danger')
      }
    }
  } finally {
    sending = false
  }
}
