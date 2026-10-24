// Shell page timings on an engine store, interpreted or compiled:
//   SEMBLANCE_ENGINE_COMPILE=<n> npx tsx rdf-engine/host/compiled-pages.ts [rust|wat]
// (n = 0: interpreted; n: each prepared query compiled on its n-th run.)
// Mounts the shell (the Playground), then shows each page three times; prints
// one JSON line: mount ms, each page's first and best visit, and compile counters.
import '../../src/behaviour/events.ts'
import { mountShell } from '../../test/harness.ts'
import { type EngineStore, engineStoreHooks } from './store.ts'

const kind = (process.argv[2] ?? 'rust') as 'rust' | 'wat'
let store: EngineStore | undefined
engineStoreHooks.created = (s) => void (store = s)

let t = performance.now()
const shell = mountShell(5, kind, 'sparql')
const mountMs = performance.now() - t
const pages = ['Home', 'Docs', 'Components', 'Examples', 'Playground'] as const
const visits: Record<string, number[]> = {}
for (let round = 0; round < 3; round++) {
  for (const page of pages) {
    t = performance.now()
    shell.showPage(page)
    ;(visits[page] ??= []).push(performance.now() - t)
  }
}
const s = store!.engine.stats
console.log(
  JSON.stringify({
    kind,
    compileOnRun: Number(process.env.SEMBLANCE_ENGINE_COMPILE ?? 0),
    mountMs,
    pages: Object.fromEntries(Object.entries(visits).map(([p, v]) => [p, { first: v[0], best: Math.min(...v.slice(1)) }])),
    totalFirstMs: pages.reduce((a, p) => a + visits[p]![0]!, 0),
    totalBestMs: pages.reduce((a, p) => a + Math.min(...visits[p]!.slice(1)), 0),
    compiled: s.compiled,
    declined: [...s.declined.values()].reduce((a, b) => a + b, 0),
    emitMs: s.emitMs,
    wasmMs: s.wasmMs,
    compiledRuns: s.compiledRuns,
    interpretedRuns: s.interpretedRuns,
  }),
)
process.exit(0)
