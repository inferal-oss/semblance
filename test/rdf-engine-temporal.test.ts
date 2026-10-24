// Dates, times and durations on the rdf-engine builds: XPath's operators
// (op:add-dayTimeDuration-to-dateTime, op:subtract-dateTimes, ...). Where
// Oxigraph computes a value it is the same; where it gives none (duration
// times or by a number, a date plus a dayTimeDuration, a time plus a duration)
// the value is XPath's. A value without a timezone is in UTC (the implicit timezone).
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { wasmTarget } from '../rdf-engine/conformance/targets/wasm.ts'

const built = (['rust', 'wat'] as const).filter((k) => existsSync(new URL(`../rdf-engine/build/${k}.wasm`, import.meta.url)))

const dt = (s: string) => `"${s}"^^xsd:dateTime`
const d = (s: string) => `"${s}"^^xsd:date`
const t = (s: string) => `"${s}"^^xsd:time`
const dtd = (s: string) => `"${s}"^^xsd:dayTimeDuration`
const ymd = (s: string) => `"${s}"^^xsd:yearMonthDuration`
const dur = (s: string) => `"${s}"^^xsd:duration`

/** Expression, and its value as `lexical^^local datatype` (undefined: an error, so unbound). */
const CASES: [string, string | undefined][] = [
  // dateTime ± duration
  [`${dt('2026-01-31T23:59:59Z')} + ${dtd('PT2S')}`, '2026-02-01T00:00:01Z^^dateTime'],
  [`${dtd('PT2S')} + ${dt('2026-01-31T23:59:59Z')}`, '2026-02-01T00:00:01Z^^dateTime'],
  [`${dt('2026-01-31T23:59:59Z')} + ${dur('PT2S')}`, '2026-02-01T00:00:01Z^^dateTime'],
  [`${dt('2026-12-31T23:00:00Z')} + ${dur('P1Y2M3DT4H')}`, '2028-03-04T03:00:00Z^^dateTime'],
  [`${dt('2026-01-31T10:00:00')} + ${ymd('P1M')}`, '2026-02-28T10:00:00^^dateTime'],
  [`${dt('2024-03-31T00:00:00Z')} - ${ymd('P1M')}`, '2024-02-29T00:00:00Z^^dateTime'],
  [`${dt('2026-01-31T10:00:00+02:00')} - ${dtd('P1DT1H')}`, '2026-01-30T09:00:00+02:00^^dateTime'],
  [`${dt('2026-01-01T00:00:00.5Z')} + ${dtd('PT0.25S')}`, '2026-01-01T00:00:00.75Z^^dateTime'],
  [`${dt('2026-01-01T00:00:00Z')} - ${dtd('PT0.5S')}`, '2025-12-31T23:59:59.5Z^^dateTime'],
  [`${dt('2026-01-01T00:00:00Z')} + ${dtd('-P400D')}`, '2024-11-27T00:00:00Z^^dateTime'],
  // dateTime − dateTime
  [`${dt('2026-03-01T00:00:00Z')} - ${dt('2026-02-01T12:00:00Z')}`, 'P27DT12H^^dayTimeDuration'],
  [`${dt('2026-01-01T00:00:00Z')} - ${dt('2026-01-01T00:00:00Z')}`, 'PT0S^^dayTimeDuration'],
  [`${dt('2026-01-01T12:00:00+02:00')} - ${dt('2026-01-01T12:00:00Z')}`, '-PT2H^^dayTimeDuration'],
  [`${dt('2026-01-01T12:00:00')} - ${dt('2026-01-01T10:00:00Z')}`, 'PT2H^^dayTimeDuration'],
  // dates and times
  [`${d('2024-02-29Z')} - ${d('2024-01-01Z')}`, 'P59D^^dayTimeDuration'],
  [`${d('2026-03-31')} - ${ymd('P1M')}`, '2026-02-28^^date'],
  [`${d('2024-02-29')} + ${ymd('P1Y')}`, '2025-02-28^^date'],
  [`${d('2026-01-01')} + ${dtd('PT36H')}`, '2026-01-02^^date'],
  [`${d('2026-01-01Z')} - ${dtd('PT1H')}`, '2025-12-31Z^^date'],
  [`${t('10:00:00')} - ${t('08:30:00')}`, 'PT1H30M^^dayTimeDuration'],
  [`${t('23:30:00')} + ${dtd('PT45M')}`, '00:15:00^^time'],
  [`${t('23:30:00')} + ${ymd('P1M')}`, undefined],
  // durations
  [`${dtd('-P1D')} + ${dtd('PT1H')}`, '-PT23H^^dayTimeDuration'],
  [`${dtd('PT90M')} + ${dtd('PT0S')}`, 'PT1H30M^^dayTimeDuration'],
  [`${ymd('P1Y')} + ${ymd('P3M')}`, 'P1Y3M^^yearMonthDuration'],
  [`${ymd('P1M')} - ${ymd('P1M')}`, 'P0M^^yearMonthDuration'],
  [`${dtd('PT1H')} - ${dtd('PT1H')}`, 'PT0S^^dayTimeDuration'],
  [`${dtd('PT1H')} + ${ymd('P1M')}`, 'P1MT1H^^duration'],
  [`${dtd('-PT1H')} + ${ymd('P1M')}`, undefined],
  [`-${dtd('PT1H')}`, '-PT1H^^dayTimeDuration'],
  [`${dtd('PT1H')} * 2`, 'PT2H^^dayTimeDuration'],
  [`2 * ${dtd('PT1H')}`, 'PT2H^^dayTimeDuration'],
  [`${dtd('PT1H')} * 1.5`, 'PT1H30M^^dayTimeDuration'],
  [`${dtd('PT1H')} / 4`, 'PT15M^^dayTimeDuration'],
  [`${dtd('P0D')} * 3`, 'PT0S^^dayTimeDuration'],
  [`${dtd('PT1H')} / ${dtd('PT30M')}`, '2^^decimal'],
  [`${dtd('PT1H')} / 0`, undefined],
  [`${ymd('P1Y')} * 1.5`, 'P1Y6M^^yearMonthDuration'],
  [`${ymd('P1Y')} / 5`, 'P2M^^yearMonthDuration'],
  [`${ymd('P1Y')} / ${ymd('P3M')}`, '4^^decimal'],
  [`${dt('2026-01-01T00:00:00Z')} + ${dt('2026-01-01T00:00:00Z')}`, undefined],
  // comparisons
  [`${dtd('PT1H')} < ${dtd('PT2H')}`, 'true^^boolean'],
  [`${dtd('PT24H')} = ${dtd('P1D')}`, 'true^^boolean'],
  [`${ymd('P1Y')} = ${ymd('P12M')}`, 'true^^boolean'],
  [`${dur('P1Y')} = ${ymd('P12M')}`, 'true^^boolean'],
  [`${ymd('P1Y')} < ${ymd('P13M')}`, 'true^^boolean'],
  [`${dtd('PT1H')} < ${ymd('P1M')}`, undefined],
  [`${t('10:00:00')} < ${t('11:00:00')}`, 'true^^boolean'],
  [`${t('10:00:00')} = ${t('10:00:00')}`, 'true^^boolean'],
  // what Semblance's reactions do with beh:dueAt
  [`NOW() + ${dtd('PT2S')} > NOW()`, 'true^^boolean'],
]

describe.skipIf(!built.length).each(built)('%s engine: dates, times and durations', async (kind) => {
  const target = await wasmTarget(kind)
  it.each(CASES)('%s', (expr, want) => {
    const q = `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\nSELECT ?x { BIND(${expr} AS ?x) }`
    const r = target.query({ default: [], named: [] }, q, 'http://example/')
    if (r.kind !== 'bindings') throw new Error('expected bindings')
    const v = r.rows[0]?.get('x') as { v: string; dt?: string } | undefined
    expect(v ? `${v.v}^^${(v.dt ?? '').replace(/.*#/, '')}` : undefined).toBe(want)
  })
})
