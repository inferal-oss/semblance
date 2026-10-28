import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { EventBus } from '../src/behaviour/events.ts'
import { loadStore, type StoreKind } from '../src/node/load.ts'
import { A11Y, MOD, NS, STY, VAL } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { toHTML, toText } from '../src/render/serialize.ts'
import { Runtime } from '../src/runtime.ts'
import { compileStyles } from '../src/style/compile.ts'

const EX = 'https://example.org/series#'
const prefixes = `@prefix ex: <${EX}> . @prefix c: <${NS.c}> . @prefix beh: <${NS.beh}> . @prefix ord: <${NS.ord}> .`
const graph = `${prefixes}
ex:page a c:Stack ; c:children ( ex:chart ex:change ) .
ex:chart a c:Sparkline ; c:label "CPU" , "ЦП"@uk , "Prozessor"@de , "المعالج"@ar ; c:unit "%" ;
  c:start 0 ; c:end 4 ; c:min -10 ; c:max 10 ; c:point ex:p0, ex:p1, ex:p2, ex:p3, ex:p4 .
ex:p0 c:start 0 ; c:value -10 ; c:label "00:00" ; ord:immediatelyPrecedes ex:p1 .
ex:p1 c:start 1 ; c:value 0 ; c:label "00:01" ; ord:immediatelyPrecedes ex:p2 .
ex:p2 c:start 2 ; c:label "00:02" ; ord:immediatelyPrecedes ex:p3 .
ex:p3 c:start 3 ; c:value 10 ; c:label "00:03" .
ex:p4 c:start 4 ; c:value 0 ; c:label "00:04" .
ex:change a c:Button ; c:label "Receive sample" .
ex:Update a beh:Reaction ; beh:when beh:Click ; beh:source ex:change ;
  beh:inserts "CONSTRUCT { <${EX}p2> c:value 5 } WHERE {}" .`

function mount(kind: StoreKind = 'wat', prefer: 'sparql' | 'function' = 'sparql', languages = ['en'], source = graph, beforeRuntime?: (store: ReturnType<typeof loadStore>) => void) {
  const store = loadStore(kind, source)
  beforeRuntime?.(store)
  const runtime = new Runtime(store)
  const projection = runtime.project({ modality: MOD.Screen, prefer, languages, layers: [STY.Layer, A11Y.Layer], roots: [EX + 'page'], name: 'screen' }, (e) => { throw e })
  const { document, window } = parseHTML('<html><body><main></main></body></html>')
  const renderer = new DomRenderer(projection.index, document.querySelector('main')!, EX + 'page'); renderer.flush()
  const bus = new EventBus(runtime, projection, { prefer }); bus.attach(renderer, () => renderer.flush())
  const set = (subject: string, property: string, value?: string | number) => {
    const f = store.factory, s = f.namedNode(EX + subject), p = f.namedNode(NS.c + property)
    runtime.apply({ remove: store.match(s, p, null), add: value === undefined ? [] : [f.quad(s, p, typeof value === 'number' ? f.literal(String(value), f.namedNode(NS.xsd + 'integer')) : f.namedNode(value))] }); renderer.flush()
  }
  return { store, runtime, projection, renderer, document, window, bus, set,
    html: () => toHTML(projection.index, EX + 'page'),
    click: () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Receive sample')!.dispatchEvent(new window.Event('click', { bubbles: true })) }
}

describe('explicit linear sparkline', () => {
  for (const kind of ['wat', 'oxigraph'] as const) it(`${kind}: zero and signed values are plotted, unknowns and missing adjacency are genuine gaps`, () => {
    const h = mount(kind)
    expect(h.document.querySelectorAll('circle')).toHaveLength(4)
    expect(h.document.querySelectorAll('line')).toHaveLength(1)
    const dots = [...h.document.querySelectorAll('circle')]
    expect(dots.map((dot) => dot.getAttribute('cy'))).toEqual(['194', '100', '6', '100'])
    expect(h.document.querySelector('svg')?.getAttribute('aria-label')).toBe('CPU')
    expect([...h.document.querySelectorAll('li')].map((n) => n.textContent)).toEqual(['00:00: -10 %', '00:01: 0 %', '00:02: unavailable', '00:03: 10 %', '00:04: 0 %'])
    expect([...h.document.querySelectorAll('button')].find((button) => button.textContent === 'Samples')?.textContent).toBe('Samples')
    // Actual RDF event supplies the missing sample; it reconnects only explicit edges.
    h.click()
    expect(h.store.match(h.store.factory.namedNode(EX + 'p2'), h.store.factory.namedNode(NS.c + 'value'), null)[0]?.object.value).toBe('5')
    expect(h.document.querySelectorAll('circle')).toHaveLength(5)
    expect(h.document.querySelectorAll('line')).toHaveLength(3)
    h.set('p2', 'value')
    expect(h.document.querySelectorAll('line')).toHaveLength(1)
  })

  for (const kind of ['wat', 'oxigraph'] as const) it(`${kind}: keeps byte-identical SPARQL/function HTML after input, missing value, bounds and membership changes`, () => {
    const both = (['sparql', 'function'] as const).map((prefer) => mount(kind, prefer))
    const same = () => expect(both[0]!.html()).toBe(both[1]!.html())
    same(); for (const h of both) h.set('chart', 'end', 7); same()
    for (const h of both) h.click(); same()
    for (const h of both) h.set('p2', 'value'); same()
    for (const h of both) h.set('chart', 'max', 20); same()
    for (const h of both) h.set('chart', 'point'); same()
  })

  for (const [language, label, samples, unknown] of [
    ['en', 'CPU', 'Samples', 'unavailable'], ['uk', 'ЦП', 'Вимірювання', 'недоступно'], ['de', 'Prozessor', 'Messwerte', 'nicht verfügbar'], ['ar', 'المعالج', 'القياسات', 'غير متاح']
  ]) it(`${language}: labels and accessible exact readings follow the viewer, with parity`, () => {
    const both = (['sparql', 'function'] as const).map((prefer) => mount('wat', prefer, [language!]))
    expect(both[0]!.html()).toBe(both[1]!.html())
    expect(both[0]!.document.querySelector('figcaption')?.textContent).toBe(label)
    expect([...both[0]!.document.querySelectorAll('button')].find((button) => button.textContent === samples)?.textContent).toBe(samples)
    expect(both[0]!.document.querySelectorAll('li')[2]?.textContent).toBe('00:02: ' + unknown)
  })

  it('composes the stock disclosure and records its open state through RDF events', () => {
    const h = mount()
    expect(h.document.querySelector('ol')?.getAttribute('tabindex')).toBe('0')
    const disclosure = [...h.document.querySelectorAll('button')].find((button) => button.textContent === 'Samples')!
    disclosure.dispatchEvent(new h.window.Event('click', { bubbles: true }))
    expect(h.store.match(h.store.factory.namedNode(EX + 'chart/~details'), h.store.factory.namedNode(NS.c + 'expanded'), null)[0]?.object.value).toBe('true')
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    h.click()
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    disclosure.dispatchEvent(new h.window.Event('click', { bubbles: true }))
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  })

  it('Text modality preserves the same exact known zero and unavailable readings', () => {
    for (const prefer of ['sparql', 'function'] as const) {
      const h = mount('wat', prefer)
      const text = h.runtime.project({ modality: MOD.Text, prefer, roots: [EX + 'chart'], name: 'text' }, (e) => { throw e })
      const rendered = toText(text.index, EX + 'chart')
      expect(rendered).toContain('00:01: 0 %'); expect(rendered).toContain('00:02: unavailable'); expect(rendered).toContain('00:00: -10 %')
    }
  })

  it('refuses invalid extents, non-finite data and excessive input rather than truncating or clamping', () => {
    const h = mount()
    h.set('chart', 'max', -10)
    expect(h.document.querySelectorAll('circle')).toHaveLength(0)
    expect(h.document.querySelector('figure')?.textContent).toContain('Unable to plot')
    h.set('chart', 'max', 10); h.set('p0', 'value', -100)
    expect(h.document.querySelectorAll('circle')).toHaveLength(3)
    expect(h.document.querySelectorAll('line')).toHaveLength(0)
    const f = h.store.factory, sample = f.namedNode(EX + 'p0'), value = f.namedNode(NS.c + 'value')
    for (const lexical of ['NaN', 'INF', '1e101']) {
      h.runtime.apply({ remove: h.store.match(sample, value, null), add: [f.quad(sample, value, f.literal(lexical, f.namedNode(NS.xsd + 'double')))] }); h.renderer.flush()
      expect(h.document.querySelectorAll('circle')).toHaveLength(3)
      expect(h.document.querySelector('li')?.textContent).toBe('00:00: unavailable')
    }
    h.set('chart', 'point')
    expect(h.document.querySelector('figure')?.textContent).toContain('No samples.')
    const huge = mount('wat', 'sparql', ['en'], `${prefixes}
      ex:page a c:Stack ; c:children ( ex:chart ) .
      ex:chart a c:Sparkline ; c:label "Bounded" ; c:start 0 ; c:end 600 ; c:min 0 ; c:max 1 ; c:point ${Array.from({ length: 513 }, (_, i) => `ex:q${i}`).join(', ')} .
      ${Array.from({ length: 513 }, (_, i) => `ex:q${i} c:start ${i} ; c:value 0 .`).join('\n')}`)
    expect(huge.document.querySelector('figure')?.textContent).toContain('at most 512')
    expect(huge.document.querySelectorAll('circle')).toHaveLength(0)
    expect(huge.document.querySelectorAll('li')).toHaveLength(0)
  })

  it('an ordinary sample update changes only its mark and predecessor, independently of unrelated graph size', () => {
    const runs = [20, 200].map((count) => {
      const source = `${prefixes} ex:page a c:Stack ; c:children ( ex:chart ex:change ) .
        ex:chart a c:Sparkline ; c:label "Fixed window" ; c:start 0 ; c:end 200 ; c:min 0 ; c:max 10 ; c:point ${Array.from({ length: count }, (_, i) => `ex:q${i}`).join(', ')} .
        ${Array.from({ length: count }, (_, i) => `ex:q${i} c:start ${i} ; c:value 0 ${i + 1 < count ? `; ord:immediatelyPrecedes ex:q${i + 1}` : ''} .`).join('\n')}`
      const h = mount('wat', 'sparql', ['en'], source), before = h.projection.engine.stats.ruleRuns
      h.set('q10', 'value', 5)
      return h.projection.engine.stats.ruleRuns - before
    })
    expect(runs[0]).toBe(runs[1]); expect(runs[0]).toBeLessThan(10)
  })

  it('uses stock tokens and a scalable SVG with no fixed minimum width or RTL geometry reversal', () => {
    const h = mount(), css = compileStyles(h.store)
    expect(css).toContain('var(--sem-accent)'); expect(css).toContain('min-inline-size: 0')
    expect(css).toContain('inline-size: 100%'); expect(css).toContain('direction: ltr')
    expect(h.document.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 1000 200')
  })
})


describe.each(['wat', 'oxigraph'] as const)('current chart vocabulary and localization (%s)', (kind) => {
  it('keeps translated units and sample labels identical through live regional language changes', () => {
    const source = graph.replace('c:unit "%"', 'c:unit "cores"@en, "Kerne"@de, "ядра"@uk, "أنوية"@ar')
      .replace('c:label "00:00"', 'c:label "Midnight"@en, "Mitternacht"@de, "Північ"@uk, "منتصف الليل"@ar')
    const both = (['sparql', 'function'] as const).map(prefer => {
      const h = mount(kind, prefer, ['en-US'], source)
      const text = h.runtime.project({ modality: MOD.Text, prefer, languages: ['en-US'], roots: [EX + 'chart'], name: 'text' }, e => { throw e })
      return { ...h, text }
    })
    for (const [language, unit, name] of [
      ['en-US', 'cores', 'Midnight'], ['de-AT', 'Kerne', 'Mitternacht'],
      ['uk-UA', 'ядра', 'Північ'], ['ar-EG', 'أنوية', 'منتصف الليل'],
    ]) {
      for (const h of both) {
        h.projection.engine.reconfigure({ languages: [language!] })
        h.text.engine.reconfigure({ languages: [language!] })
        h.renderer.flush()
        expect(h.document.querySelector('li')?.textContent).toBe(`${name}: -10 ${unit}`)
        expect(h.document.querySelectorAll('li')[1]?.textContent).toBe(`00:01: 0 ${unit}`)
        expect(toText(h.text.index, EX + 'chart')).toContain(`${name}: -10 ${unit}`)
      }
      expect(both[0]!.html()).toBe(both[1]!.html())
      expect(toHTML(both[0]!.text.index, EX + 'chart')).toBe(toHTML(both[1]!.text.index, EX + 'chart'))
    }
  })

  it('shares one chart-member property while Gantt and Sparkline retain distinct projections', () => {
    const source = graph.replace('c:children ( ex:chart ex:change )', 'c:children ( ex:chart ex:change ex:gantt )') + `
@prefix sem: <${NS.sem}> . @prefix iv: <${NS.iv}> . @prefix xsd: <${NS.xsd}> .
ex:task ex:taskLabel "Release task" ; ex:taskStart "2026-01-02"^^xsd:date ; ex:taskEnd "2026-01-05"^^xsd:date .
ex:plan a sem:View, iv:View ; iv:materialize iv:Graph ; sem:select """SELECT ?task ?label ?start ?end WHERE {
  ?task <${EX}taskLabel> ?label ; <${EX}taskStart> ?start ; <${EX}taskEnd> ?end
} ORDER BY ?start""" .
ex:gantt a c:GanttChart ; c:label "Release plan" ; c:view ex:plan ; c:today "2026-01-03"^^xsd:date .`
    const both = (['sparql', 'function'] as const).map(prefer => mount(kind, prefer, ['en'], source))
    for (const h of both) {
      const f = h.store.factory, property = f.namedNode(NS.c + 'inChart')
      const domain = f.namedNode('http://www.w3.org/2000/01/rdf-schema#domain')
      expect(h.store.match(property, domain, null).map(q => q.object.value)).toEqual([NS.sem + 'Component'])
      const members = (chart: string) => h.store.match(null, property, f.namedNode(EX + chart)).map(q => q.subject)
      const hasType = (node: (ReturnType<typeof members>)[number], type: string) => h.store.match(node, f.namedNode(NS.rdf + 'type'), f.namedNode(NS.c + type)).length > 0
      expect(members('chart')).toHaveLength(5)
      expect(members('chart').every(node => hasType(node, 'SparklinePoint') && !hasType(node, 'GanttTask'))).toBe(true)
      expect(members('gantt')).toHaveLength(1)
      expect(members('gantt').every(node => hasType(node, 'GanttTask') && !hasType(node, 'SparklinePoint'))).toBe(true)
      expect(h.document.querySelector('[data-sem-c="gantt-chart"]')?.textContent).toContain('Release task')
      expect(h.document.querySelectorAll('circle')).toHaveLength(4)
      h.set('p2', 'value', 5)
      expect(h.document.querySelectorAll('circle')).toHaveLength(5)
      expect(h.document.querySelector('[data-sem-c="gantt-chart"]')?.textContent).toContain('Release task')
    }
    expect(both[0]!.html()).toBe(both[1]!.html())
  })
})


// Component acceptance waits for the shared numeric dependency and fresh images.
// Do not skip a missing native backend: these are required composition gates.
const typed = (lexical: string, family: string) => `${JSON.stringify(lexical)}^^xsd:${family}`
const numericChart = (id: string, change: Partial<Record<'start' | 'end' | 'min' | 'max' | 'x' | 'value', string>> = {}) => {
  const v = { start: '0', end: '4', min: '-10', max: '10', x: '1', value: '0', ...change }
  return `ex:${id} a c:Sparkline ; c:label "${id}" ; c:start ${v.start} ; c:end ${v.end} ; c:min ${v.min} ; c:max ${v.max} ; c:point ex:${id}p .
ex:${id}p c:start ${v.x} ; c:value ${v.value} .`
}
const numericPage = (charts: readonly [string, Partial<Record<'start' | 'end' | 'min' | 'max' | 'x' | 'value', string>>][]) => `${prefixes}
@prefix xsd: <${NS.xsd}> .
ex:page a c:Stack ; c:children (${charts.map(([id]) => 'ex:' + id).join(' ')}) .
${charts.map(([id, value]) => numericChart(id, value)).join('\n')}`
const numericFamilies = ['integer', 'decimal', 'float', 'double', 'long', 'int', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte'] as const
const familyCharts = numericFamilies.map((family): [string, Partial<Record<'start' | 'end' | 'min' | 'max' | 'x' | 'value', string>>] => {
  const negative = family === 'negativeInteger' || family === 'nonPositiveInteger'
  return [family, { start: typed(negative ? '-5' : '1', family), end: typed(negative ? '-1' : '5', family), x: typed(negative ? '-3' : '3', family), value: typed(negative ? '-2' : '2', family) }]
})
const figure = (h: ReturnType<typeof mount>, id: string) => [...h.document.querySelectorAll('figure')].find(el => el.querySelector('figcaption')?.textContent === id)!

// These assertions inspect ingestion before Runtime exists. They do not ask
// the numeric helper or rendered output to manufacture the expected RDF term.
function storedLiteral(store: ReturnType<typeof loadStore>, id: string, property: string) {
  const f = store.factory, terms = store.match(f.namedNode(EX + id), f.namedNode(NS.c + property), null)
  expect(terms).toHaveLength(1)
  const term = terms[0]!.object
  if (term.termType !== 'Literal') throw Error('Expected one stored literal on ' + id + '/' + property)
  return [term.datatype.value.slice(NS.xsd.length), term.value]
}
const originalLiteral = (store: ReturnType<typeof loadStore>, id: string, property: string, family: string, lexical: string) =>
  expect(storedLiteral(store, id, property)).toEqual([family, lexical])

// Retaining engines must keep all sixteen original datatype/lexical contracts.
// The foreign store's independently observed canonical graph is tested below.
describe.each(['wat', 'rust'] as const)('retaining native binary geometry (%s)', kind => {
  const twins = (source: string, beforeRuntime?: (store: ReturnType<typeof loadStore>) => void) => (['sparql', 'function'] as const).map(prefer => mount(kind, prefer, ['en'], source, beforeRuntime))
  it('retains all sixteen families, direct float32 widening, and XML whitespace without rewriting readings', () => {
    const charts = [...familyCharts, ['xmlDecimal', { x: typed(' \t3\r\n', 'decimal'), value: typed(' \t2\r\n', 'decimal') }], ['xmlFloat', { x: typed(' \t3\r\n', 'float'), value: typed(' \t2\r\n', 'float') }]] as Parameters<typeof numericPage>[0]
    const source = numericPage(charts) + '\n' + familyCharts.map(([family]) => {
      const negative = family === 'negativeInteger' || family === 'nonPositiveInteger'
      return `ex:${family} c:point ex:${family}next . ex:${family}p ord:immediatelyPrecedes ex:${family}next .
ex:${family}next c:start ${typed(negative ? '-2' : '4', family)} ; c:value ${typed(negative ? '-1' : '3', family)} .`
    }).join('\n')
    const both = twins(source, store => {
      for (const family of numericFamilies) {
        const negative = family === 'negativeInteger' || family === 'nonPositiveInteger'
        originalLiteral(store, family, 'start', family, negative ? '-5' : '1')
        originalLiteral(store, family, 'end', family, negative ? '-1' : '5')
        originalLiteral(store, family + 'p', 'start', family, negative ? '-3' : '3')
        originalLiteral(store, family + 'p', 'value', family, negative ? '-2' : '2')
      }
      originalLiteral(store, 'xmlDecimalp', 'value', 'decimal', ' \t2\r\n')
      originalLiteral(store, 'xmlFloatp', 'value', 'float', ' \t2\r\n')
    })
    expect(both[0]!.html()).toBe(both[1]!.html())
    for (const h of both) {
      for (const [id] of charts) {
        const hasNext = (numericFamilies as readonly string[]).includes(id)
        expect(figure(h, id).querySelectorAll('circle'), id).toHaveLength(hasNext ? 2 : 1)
        expect(figure(h, id).querySelectorAll('line'), id).toHaveLength(hasNext ? 1 : 0)
      }
      for (const [family] of familyCharts) {
        expect(figure(h, family).querySelector('circle')?.getAttribute('cx')).toBe('500')
        expect(figure(h, family).querySelector('li')?.textContent).toBe(`${family.startsWith('nonPositive') || family === 'negativeInteger' ? '-3: -2' : '3: 2'}`)
      }
      // The original graph lexical spelling, including XML whitespace, is the reading.
      expect(figure(h, 'xmlDecimal').querySelector('li')?.textContent).toBe(' \t3\r\n:  \t2\r\n')
    }
  })

  it('normalizes before arithmetic and preserves exact source text at binary64, float32 and underflow boundaries', () => {
    const tiny = '0.' + '0'.repeat(399) + '1'
    const source = numericPage([
      ['wide', { start: typed('1000000000000000000', 'integer'), end: typed('1000000000000000256', 'integer'), x: typed('1000000000000000065', 'unsignedLong') }],
      ['single', { min: '1', max: typed('1.00000011920928955078125', 'double'), value: typed('1.0000000596046448', 'float') }],
      ['underflowSample', { min: '0', max: '1', value: typed(tiny, 'decimal') }],
    ])
    const both = twins(source, store => {
      originalLiteral(store, 'widep', 'start', 'unsignedLong', '1000000000000000065')
      originalLiteral(store, 'singlep', 'value', 'float', '1.0000000596046448')
      originalLiteral(store, 'underflowSamplep', 'value', 'decimal', tiny)
    })
    expect(both[0]!.html()).toBe(both[1]!.html())
    for (const h of both) {
      expect(figure(h, 'wide').querySelector('circle')?.getAttribute('cx')).toBe('500')
      expect(figure(h, 'wide').querySelector('li')?.textContent).toBe('1000000000000000065: 0')
      expect(figure(h, 'single').querySelector('circle')?.getAttribute('cy')).toBe('6')
      expect(figure(h, 'single').querySelector('li')?.textContent).toBe('1: 1.0000000596046448')
      expect(figure(h, 'underflowSample').querySelector('circle')?.getAttribute('cy')).toBe('194')
      expect(figure(h, 'underflowSample').querySelector('li')?.textContent).toBe('1: ' + tiny)
    }
  })

  it('refuses distinct bounds that collapse through binary64, float32 or underflow, and refuses two raw bounds', () => {
    const tiny = '0.' + '0'.repeat(399) + '1'
    const source = numericPage([
      ['integerCollapse', { start: typed('9007199254740992', 'integer'), end: typed('9007199254740993', 'integer') }],
      ['floatCollapse', { start: typed('1', 'float'), end: typed('1.00000001', 'float') }],
      ['tinyCollapse', { start: '0', end: typed(tiny, 'decimal') }],
      ['zeroCollapse', { start: typed('-0', 'double'), end: typed('+0', 'double') }],
      ['twoRawBounds', {}], ['sameFamilyTwoRawBounds', { start: typed('-0', 'integer') }], ['fourMultiBounds', {}],
    ]) + '\nex:twoRawBounds c:start "0"^^xsd:double . ex:sameFamilyTwoRawBounds c:start 0 .' + '\n' + ['start', 'end', 'min', 'max'].map(property => `ex:fourMultiBounds c:${property} ${Array.from({ length: 16 }, (_, i) => String(i + 20)).join(', ')} .`).join('\n')
    const both = twins(source, store => {
      originalLiteral(store, 'integerCollapse', 'start', 'integer', '9007199254740992')
      originalLiteral(store, 'integerCollapse', 'end', 'integer', '9007199254740993')
      const f = store.factory
      expect(store.match(f.namedNode(EX + 'sameFamilyTwoRawBounds'), f.namedNode(NS.c + 'start'), null)
        .map(q => q.object.value).sort()).toEqual(['-0', '0'])
    })
    expect(both[0]!.html()).toBe(both[1]!.html())
    for (const h of both) for (const id of ['integerCollapse', 'floatCollapse', 'tinyCollapse', 'zeroCollapse', 'twoRawBounds', 'sameFamilyTwoRawBounds', 'fourMultiBounds']) {
      expect(figure(h, id).querySelector('svg'), id).toBeNull()
      expect(figure(h, id).textContent).toContain('Unable to plot')
    }
  })

  it('treats invalid lexical/subtype/nonfinite samples as unavailable and invalid bounds as a visible refusal', () => {
    const invalid: readonly [string, string][] = [['decimal', '0x10'], ['decimal', ' '], ['decimal', '1e2'], ['integer', '1.0'], ['float', 'Infinity'], ['double', 'NaN'], ['double', 'INF'], ['double', '+NaN'], ['double', '1e101'], ['double', '\u00a01'], ['double', '1\u00a0'], ['byte', '128'], ['unsignedByte', '-1'], ['unsignedByte', '256'], ['positiveInteger', '0'], ['negativeInteger', '-0'], ['nonPositiveInteger', '1'], ['int', '2147483648']]
    const charts = invalid.flatMap(([family, lexical], index) => [[`sample${index}`, { value: typed(lexical, family) }], [`bound${index}`, { start: typed(lexical, family) }]] as [string, Partial<Record<'start' | 'end' | 'min' | 'max' | 'x' | 'value', string>>][])
    const roleCases = [invalid[0]!, invalid[1]!, invalid[5]!, invalid[13]!]
    for (const [i, [family, lexical]] of roleCases.entries()) charts.push([`xsample${i}`, { x: typed(lexical, family) }], [`nextX${i}`, {}], [`nextY${i}`, {}])
    const many = ['manyNextX', 'manyNextY', 'manyNextBoth']
    for (const id of many) charts.push([id, {}])
    const source = numericPage(charts) + '\n' + roleCases.map(([family, lexical], i) => `
ex:nextX${i} c:point ex:nextX${i}n . ex:nextX${i}p ord:immediatelyPrecedes ex:nextX${i}n .
ex:nextX${i}n c:start ${typed(lexical, family)} ; c:value 0 .
ex:nextY${i} c:point ex:nextY${i}n . ex:nextY${i}p ord:immediatelyPrecedes ex:nextY${i}n .
ex:nextY${i}n c:start 2 ; c:value ${typed(lexical, family)} .`).join('\n') + '\n' + many.map(id => `
ex:${id} c:point ex:${id}n . ex:${id}p ord:immediatelyPrecedes ex:${id}n . ex:${id}n c:start 2 ; c:value 0 .
${id !== 'manyNextY' ? `ex:${id}n c:start ${Array.from({ length: 16 }, (_, i) => String(i + 20)).join(', ')} .` : ''}
${id !== 'manyNextX' ? `ex:${id}n c:value ${Array.from({ length: 16 }, (_, i) => String(i + 20)).join(', ')} .` : ''}`).join('\n')
    const both = twins(source, store => {
      for (const [i, [family, lexical]] of invalid.entries()) {
        originalLiteral(store, `sample${i}p`, 'value', family, lexical)
        originalLiteral(store, `bound${i}`, 'start', family, lexical)
      }
    })
    expect(both[0]!.html()).toBe(both[1]!.html())
    for (const h of both) for (const [i] of roleCases.entries()) {
      expect(figure(h, `xsample${i}`).querySelectorAll('circle')).toHaveLength(0)
      expect(figure(h, `xsample${i}`).querySelector('li')?.textContent).toBe(`xsample${i}p: 0`)
      for (const role of ['nextX', 'nextY']) {
        expect(figure(h, role + i).querySelectorAll('circle')).toHaveLength(1)
        expect(figure(h, role + i).querySelectorAll('line')).toHaveLength(0)
        expect(figure(h, role + i).querySelectorAll('li')).toHaveLength(2)
      }
    }
    for (const h of both) for (const id of many) {
      expect(figure(h, id).querySelectorAll('circle')).toHaveLength(1)
      expect(figure(h, id).querySelectorAll('line')).toHaveLength(0)
      expect(figure(h, id).querySelectorAll('li')).toHaveLength(2)
    }
    for (const h of both) for (let i = 0; i < invalid.length; i++) {
      expect(figure(h, `sample${i}`).querySelectorAll('circle')).toHaveLength(0)
      expect(figure(h, `sample${i}`).querySelector('li')?.textContent).toBe('1: unavailable')
      expect(figure(h, `bound${i}`).querySelector('svg')).toBeNull()
      expect(figure(h, `bound${i}`).textContent).toContain('Unable to plot')
    }
  })

  it('uses supported structural shapes without rejecting valid subtypes or pretending nested sample validation', () => {
    const source = numericPage([...familyCharts, ['numericInvalid', { start: typed('0x10', 'decimal') }], ['structuralInvalid', { start: 'ex:notALiteral' }]])
    const both = twins(source, store => { originalLiteral(store, 'numericInvalid', 'start', 'decimal', '0x10') })
    for (const [i, h] of both.entries()) {
      h.runtime.project({ modality: MOD.Screen, layers: [VAL.ShapesLayer], prefer: i === 0 ? 'sparql' : 'function', roots: [...numericFamilies, 'numericInvalid', 'structuralInvalid'].map(id => EX + id), name: 'numeric-structure' }, error => { throw error })
      h.renderer.flush()
      const f = h.store.factory
      const violations = (id: string) => h.store.match(null, f.namedNode(NS.sh + 'focusNode'), f.namedNode(EX + id))
      for (const family of numericFamilies) expect(violations(family), family).toHaveLength(0)
      expect(violations('numericInvalid')).toHaveLength(0) // Numeric refusal is the component's explicit responsibility.
      expect(figure(h, 'numericInvalid').textContent).toContain('Unable to plot')
      expect(violations('structuralInvalid').length).toBeGreaterThan(0)
    }
    expect(both[0]!.html()).toBe(both[1]!.html())
  })
})


it('runs the owned example receive/withdraw reaction without bridging its deliberately disconnected span', () => {
  const source = readFileSync(new URL('../examples/sparkline/app.ttl', import.meta.url), 'utf8').replaceAll('https://example.org/sparkline#', EX)
  const both = (['sparql', 'function'] as const).map(prefer => mount('wat', prefer, ['en'], source))
  const same = () => expect(both[0]!.html()).toBe(both[1]!.html())
  same()
  for (const h of both) { expect(h.document.querySelectorAll('circle')).toHaveLength(7); expect(h.document.querySelectorAll('line')).toHaveLength(4) }
  for (const [dots, lines] of [[8, 6], [7, 4]]) {
    for (const h of both) {
      const button = [...h.document.querySelectorAll('button')].find(el => el.textContent === 'Receive / withdraw missing sample')!
      button.dispatchEvent(new h.window.Event('click', { bubbles: true }))
      expect(h.document.querySelectorAll('circle')).toHaveLength(dots)
      expect(h.document.querySelectorAll('line')).toHaveLength(lines)
    }
    same()
  }
})


// Fixed observed input -> stored-term relations for the selected Oxigraph0.5.13.
// They are data from an ingestion-only control, before any Runtime projection.
// The final boolean is a hardcoded semantic finite-plot expectation, not a
// result computed by numericInput or by the renderer under test.
const oxigraphObserved: readonly (readonly [string, string, string, string, string, boolean])[] = [
  ["valid-integer", "integer", "123456789012345678901234567890", "integer", "123456789012345678901234567890", true],
  ["valid-decimal", "decimal", "12345678901234567890.123456789012345678901", "decimal", "12345678901234567890.123456789012345678901", true],
  ["valid-float", "float", "1.25", "float", "1.25", true],
  ["valid-double", "double", "1.25", "double", "1.25", true],
  ["valid-long", "long", "-9223372036854775808", "integer", "-9223372036854775808", true],
  ["valid-int", "int", "-2147483648", "integer", "-2147483648", true],
  ["valid-short", "short", "-32768", "integer", "-32768", true],
  ["valid-byte", "byte", "-128", "integer", "-128", true],
  ["valid-nonNegativeInteger", "nonNegativeInteger", "0", "integer", "0", true],
  ["valid-positiveInteger", "positiveInteger", "1", "integer", "1", true],
  ["valid-nonPositiveInteger", "nonPositiveInteger", "0", "integer", "0", true],
  ["valid-negativeInteger", "negativeInteger", "-1", "integer", "-1", true],
  ["valid-unsignedLong", "unsignedLong", "18446744073709551615", "unsignedLong", "18446744073709551615", true],
  ["valid-unsignedInt", "unsignedInt", "4294967295", "integer", "4294967295", true],
  ["valid-unsignedShort", "unsignedShort", "65535", "integer", "65535", true],
  ["valid-unsignedByte", "unsignedByte", "255", "integer", "255", true],
  ["unsignedByte-minus-one", "unsignedByte", "-1", "integer", "-1", true],
  ["unsignedByte-256", "unsignedByte", "256", "integer", "256", true],
  ["decimal-xml-whitespace", "decimal", " \t1.2500\r\n ", "decimal", " \t1.2500\r\n ", true],
  ["decimal-spelling", "decimal", "+0001.2500", "decimal", "1.25", true],
  ["float-Infinity", "float", "Infinity", "float", "INF", false],
  ["double-Infinity", "double", "Infinity", "double", "INF", false],
  ["float-NaN", "float", "NaN", "float", "NaN", false],
  ["double-NaN", "double", "NaN", "double", "NaN", false],
  ["float-INF", "float", "INF", "float", "INF", false],
  ["double-INF", "double", "INF", "double", "INF", false],
  ["float-midpoint", "float", "1.0000000596046448", "float", "1.0000001", true],
  ["integer-leading-zeros", "integer", "+0001", "integer", "1", true],
  ["float-leading-zeros", "float", "+0001.2500", "float", "1.25", true],
  ["integer-minus-zero", "integer", "-0", "integer", "0", true],
  ["decimal-minus-zero", "decimal", "-0", "decimal", "0", true],
  ["float-minus-zero", "float", "-0", "float", "-0", true],
  ["double-minus-zero", "double", "-0", "double", "-0", true],
  ["string-NBSP-prefix", "string", " 1", "string", " 1", false],
  ["string-NBSP-internal", "string", "1 2", "string", "1 2", false],
]
const requireObservedOxigraph = () => expect(JSON.parse(readFileSync(new URL('../node_modules/oxigraph/package.json', import.meta.url), 'utf8')).version).toBe('0.5.13')

describe('observed foreign canonical graph (Oxigraph0.5.13)', () => {
  it('checks all35 stored-term relations before Runtime and renders the canonical graph with matching twins', () => {
    requireObservedOxigraph()
    const source = numericPage(oxigraphObserved.map(([id, family, lexical]): Parameters<typeof numericPage>[0][number] => [id, { min: '-1e100', max: '1e100', value: typed(lexical, family) }]))
    const both = (['sparql', 'function'] as const).map(prefer => mount('oxigraph', prefer, ['en'], source, store => {
      for (const [id, , , storedFamily, storedLexical] of oxigraphObserved) originalLiteral(store, id + 'p', 'value', storedFamily, storedLexical)
    }))
    expect(both[0]!.html()).toBe(both[1]!.html())
    for (const h of both) for (const [id, , , , storedLexical, known] of oxigraphObserved) {
      const view = figure(h, id)
      expect(view.querySelectorAll('circle'), id).toHaveLength(known ? 1 : 0)
      expect(view.querySelector('li')?.textContent, id).toBe('1: ' + (known ? storedLexical : 'unavailable'))
      if (known) {
        expect(view.querySelector('circle')?.getAttribute('cx'), id).toBe('253')
        expect(view.querySelector('circle')?.getAttribute('cy'), id).toBe('100')
      }
    }
    // Erased invalid source subtypes are now ordinary integers in this graph.
    // Strict original unsignedByte refusal remains covered on retaining engines.
    expect(figure(both[0]!, 'unsignedByte-minus-one').querySelector('li')?.textContent).toBe('1: -1')
    expect(figure(both[0]!, 'unsignedByte-256').querySelector('li')?.textContent).toBe('1: 256')
  })

  it('uses foreign stored lexical strings for bounds, x and explicit next endpoints', () => {
    requireObservedOxigraph()
    const wide = '123456789012345678901234567890'
    const decimal = '12345678901234567890.123456789012345678901'
    const unsigned = '18446744073709551615'
    const xml = ' \t1.2500\r\n '
    const source = numericPage([
      ['foreignWideRoles', { start: '0', end: typed(wide, 'integer'), min: '0', max: typed(decimal, 'decimal'), x: '0', value: typed(xml, 'decimal') }],
      ['foreignUnsignedRoles', { start: '0', end: typed(unsigned, 'unsignedLong'), min: '0', max: '2', x: '0', value: '0' }],
    ]) + `
ex:foreignWideRoles c:point ex:foreignWideRolesn . ex:foreignWideRolesp ord:immediatelyPrecedes ex:foreignWideRolesn .
ex:foreignWideRolesn c:start ${typed(wide, 'integer')} ; c:value ${typed(decimal, 'decimal')} .
ex:foreignUnsignedRoles c:point ex:foreignUnsignedRolesn . ex:foreignUnsignedRolesp ord:immediatelyPrecedes ex:foreignUnsignedRolesn .
ex:foreignUnsignedRolesn c:start ${typed(unsigned, 'unsignedLong')} ; c:value ${typed(xml, 'decimal')} .`
    const both = (['sparql', 'function'] as const).map(prefer => mount('oxigraph', prefer, ['en'], source, store => {
      originalLiteral(store, 'foreignWideRoles', 'end', 'integer', wide)
      originalLiteral(store, 'foreignWideRoles', 'max', 'decimal', decimal)
      originalLiteral(store, 'foreignWideRolesn', 'start', 'integer', wide)
      originalLiteral(store, 'foreignWideRolesn', 'value', 'decimal', decimal)
      originalLiteral(store, 'foreignUnsignedRoles', 'end', 'unsignedLong', unsigned)
      originalLiteral(store, 'foreignUnsignedRolesn', 'start', 'unsignedLong', unsigned)
      originalLiteral(store, 'foreignWideRolesp', 'value', 'decimal', xml)
      originalLiteral(store, 'foreignUnsignedRolesn', 'value', 'decimal', xml)
    }))
    expect(both[0]!.html()).toBe(both[1]!.html())
    for (const h of both) {
      for (const [id, coordinates] of [
        ['foreignWideRoles', ['6', '194', '994', '6']],
        ['foreignUnsignedRoles', ['6', '194', '994', '76']],
      ] as const) {
        const view = figure(h, id), lines = [...view.querySelectorAll('line')]
        expect(view.querySelectorAll('circle')).toHaveLength(2)
        expect(lines).toHaveLength(1)
        expect(['x1', 'y1', 'x2', 'y2'].map(name => lines[0]!.getAttribute(name))).toEqual(coordinates)
      }
      expect(figure(h, 'foreignWideRoles').textContent).toContain(wide + ': ' + decimal)
      expect(figure(h, 'foreignUnsignedRoles').textContent).toContain(unsigned + ': ' + xml)
    }
  })

  it('uses the observed canonical float reading and widens its value before geometry', () => {
    requireObservedOxigraph()
    const source = numericPage([['foreignSingle', { min: '1', max: typed('1.00000011920928955078125', 'double'), value: typed('1.0000000596046448', 'float') }]])
    const both = (['sparql', 'function'] as const).map(prefer => mount('oxigraph', prefer, ['en'], source, store => {
      originalLiteral(store, 'foreignSinglep', 'value', 'float', '1.0000001')
    }))
    expect(both[0]!.html()).toBe(both[1]!.html())
    for (const h of both) {
      expect(figure(h, 'foreignSingle').querySelector('circle')?.getAttribute('cy')).toBe('6')
      expect(figure(h, 'foreignSingle').querySelector('li')?.textContent).toBe('1: 1.0000001')
    }
  })

  it('does not reconstruct two original raw bounds after ingestion has merged their stored terms', () => {
    requireObservedOxigraph()
    const source = numericPage([['canonicalZero', { start: typed('-0', 'integer') }]]) + '\nex:canonicalZero c:start 0 .'
    const both = (['sparql', 'function'] as const).map(prefer => mount('oxigraph', prefer, ['en'], source, store => {
      originalLiteral(store, 'canonicalZero', 'start', 'integer', '0') // exactly one stored term, checked before Runtime
    }))
    expect(both[0]!.html()).toBe(both[1]!.html())
    for (const h of both) expect(figure(h, 'canonicalZero').querySelectorAll('circle')).toHaveLength(1)
  })
})

it('renders all512 admitted points and readings, retaining original marks through a sample update', () => {
  const source = `${prefixes}
ex:page a c:Stack ; c:children (ex:full) .
ex:full a c:Sparkline ; c:label "full" ; c:start 0 ; c:end 511 ; c:min 0 ; c:max 1 ; c:point ${Array.from({ length: 512 }, (_, i) => 'ex:q' + i).join(', ')} .
${Array.from({ length: 512 }, (_, i) => `ex:q${i} c:start ${i} ; c:value 0 ${i < 511 ? '; ord:immediatelyPrecedes ex:q' + (i + 1) : ''} .`).join('\n')}`
  const both = (['sparql', 'function'] as const).map(prefer => mount('wat', prefer, ['en'], source))
  const originals = both.map(h => [...h.document.querySelectorAll('circle')])
  expect(both[0]!.html()).toBe(both[1]!.html())
  for (const [index, h] of both.entries()) {
    expect(originals[index]).toHaveLength(512)
    expect(h.document.querySelectorAll('li')).toHaveLength(512)
    expect(h.document.querySelectorAll('line')).toHaveLength(511)
    expect(h.document.querySelectorAll('li')[511]?.textContent).toBe('511: 0')
    expect(originals[index]![511]?.getAttribute('cx')).toBe('994')
    h.set('q256', 'value', 1)
    const after = [...h.document.querySelectorAll('circle')]
    expect(after).toHaveLength(512)
    for (let i = 0; i < 512; i++) expect(after[i]).toBe(originals[index]![i])
    expect(after[256]?.getAttribute('cy')).toBe('6')
    expect(h.document.querySelectorAll('li')[256]?.textContent).toBe('256: 1')
    expect(h.document.querySelectorAll('line')).toHaveLength(511)
  }
  expect(both[0]!.html()).toBe(both[1]!.html())
})
