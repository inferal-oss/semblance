import type { Quad } from '@rdfjs/types'
import { Parser } from 'n3'
import { observationsTurtle } from '../bench/observations.ts'
import { CONFIGS, type Row } from '../bench/scenarios.ts'
import { C, PERF_GRAPH, XSD_BOOLEAN } from '../src/ns.ts'
import { quadKey } from '../src/rdf.ts'
import type { Runtime } from '../src/runtime.ts'
import { CELL_PREFIX } from './cell-protocol.ts'

// The benchmark runner: an effect of graph state, with no UI of its own.
// Run / Clear buttons record `ui:perf ui:request "run"|"clear"`; this runs the
// cells (each in a fresh hidden realm), writes the results into the perf graph
// as RDF observations, and keeps ui:perfProgress (a c:Progress) current. The
// charts, findings and tables are components projecting that graph.

const KEY = 'semblance-perf-v4'
const UI = 'https://semblance.dev/demo#'

export function perfRunner(runtime: Runtime, refresh: () => void) {
  const { store } = runtime
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const perf = nn(PERF_GRAPH)
  let running = false

  /** Replace the perf graph's content with the observations of `rows`. */
  function publish(rows: Row[], planned: number[]) {
    const next = rows.length || planned.length ? new Parser().parse(observationsTurtle(rows, CONFIGS, planned)) : []
    const current = store.match(null, null, null, perf)
    const want = new Map(next.map((q) => [quadKey(q as unknown as Quad), q as unknown as Quad]))
    const have = new Set(current.map(quadKey))
    runtime.write(PERF_GRAPH, {
      remove: current.filter((q) => !want.has(quadKey(q))),
      add: [...want].filter(([k]) => !have.has(k)).map(([, q]) => q),
    })
  }

  function progress(value: number, max: number, label: string, active: boolean) {
    const p = nn(UI + 'perfProgress')
    const set = (prop: string, o: Quad['object']) => ({ remove: store.match(p, nn(prop), null, f.defaultGraph()), add: [f.quad(p, nn(prop), o)] })
    const parts = [
      set(C.value, f.literal(String(value), nn('http://www.w3.org/2001/XMLSchema#decimal'))),
      set(C.max, f.literal(String(max), nn('http://www.w3.org/2001/XMLSchema#decimal'))),
      set(C.label, f.literal(label)),
      set(C.active, f.literal(String(active), nn(XSD_BOOLEAN))),
    ]
    runtime.apply({ remove: parts.flatMap((d) => d.remove), add: parts.flatMap((d) => d.add) })
  }

  async function run() {
    const field = store.match(nn(UI + 'sizes'), nn(C.value), null, f.defaultGraph())[0]?.object.value ?? '100,1000'
    const sizes = [...new Set(field.split(',').map((s) => Number(s.trim())).filter((n) => n > 0))].sort((a, b) => a - b)
    const cells = sizes.flatMap((size) => CONFIGS.map((c) => ({ config: c.id, size })))
    const rows: Row[] = []
    running = true
    publish(rows, sizes)
    try {
      for (const [i, cell] of cells.entries()) {
        progress(i, cells.length, `${i + 1} / ${cells.length} · ${cell.config} · ${cell.size.toLocaleString('en-US')} items`, true)
        refresh()
        rows.push(...(await runCell(cell.config, cell.size)))
        save({ rows, sizes })
        publish(rows, sizes)
        refresh()
      }
      progress(cells.length, cells.length, `Done · ${cells.length} cells`, true)
    } catch (e) {
      progress(0, 1, `Failed: ${(e as Error).message}`, true)
    } finally {
      running = false
      refresh()
    }
  }

  function clear() {
    save({ rows: [], sizes: [] })
    publish([], [])
    progress(0, 1, '', false)
    refresh()
  }

  // Restore the last run of this tab.
  const saved = load()
  if (saved.rows.length) publish(saved.rows, saved.sizes)

  /** Called after every graph change: perform a pending request, if any. */
  return function check() {
    const request = store.match(nn(UI + 'perf'), nn(UI + 'request'), null, f.defaultGraph())
    if (!request.length) return
    runtime.apply({ remove: request, add: [] })
    if (running) return
    if (request.some((q) => q.object.value === 'clear')) clear()
    else void run()
  }
}

function load(): { rows: Row[]; sizes: number[] } {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') ?? { rows: [], sizes: [] }
  } catch {
    return { rows: [], sizes: [] }
  }
}
function save(state: { rows: Row[]; sizes: number[] }) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state))
  } catch {}
}

/** One cell in a fresh hidden realm: the same document, booted in cell mode (see boot.ts). */
function runCell(config: string, size: number): Promise<Row[]> {
  const id = Math.random().toString(36).slice(2)
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;visibility:hidden'
  frame.name = CELL_PREFIX + JSON.stringify({ id, config, size })
  frame.srcdoc = (window as unknown as { semblancePristine: string }).semblancePristine
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('cell timed out')), 300_000)
    function finish(result: Row[] | Error) {
      clearTimeout(timer)
      removeEventListener('message', onMessage)
      frame.remove()
      result instanceof Error ? reject(result) : resolve(result)
    }
    function onMessage(e: MessageEvent) {
      if (e.source !== frame.contentWindow || e.data?.source !== 'semblance-bench' || e.data.id !== id) return
      finish(e.data.error ? new Error(e.data.error) : (e.data.rows as Row[]))
    }
    addEventListener('message', onMessage)
    document.body.appendChild(frame)
  })
}
