import { describe, expect, it, vi } from 'vitest'
import { EventBus, parseDuration } from '../src/behaviour/events.ts'
import { EX, todoReactions } from '../src/examples/todo.ts'
import { BEH, EVENTS_GRAPH, LDES, MOD, NS } from '../src/ns.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { setup } from './helpers.ts'

describe('change log (LDES)', () => {
  it('appends complete, immutable members and projects statistics over them', () => {
    const { store, runtime, screen } = setup('oxigraph')
    const text = runtime.project({ modality: MOD.Text, name: 'text' })
    const bus = new EventBus(runtime, screen, { functions: todoReactions })
    const f = store.factory
    const g = f.namedNode(EVENTS_GRAPH)
    const members = () => store.match(f.namedNode(BEH.ChangeLog), f.namedNode(LDES.member), null, g).map((q) => q.object)

    expect(toHTML(screen.index, EX + 'activity')).toContain('<dd>0</dd>')

    bus.emit(NS.beh + 'Click', EX + 'add') // empty field -> validation error (+1)
    bus.emit(NS.beh + 'Input', EX + 'newTodo', { value: 'Ship it' }) // value +1, error -1
    bus.emit(NS.beh + 'Input', EX + 'newTodo', { value: 'Ship it!' }) // value +1 -1
    bus.emit(NS.beh + 'Click', EX + 'add') // value -1, item +4

    expect(members()).toHaveLength(4)
    const first = members()[0]!
    const snapshot = store.match(first, null, null, g).length
    bus.emit(NS.beh + 'Click', EX + 'density')
    expect(store.match(first, null, null, g)).toHaveLength(snapshot)

    const html = toHTML(screen.index, EX + 'activity')
    expect(html).toContain('<h2>Activity</h2>')
    expect(html).toMatch(/<dt>events<\/dt><dd>5<\/dd>/)
    expect(html).toMatch(/<dt>components<\/dt><dd>3<\/dd>/)
    // Rows are ranked by count: two clicks on Add, two inputs, one density click.
    const kinds = [...html.matchAll(/<li style="--sem-share: (\d+)%"><span>([^<]+)<\/span><span>(\d+)<\/span><\/li>/g)].map((m) => `${m[2]}:${m[3]}:${m[1]}`)
    expect(kinds).toEqual(['Click:3:100', 'Input:2:67', 'Add:2:100', 'New todo:2:100', 'Toggle density:1:50'])
    expect(toText(text.index, EX + 'activity')).toMatch(/^# ACTIVITY: 5 events, \+\d+\/-\d+ triples$/)
  })

  it('retires members older than a duration policy', () => {
    expect(parseDuration('PT10M')).toBe(600_000)
    expect(parseDuration('P1DT1H')).toBe(90_000_000)
    const { store, runtime, screen } = setup('oxigraph')
    const f = store.factory
    const g = f.namedNode(EVENTS_GRAPH)
    const policy = f.namedNode(NS.beh + 'ChangeLogRetention')
    for (const q of store.match(policy, null, null)) store.delete(q)
    store.add(f.quad(policy, f.namedNode(NS.rdf + 'type'), f.namedNode(LDES.DurationAgoPolicy)))
    store.add(f.quad(policy, f.namedNode(NS.tree + 'value'), f.literal('PT10M', f.namedNode(NS.xsd + 'duration'))))
    const bus = new EventBus(runtime, screen, { functions: todoReactions })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      bus.emit(NS.beh + 'Click', EX + 'density')
      const [member] = store.match(f.namedNode(BEH.ChangeLog), f.namedNode(LDES.member), null, g).map((q) => q.object)
      vi.setSystemTime(Date.now() + 11 * 60_000)
      bus.emit(NS.beh + 'Click', EX + 'density')
      expect(store.match(f.namedNode(BEH.ChangeLog), f.namedNode(LDES.member), null, g)).toHaveLength(1)
      expect(store.match(member!, null, null, g)).toHaveLength(0)
      expect(toHTML(screen.index, EX + 'activity')).toMatch(/<dt>events<\/dt><dd>1<\/dd>/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps at most ldes:amount members and reads the newest from the head', () => {
    const { store, runtime, screen } = setup('oxigraph')
    const f = store.factory
    const g = f.namedNode(EVENTS_GRAPH)
    const policy = f.namedNode(NS.beh + 'ChangeLogRetention')
    for (const q of store.match(policy, f.namedNode(LDES.amount), null)) store.delete(q)
    store.add(f.quad(policy, f.namedNode(LDES.amount), f.literal('3', f.namedNode(NS.xsd + 'integer'))))
    const bus = new EventBus(runtime, screen, { functions: todoReactions })
    for (let i = 0; i < 5; i++) bus.emit(NS.beh + 'Input', EX + 'newTodo', { value: 'v' + i })
    const members = store.match(f.namedNode(BEH.ChangeLog), f.namedNode(LDES.member), null, g)
    expect(members).toHaveLength(3)
    const values = bus.recent(10).map((quads) => quads.find((q) => q.predicate.value === BEH.value)?.object.value)
    expect(values).toEqual(['v4', 'v3', 'v2'])
    expect(toHTML(screen.index, EX + 'activity')).toMatch(/<dt>events<\/dt><dd>3<\/dd>/)
  })
})
