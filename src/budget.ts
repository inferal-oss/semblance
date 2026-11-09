// Work budgets of authored content (ontology/layers/safety.ttl): a runtime that projects an
// authored graph takes its policy's budgets (Runtime.project), and a turn over one is suspended by
// the watchdog (src/engine/watchdog.ts). The host then stops it: the held work is dropped, as the
// watchdog's sem:Stop drops it (every derived triple still comes from a complete evaluation; what is
// left is counted out of date), and reports it as a Refused of kind "budget".
import type { Runtime } from './runtime.ts'
import { Refused } from './safety.ts'

/** What a turn over budget ran out of, in words: "took longer than 1500 ms". */
export function overBudget(runtime: Runtime): string {
  const wd = runtime.watchdog
  const limit = wd.stall?.limit ?? 'time'
  if (limit === 'evaluations') return `took more than ${wd.maxEvaluations} rule evaluations`
  if (limit === 'output') {
    const max = Math.min(...runtime.projections.map((p) => p.engine.maxDerived))
    return `derived more than ${max} triples`
  }
  return `took longer than ${wd.budgetMs} ms`
}

/**
 * Stop a turn over budget, if one is suspended: its held work is dropped, and what was refused is
 * returned (at: the root being rendered); undefined when nothing is held.
 */
export function stopOverBudget(runtime: Runtime, at: string): Refused | undefined {
  if (!runtime.held) return undefined
  const pending = runtime.watchdog.stall?.pending ?? runtime.held
  const message = `Stopped: authored content ${overBudget(runtime)}, and ${pending} renderings were left undone.`
  runtime.stopStall()
  return new Refused(at, 'budget', message)
}
