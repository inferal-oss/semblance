import { describe, expect, it } from 'vitest'
import { ManualClock } from '../src/behaviour/clock.ts'
import { EventBus } from '../src/behaviour/events.ts'
import { Scheduler } from '../src/behaviour/schedule.ts'
import { loadStore } from '../src/node/load.ts'
import { MOD } from '../src/ns.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/later#'

/** A counter that ticks every second while it is "shown": time as data, beh:dueAt and beh:Due. */
function ticking(shown: () => boolean) {
  const store = loadStore(
    'oxigraph',
    `@prefix ex: <${EX}> . @prefix beh: <https://semblance.dev/ns/behaviour#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix c: <https://semblance.dev/ns/component#> .
ex:ticker ex:count 0 ; beh:dueAt "2026-01-01T09:00:01Z"^^xsd:dateTime ; beh:dueWhileShown ex:view .
ex:Tick a beh:Reaction ; beh:when beh:Due ; beh:source ex:ticker ;
  beh:deletes """PREFIX ex: <${EX}> CONSTRUCT { ex:ticker ex:count ?n } WHERE { ex:ticker ex:count ?n }""" ;
  beh:inserts """PREFIX ex: <${EX}>
CONSTRUCT { ex:ticker ex:count ?next ; beh:dueAt ?later }
WHERE { ex:ticker ex:count ?n . $event beh:at ?at BIND(?n + 1 AS ?next)
        BIND(xsd:dateTime(?at) AS ?now) BIND(xsd:duration("PT1S") AS ?wait) BIND(IF(?next < 5, ?now + ?wait, ?none) AS ?later) }""" .`,
  )
  const runtime = new Runtime(store)
  const screen = runtime.project({ modality: MOD.Screen, name: 'screen' })
  const clock = new ManualClock()
  const bus = new EventBus(runtime, screen, { clock })
  const scheduler = new Scheduler(bus, { shown: () => shown() })
  scheduler.attach()
  const f = store.factory
  const count = () => Number(store.match(f.namedNode(EX + 'ticker'), f.namedNode(EX + 'count'), null)[0]!.object.value)
  return { store, runtime, clock, scheduler, count }
}

describe('things due later (beh:dueAt)', () => {
  it('turn into beh:Due events on the clock, one timer for the earliest', () => {
    const h = ticking(() => true)
    expect(h.count()).toBe(0)
    h.clock.advance(999)
    expect(h.count()).toBe(0)
    h.clock.advance(1)
    expect(h.count()).toBe(1)
    expect(h.scheduler.pending()).toHaveLength(1) // the reaction set the next time
    h.clock.advance(10_000)
    expect(h.count()).toBe(5) // and stopped: the last tick set no new time, so the due time is spent
    expect(h.scheduler.pending()).toEqual([])
  })

  it('wait, past their time, while what they are due for is not shown', () => {
    let shown = false
    const h = ticking(() => shown)
    h.clock.advance(5000)
    expect(h.count()).toBe(0)
    expect(h.scheduler.pending()[0]!.waiting).toBe(true)
    shown = true
    // Any input change makes it look again.
    const f = h.store.factory
    h.runtime.apply({ remove: [], add: [f.quad(f.namedNode(EX + 'page'), f.namedNode(EX + 'shown'), f.literal('yes'))] })
    h.clock.advance(0)
    expect(h.count()).toBe(1)
  })
})
