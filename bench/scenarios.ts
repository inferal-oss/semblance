// Environment-agnostic benchmark scenarios, run from Node (engine only) and
// from the browser (engine + real DOM patching).
import { EX, todoApp, todoOps } from '../src/examples/todo.ts'
import { A11Y, C, MOD, NS, STY } from '../src/ns.ts'
import type { Delta } from '../src/rdf.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import type { GraphStore } from '../src/store/types.ts'

export type StoreKind = 'wat' | 'rust' | 'oxigraph' | 'n3' | 'hybrid'

export interface BenchEnv {
  name: string
  loadStore(kind: StoreKind, ...data: string[]): GraphStore
  /** A fresh, attached host element, when a DOM is available. */
  host?: () => Element
  log(line: string): void
  /** Lets a browser repaint between runs. */
  pause?: () => Promise<void>
}

export interface Config {
  id: string
  store: StoreKind
  prefer: 'sparql' | 'function'
  bulkThreshold: number
}

export const CONFIGS: Config[] = [
  { id: 'wat · sparql · bulk', store: 'wat', prefer: 'sparql', bulkThreshold: 16 },
  { id: 'wat · sparql · per-focus', store: 'wat', prefer: 'sparql', bulkThreshold: Infinity },
  { id: 'wat · function', store: 'wat', prefer: 'function', bulkThreshold: 16 },
  { id: 'rust · sparql · bulk', store: 'rust', prefer: 'sparql', bulkThreshold: 16 },
  { id: 'rust · sparql · per-focus', store: 'rust', prefer: 'sparql', bulkThreshold: Infinity },
  { id: 'rust · function', store: 'rust', prefer: 'function', bulkThreshold: 16 },
  { id: 'oxigraph · sparql · bulk', store: 'oxigraph', prefer: 'sparql', bulkThreshold: 16 },
  { id: 'oxigraph · sparql · per-focus', store: 'oxigraph', prefer: 'sparql', bulkThreshold: Infinity },
  { id: 'oxigraph · function', store: 'oxigraph', prefer: 'function', bulkThreshold: 16 },
  { id: 'hybrid · sparql · bulk', store: 'hybrid', prefer: 'sparql', bulkThreshold: 16 },
  { id: 'hybrid · function', store: 'hybrid', prefer: 'function', bulkThreshold: 16 },
  { id: 'n3 · function', store: 'n3', prefer: 'function', bulkThreshold: 16 },
]

export interface Row {
  env: string
  config: string
  size: number
  scenario: string
  /** mean engine time per operation (store write + rule evaluation + index update), ms */
  engineMs: number
  /** mean DOM patch time per operation, ms */
  domMs?: number
  ruleRuns: number
  derived: number
}

type Update = (ops: ReturnType<typeof todoOps>, i: number, size: number) => Delta

export const UPDATES: [string, Update][] = [
  ['toggle item', (t, i, n) => t.set(`t${1 + ((i * 37) % n)}`, 'done', i % 2 === 0)],
  ['rename item', (t, i, n) => t.set(`t${1 + ((i * 53) % n)}`, NS.rdfs + 'label', `Renamed ${i}`)],
  ['reorder item', (t, i, n) => t.set(`t${1 + ((i * 71) % n)}`, 'priority', -1 - i)],
  ['add item', (t, i, n) => t.addItem(`bench-${i}`, `Added ${i}`, n)],
  ['type in field', (t, i) => t.set('newTodo', C.value, 'x'.repeat(i + 1))],
]

export async function runBench(env: BenchEnv, sizes: number[], configs = CONFIGS, repeats = 15): Promise<Row[]> {
  const rows: Row[] = []
  const now = () => performance.now()
  for (const size of sizes) {
    const data = todoApp(size)
    for (const config of configs) {
      const store = env.loadStore(config.store, data)
      const runtime = new Runtime(store)
      let t = now()
      const screen = runtime.project({
        modality: MOD.Screen,
        layers: [A11Y.Layer, STY.Layer],
        prefer: config.prefer,
        bulkThreshold: config.bulkThreshold,
      })
      const initialEngine = now() - t
      const host = env.host?.()
      const dom = host ? new DomRenderer(screen.index, host, EX + 'page') : undefined
      t = now()
      dom?.flush()
      const initialDom = dom ? now() - t : undefined
      const stats = screen.engine.stats
      rows.push({
        env: env.name,
        config: config.id,
        size,
        scenario: 'initial render',
        engineMs: initialEngine,
        domMs: initialDom,
        ruleRuns: stats.ruleRuns,
        derived: screen.engine.derivedSize,
      })
      env.log(`${env.name} ${config.id} n=${size} initial ${initialEngine.toFixed(1)}ms${dom ? ` + dom ${initialDom!.toFixed(1)}ms` : ''}`)

      const ops = todoOps(store)
      for (const [scenario, update] of UPDATES) {
        // Sum over the batch: individual updates can be below timer resolution.
        let engineTotal = 0
        let domTotal = 0
        const runsBefore = stats.ruleRuns
        for (let i = 0; i < repeats; i++) {
          const delta = update(ops, i, size)
          t = now()
          runtime.apply(delta)
          engineTotal += now() - t
          if (dom) {
            t = now()
            dom.flush()
            domTotal += now() - t
          }
        }
        rows.push({
          env: env.name,
          config: config.id,
          size,
          scenario,
          engineMs: engineTotal / repeats,
          domMs: dom ? domTotal / repeats : undefined,
          ruleRuns: (stats.ruleRuns - runsBefore) / repeats,
          derived: screen.engine.derivedSize,
        })
      }
      host?.remove()
      await env.pause?.()
    }
  }
  return rows
}

const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms >= 0.1 ? ms.toFixed(2) : ms.toFixed(3))

/** One markdown table per size: scenarios as rows, configs as columns. */
export function toMarkdown(rows: Row[]): string {
  const out: string[] = []
  for (const size of [...new Set(rows.map((r) => r.size))]) {
    const sized = rows.filter((r) => r.size === size)
    const configs = [...new Set(sized.map((r) => r.config))]
    const scenarios = [...new Set(sized.map((r) => r.scenario))]
    const hasDom = sized.some((r) => r.domMs !== undefined)
    out.push(`### ${size.toLocaleString('en-US')} items${hasDom ? ' (engine + DOM, ms)' : ' (engine, ms)'}`, '')
    out.push(`| scenario | ${configs.join(' | ')} |`, `|---|${configs.map(() => '---:').join('|')}|`)
    for (const s of scenarios) {
      const cells = configs.map((c) => {
        const r = sized.find((r) => r.config === c && r.scenario === s)
        if (!r) return '–'
        return r.domMs !== undefined ? `${fmt(r.engineMs)} + ${fmt(r.domMs)}` : fmt(r.engineMs)
      })
      out.push(`| ${s} | ${cells.join(' | ')} |`)
    }
    const initial = sized.filter((r) => r.scenario === 'initial render')
    out.push('', `Derived triples: ${initial.map((r) => `${r.config} ${r.derived.toLocaleString('en-US')}`).join(', ')}`, '')
  }
  return out.join('\n')
}

