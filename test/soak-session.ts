import { appendFileSync } from 'node:fs'
import type { StoreKind } from '../src/node/load.ts'
import type { GraphStore } from '../src/store/types.ts'
import { mountShellPrepared } from './harness.ts'
import { dangling, watchRetired } from './retired.ts'

/**
 * The shell soak's session (test/soak.test.ts, test/soak-stores.test.ts): the demo's whole
 * interface on one store, driven through events by a fixed cycle of steps, with an idle slice
 * between interactions as a browser would give it. `warmUp` and `measured` are numbers of
 * periods; the footprint is sampled after each, at the same phase of the cycle. `prepare` changes
 * the loaded graph before anything is projected (mountShellPrepared).
 */
export function shellSoak(kind: StoreKind, prefer: 'sparql' | 'function', { warmUp, measured, prepare }: { warmUp: number; measured: number; prepare?: (store: GraphStore) => void }) {
  const h = mountShellPrepared((store) => prepare?.(store), prefer, kind)
  const { document, fire } = h
  // The log keeps 1,000 members that recorded an undoable change besides its 200 newest
  // (docs/RETENTION.md): fewer here, so the session passes that bound as well before it is measured.
  const f = h.store.factory
  const undo = f.namedNode('https://semblance.dev/ns/behaviour#UndoRetention')
  const amount = f.namedNode('https://w3id.org/ldes#amount')
  for (const q of h.store.match(undo, amount, null)) h.store.delete(q)
  h.store.add(f.quad(undo, amount, f.literal('60', f.namedNode('http://www.w3.org/2001/XMLSchema#integer'))))
  // Every member the streams let go, to find what still points at one at the end (ret:Reference).
  const retired = watchRetired(h.runtime)
  const button = (text: string) => {
    const all = [...document.querySelectorAll('button, [role=tab]')]
    return (all.find((b) => b.textContent!.trim() === text) ?? all.find((b) => b.textContent!.trim().endsWith(text))) as HTMLElement
  }
  const field = () => document.querySelector('[data-sem-c=text-field] input') as HTMLInputElement
  // Each step is chosen by its turn k (no randomness), so the session repeats every PERIOD
  // events: the field's 7 lengths, 3 labels, 3 tabs and the toggles' 2 states, 6 steps a turn.
  // Measured at the same phase, the app and the change log's window are in the same state, and
  // any difference is something kept per event.
  const PERIOD = 6 * 42
  let k = 0
  const steps: (() => void)[] = [
    () => {
      const box = document.querySelector('[data-sem-c=list-item] input') as HTMLInputElement
      box.checked = !box.checked
      fire(box, 'change')
    },
    () => {
      field().value = field().value.length > 6 ? 'a' : field().value + 'a'
      fire(field(), 'input')
    },
    () => fire(document.querySelectorAll('[data-sem-c=list-item] label')[k % 3]!, 'mouseover'),
    () => fire(button(['Activity', 'Change log', 'Inspector'][k % 3]!), 'click'),
    () => fire(button('Toggle density'), 'click'),
    () => fire(document.querySelector('[data-sem-c=flippable] .sem-flip')!, 'click'),
  ]
  const times: number[] = []
  const run = (n: number) => {
    for (let i = 0; i < n; i++) {
      const t = performance.now()
      steps[i % steps.length]!()
      if (i % steps.length === steps.length - 1) k++
      times.push(performance.now() - t)
      h.runtime.warm(8)
    }
  }
  // End in the same visible state, so sizes are comparable.
  const settle = () => {
    fire(button('Inspector'), 'click')
    const flipped = document.querySelector('[data-sem-c=flippable] [data-flipped=true]')
    if (flipped) fire(document.querySelector('[data-sem-c=flippable] .sem-back .sem-flip')!, 'click')
  }
  const prefixed = (prefix: string, x: Record<string, number> | undefined) => Object.fromEntries(Object.entries(x ?? {}).map(([k, v]) => [prefix + k, v]))
  const store = h.store as typeof h.store & { termCount?(): number }
  let retained = 0
  const footprint = (): Record<string, number> => {
    // What the store holds beyond live state is given back first (Semblance's engines and N3: a
    // fresh copy), so its terms are the live ones: idle time collects them only once they have
    // grown by half, and a sample between collections would see garbage, not growth.
    h.store.compact?.()
    // Members each retained stream holds in memory, waiting to be stored, and recalled.
    retained = 0
    for (const s of h.runtime.retention.all()) {
      const x = s.figures()
      retained += x.inMemory + x.pending + x.recalled
    }
    return {
      triples: h.store.match(null, null, null).length,
      // The store's distinct terms, where it counts them (Semblance's engines; N3's are in store.*).
      ...(store.termCount ? { terms: store.termCount() } : {}),
      ...prefixed('engine.', h.screen.engine.footprint()),
      ...prefixed('index.', h.screen.index.footprint()),
      ...prefixed('dom.', h.shell.footprint()),
      ...prefixed('views.', h.runtime.views.footprint()),
      // The runtime's own caches and the store's term tables and host caches.
      ...prefixed('runtime.', h.runtime.footprint()),
      ...prefixed('store.', h.store.footprint?.()),
      // The host effects' own state: what the rendered state wrote, and the retained streams.
      ...prefixed('rendered.', h.rendered.footprint()),
      retained,
      log: h.bus.recent(10_000).length,
    }
  }
  /** The engine's WebAssembly memory, where it has one: it never shrinks, so it is a high-water mark. */
  const wasm = () => h.store.memoryBytes?.()
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!
  run(warmUp * PERIOD)
  settle()
  const warm = footprint()
  const wasmWarm = wasm()
  const early = median(times.slice(-300))
  // Sampled after every period, to see whether the memory stops growing.
  const wasmByPeriod: number[] = []
  for (let i = 0; i < measured; i++) {
    run(PERIOD)
    const w = wasm()
    if (w !== undefined) wasmByPeriod.push(w)
  }
  settle()
  const after = footprint()
  const late = median(times.slice(-300))
  const grew = Object.entries(after)
    .filter(([k, v]) => v > (warm[k] ?? 0) * 1.02 + 4)
    .map(([k, v]) => `${k}: ${warm[k]} -> ${v}`)
  // SOAK_LOG=<file> writes the figures.
  if (process.env.SOAK_LOG) {
    const mib = (b: number) => (b / 2 ** 20).toFixed(0)
    const pick = (x: Record<string, number>) => `${x.triples} triples, ${x.terms ?? x['store.terms']} terms, ${x['engine.refs']} refs, ${x['index.nodes']} index nodes`
    appendFileSync(process.env.SOAK_LOG, `${kind} (${prefer}), ${(warmUp + measured) * PERIOD} events: after warm-up ${pick(warm)}; at the end ${pick(after)}; ms per event ${early.toFixed(1)} -> ${late.toFixed(1)}${wasmByPeriod.length ? `; wasm MiB by period ${mib(wasmWarm!)} | ${wasmByPeriod.map(mib).join(' ')}` : ''}\n`)
  }
  return { h, warm, after, grew, early, late, wasmWarm, wasmByPeriod, events: (warmUp + measured) * PERIOD, retired, dangling: () => dangling(h.store, retired) }
}

/**
 * Leave out the reactions with no function (sem:function): a store with no SPARQL (N3) cannot
 * answer them. The site's own (the inspector's hover, ui:InspectOnHover) and its examples' are
 * written in SPARQL only.
 */
export function withoutSparqlOnly(store: GraphStore) {
  const f = store.factory
  const type = f.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')
  const reaction = f.namedNode('https://semblance.dev/ns/behaviour#Reaction')
  const fn = f.namedNode('https://semblance.dev/ns/core#function')
  for (const q of store.match(null, type, reaction)) if (!store.match(q.subject, fn, null).length) store.delete(q)
}
