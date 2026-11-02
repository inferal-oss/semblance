// Semblance's SPARQL extensions (rdf-engine/EXTENSIONS.md) on both engine
// builds: the same cases, the same answers, interpreted and compiled. Math
// answers are checked to the bit against the host's Math, Locale answers
// against the host's Intl (which the engines call).
import { existsSync, readFileSync } from 'node:fs'
import type { Term } from '@rdfjs/types'
import { describe, expect, it } from 'vitest'
import { EXTENSION_GROUPS } from '../rdf-engine/host/engine.ts'
import { engineStore, type EngineStore } from '../rdf-engine/host/store.ts'
import { formatDateTime, formatNumber, sortKey } from '../rdf-engine/host/intl.ts'

const built = (['rust', 'wat'] as const).filter((k) => existsSync(new URL(`../rdf-engine/build/${k}.wasm`, import.meta.url)))
const XSD = 'http://www.w3.org/2001/XMLSchema#'
const PREFIXES = `PREFIX sx: <https://semblance.dev/ns/sparql#>\nPREFIX xsd: <${XSD}>\n`

/** A term as `lexical^^local` (a datatype outside xsd in full), `lexical@lang`, `<iri>`; undefined when unbound. */
function show(t: Term | undefined): string | undefined {
  if (!t) return undefined
  if (t.termType === 'NamedNode') return `<${t.value}>`
  if (t.termType !== 'Literal') return `_:`
  if (t.language) return `${t.value}@${t.language}`
  return `${t.value}^^${t.datatype.value.startsWith(XSD) ? t.datatype.value.slice(XSD.length) : t.datatype.value}`
}

function stores(kind: string): [string, EngineStore][] {
  const module = new WebAssembly.Module(readFileSync(new URL(`../rdf-engine/build/${kind}.wasm`, import.meta.url)))
  return [
    ['interpreted', engineStore(module, kind, { timeZone: 'UTC' })],
    // Compiled on the first run: the extensions must compile or fall back, with the same answers.
    ['compiled', engineStore(module, kind, { timeZone: 'UTC', compile: 1 })],
  ]
}

const value = (s: EngineStore, expr: string) => show(s.select(`${PREFIXES}SELECT ?x { BIND(${expr} AS ?x) }`, [s.factory.defaultGraph()])[0]?.get('x'))
const rows = (s: EngineStore, q: string, vars: string[]) => s.select(PREFIXES + q, [s.factory.defaultGraph()]).map((r) => vars.map((v) => show(r.get(v)) ?? '-').join(' '))

/** A double's lexical form, as the engine writes it, against the host's value (bit for bit). */
function sameDouble(got: string | undefined, want: number) {
  expect(got).toMatch(/\^\^double$/)
  const lex = got!.replace(/\^\^double$/, '')
  const n = lex === 'INF' ? Infinity : lex === '-INF' ? -Infinity : Number(lex)
  expect(Object.is(n, want), `${lex} is ${want}`).toBe(true)
}

const MATH: [string, number | undefined][] = [
  ['sx:log(10)', Math.log(10)],
  ['sx:log(2.5)', Math.log(2.5)],
  ['sx:log("2.5"^^xsd:float)', Math.log(Math.fround(2.5))],
  ['sx:log(0)', undefined],
  ['sx:log(-1)', undefined],
  ['sx:log10(1000)', Math.log10(1000)],
  ['sx:log10(0.001)', Math.log10(0.001)],
  ['sx:log2(1024)', Math.log2(1024)],
  ['sx:log2(3)', Math.log2(3)],
  ['sx:exp(1)', Math.exp(1)],
  ['sx:exp(-2.5e0)', Math.exp(-2.5)],
  ['sx:exp(1000)', Infinity],
  ['sx:pow(2, 10)', 1024],
  ['sx:pow(2, 0.5)', Math.pow(2, 0.5)],
  ['sx:pow(-8, 1e0 / 3)', undefined],
  ['sx:pow(10, -2)', Math.pow(10, -2)],
  ['sx:sqrt(2)', Math.sqrt(2)],
  ['sx:sqrt(0)', 0],
  ['sx:sqrt(-1)', undefined],
  ['sx:sin(1)', Math.sin(1)],
  ['sx:cos(1)', Math.cos(1)],
  ['sx:tan(1)', Math.tan(1)],
  ['sx:asin(0.5)', Math.asin(0.5)],
  ['sx:asin(2)', undefined],
  ['sx:acos(0.5)', Math.acos(0.5)],
  ['sx:atan(1)', Math.atan(1)],
  ['sx:atan2(1, -1)', Math.atan2(1, -1)],
  ['sx:atan2(-0.5, 2)', Math.atan2(-0.5, 2)],
  ['sx:pi()', Math.PI],
  ['sx:sin(sx:pi() / 6)', Math.sin(Math.PI / 6)],
  ['sx:log("x")', undefined],
  ['sx:log(?unbound)', undefined],
  ['sx:sqrt("NaN"^^xsd:double)', undefined],
  ['sx:sqrt("INF"^^xsd:double)', Infinity],
]

/** Expression, and its value as `lexical^^local` (undefined: an error, so unbound). */
const TEXT: [string, string | undefined][] = [
  ['sx:codepoint("A€😀", 1)', '65^^integer'],
  ['sx:codepoint("A€😀", 2)', '8364^^integer'],
  ['sx:codepoint("A€😀", 3)', '128512^^integer'],
  ['sx:codepoint("A€😀", 4)', undefined],
  ['sx:codepoint("A€😀", 0)', undefined],
  ['sx:codepoint("abc"@en, 2)', '98^^integer'],
  ['sx:codepoint("abc", 1.0)', undefined],
  ['sx:codepoint(<http://x/>, 1)', undefined],
  ['sx:char(65)', 'A^^string'],
  ['sx:char(8364)', '€^^string'],
  ['sx:char(128512)', '😀^^string'],
  ['sx:char(55296)', undefined],
  ['sx:char(1114112)', undefined],
  ['sx:char(-1)', undefined],
  ['sx:char("65")', undefined],
  ['sx:utf8Hex("A€")', '41 e2 82 ac^^string'],
  ['sx:utf8Hex("")', '^^string'],
  ['sx:utf8Hex("😀"@en)', 'f0 9f 98 80^^string'],
  ['sx:decodeURI("a%20b%E2%82%ac+c")', 'a b€+c^^string'],
  ['sx:decodeURI("%e2%82%AC")', '€^^string'],
  ['sx:decodeURI("plain")', 'plain^^string'],
  ['sx:decodeURI("%E2%82")', undefined],
  ['sx:decodeURI("%G0")', undefined],
  ['sx:decodeURI("100%")', undefined],
  ['sx:decodeURI("%FF")', undefined],
  ['sx:fnv1a("")', '811c9dc5^^string'],
  ['sx:fnv1a("a")', 'e40c292c^^string'],
  ['sx:fnv1a("foobar")', 'bf9cf968^^string'],
  ['sx:fnv1a("€")', fnv1a('€') + '^^string'],
  ['sx:fnv1a("x"@en)', fnv1a('x') + '^^string'],
  ['sx:fnv1a(1)', undefined],
  ['sx:unknown("x")', undefined],
]

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

const LOCALE: [string, string | undefined][] = [
  ['sx:formatNumber(1234567.891, "en")', formatNumber(1234567.891, 'en')],
  ['sx:formatNumber(1234567.891, "de")', formatNumber(1234567.891, 'de')],
  ['sx:formatNumber(1234567.891, "uk")', formatNumber(1234567.891, 'uk')],
  ['sx:formatNumber(1234567.891, "ar-EG")', formatNumber(1234567.891, 'ar-EG')],
  ['sx:formatNumber(0.256, "en", "style=percent")', formatNumber(0.256, 'en', 'style=percent')],
  ['sx:formatNumber(42, "de", "style=currency;currency=EUR;maximumFractionDigits=0")', formatNumber(42, 'de', 'style=currency;currency=EUR;maximumFractionDigits=0')],
  ['sx:formatNumber(3, "en", "minimumIntegerDigits=2;useGrouping=false")', '03'],
  ['sx:formatNumber("INF"^^xsd:double, "en")', formatNumber(Infinity, 'en')],
  ['sx:formatNumber("1.5e3"^^xsd:double, "en")', '1,500'],
  ['sx:formatNumber(1, "en", "style=currency")', undefined],
  ['sx:formatNumber(1, "not a tag!")', undefined],
  ['sx:formatNumber("1", "en")', undefined],
  ['sx:formatDateTime("2026-10-26T14:05:00Z"^^xsd:dateTime, "en", "dateStyle=medium;timeStyle=short")', formatDateTime(new Date('2026-10-26T14:05:00Z'), 'en', 'dateStyle=medium;timeStyle=short', 'UTC')],
  ['sx:formatDateTime("2026-10-26T14:05:00"^^xsd:dateTime, "de", "hour=2-digit;minute=2-digit")', '14:05'],
  ['sx:formatDateTime("2026-10-26T14:05:00+02:00"^^xsd:dateTime, "en", "hour=numeric;minute=2-digit;hour12=false")', '12:05'],
  ['sx:formatDateTime("2026-10-26T14:05:00Z"^^xsd:dateTime, "en", "hour=numeric;minute=2-digit;hour12=false;timeZone=Asia/Tokyo")', '23:05'],
  ['sx:formatDateTime("2026-10-26"^^xsd:date, "uk", "dateStyle=long")', formatDateTime(new Date('2026-10-26T00:00:00Z'), 'uk', 'dateStyle=long', 'UTC')],
  ['sx:formatDateTime("2026-10-26T14:05:00Z", "en")', undefined],
  ['sx:formatDateTime("2026-10-24"^^xsd:date, "uk", "weekday=long;year=numeric;month=long;day=numeric;timeZone=UTC;part=month")', 'жовтня^^string'],
  ['sx:formatDateTime("2026-10-24"^^xsd:date, "en", "year=numeric;month=long;timeZone=UTC;part=dayPeriod")', '^^string'],
  ['sx:formatDateTime("2026-10-24"^^xsd:date, "de", "year=numeric;month=2-digit;day=2-digit;timeZone=UTC;fields=day:%d,month:%m,year:%y")', '%d.%m.%y^^string'],
  ['sx:formatDateTime("2026-10-24"^^xsd:date, "en-US", "info=firstDay")', '7^^string'],
  ['sx:formatDateTime("2026-10-24"^^xsd:date, "en-GB", "info=firstDay")', '1^^string'],
  ['sx:formatDateTime("2026-10-24"^^xsd:date, "en-US", "hour=numeric;info=hourCycle")', 'h12^^string'],
  ['sx:formatDateTime("2026-10-24"^^xsd:date, "en-gb", "info=locale")', 'en-GB^^string'],
  ['sx:formatDateTime("2026-10-24"^^xsd:date, "en", "info=nothing")', undefined],
  ['sx:sortKey("Éclair", "fr")', 'eclair^^string'],
  ['sx:sortKey("ÅNGSTRÖM", "en")', sortKey('ÅNGSTRÖM', 'en') + '^^string'],
  ['sx:sortKey("İstanbul", "tr")', sortKey('İstanbul', 'tr') + '^^string'],
  ['sx:sortKey("Straße"@de, "de")', 'straße^^string'],
  ['sx:collated("b", "en")', 'b^^string'],
  ['sx:collated("b"@en, "en")', 'b@en'],
]

describe.skipIf(!built.length).each(built)('%s engine: SPARQL extensions', (kind) => {
  const all = stores(kind)

  it('reports every group', () => {
    for (const [, s] of all) expect([...(s.extensions ?? [])]).toEqual(EXTENSION_GROUPS)
  })

  describe.each(all)('%s', (_, s) => {
    it.each(MATH)('%s', (expr, want) => {
      const got = value(s, expr)
      if (want === undefined) expect(got).toBeUndefined()
      else sameDouble(got, want)
    })

    it.each(TEXT)('%s', (expr, want) => expect(value(s, expr)).toBe(want))

    it.each(LOCALE)('%s', (expr, want) => expect(value(s, expr)).toBe(want === undefined || want.includes('^^') || want.includes('@') ? want : `${want}^^string`))

    it('sx:collated orders by Intl.Collator', () => {
      const words = ['zebra', 'Äpfel', 'apple', 'Zoo', 'éclair', 'eclair', 'banana']
      const q = `SELECT ?w { VALUES ?w { ${words.map((w) => JSON.stringify(w)).join(' ')} } } ORDER BY sx:collated(?w, "de")`
      const want = [...words].sort(new Intl.Collator('de').compare)
      expect(rows(s, q, ['w'])).toEqual(want.map((w) => `${w}^^string`))
      const desc = `SELECT ?w { VALUES ?w { ${words.map((w) => JSON.stringify(w)).join(' ')} } } ORDER BY DESC(sx:collated(?w, "de"))`
      expect(rows(s, desc, ['w'])).toEqual([...want].reverse().map((w) => `${w}^^string`))
      // Swedish puts ä after z.
      const sv = `SELECT ?w { VALUES ?w { "ä" "z" "a" } } ORDER BY sx:collated(?w, "sv")`
      expect(rows(s, sv, ['w'])).toEqual(['a^^string', 'z^^string', 'ä^^string'])
      // A key that is not a string orders as SPARQL orders it (unbound first).
      const mixed = `SELECT ?w { VALUES ?w { "b" UNDEF "a" } } ORDER BY sx:collated(?w, "en")`
      expect(rows(s, mixed, ['w'])).toEqual(['-', 'a^^string', 'b^^string'])
    })

    it('sx:matches: one row per match, groups unbound when they take no part', () => {
      const q = `SELECT ?m ?at ?w ?n { ("ab 12 cd 3" "([a-z]+)|([0-9]+)") sx:matches (?m ?at ?w ?n) } ORDER BY ?at`
      expect(rows(s, q, ['m', 'at', 'w', 'n'])).toEqual([
        'ab^^string 1^^integer ab^^string -',
        '12^^string 4^^integer - 12^^string',
        'cd^^string 7^^integer cd^^string -',
        '3^^string 10^^integer - 3^^string',
      ])
    })

    it('sx:matches: a tokenizer with code-point positions', () => {
      const src = 'é "x" ?v # c'
      const q = `SELECT ?tok ?at ?comment ?string ?var ?word ?space ?other {
        BIND(${JSON.stringify(src)} AS ?src)
        (?src '(#[^\\n]*)|("[^"]*")|(\\\\?\\\\w+)|([A-Za-z_]\\\\w*)|(\\\\s+)|(.)') sx:matches (?tok ?at ?comment ?string ?var ?word ?space ?other)
      } ORDER BY ?at`
      const got = rows(s, q, ['tok', 'at', 'comment', 'string', 'var', 'space'])
      expect(got).toEqual([
        'é^^string 1^^integer - - - -',
        ' ^^string 2^^integer - - -  ^^string',
        '"x"^^string 3^^integer - "x"^^string - -',
        ' ^^string 6^^integer - - -  ^^string',
        '?v^^string 7^^integer - - ?v^^string -',
        ' ^^string 9^^integer - - -  ^^string',
        '# c^^string 10^^integer # c^^string - - -',
      ])
    })

    it('sx:matches: empty matches advance one code point; flags; bound outputs filter', () => {
      expect(rows(s, `SELECT ?m ?at { ("a😀b" "x*") sx:matches (?m ?at) } ORDER BY ?at`, ['m', 'at'])).toEqual(['^^string 1^^integer', '^^string 2^^integer', '^^string 3^^integer', '^^string 4^^integer'])
      expect(rows(s, `SELECT ?at { ("aAbA" "a" "i") sx:matches (?m ?at) } ORDER BY ?at`, ['at'])).toEqual(['1^^integer', '2^^integer', '4^^integer'])
      expect(rows(s, `SELECT ?at { ("abab" "b") sx:matches ("b" ?at) } ORDER BY ?at`, ['at'])).toEqual(['2^^integer', '4^^integer'])
      expect(rows(s, `SELECT ?m { ("abab" "b") sx:matches (?m 4) }`, ['m'])).toEqual(['b^^string'])
      expect(rows(s, `SELECT ?m { ("abab" "(") sx:matches (?m) }`, ['m'])).toEqual([])
      expect(rows(s, `SELECT ?m { (?nothing "a") sx:matches (?m) }`, ['m'])).toEqual([])
      expect(rows(s, `SELECT ?m { (1 "a") sx:matches (?m) }`, ['m'])).toEqual([])
      // The same variable twice must agree.
      expect(rows(s, `SELECT ?g { ("aabc" "(.)(.)") sx:matches (?m ?at ?g ?g) }`, ['g'])).toEqual(['a^^string'])
    })

    it('sx:matches joins with the patterns that bind its inputs, wherever they are written', () => {
      const data = `<http://x/a> <http://x/src> "one two" . <http://x/b> <http://x/src> "three" .`
      s.loadTurtle(data)
      const q = `SELECT ?d ?w { (?t "\\\\w+") sx:matches (?w) . ?d <http://x/src> ?t } ORDER BY ?d ?w`
      expect(rows(s, q, ['d', 'w'])).toEqual(['<http://x/a> one^^string', '<http://x/a> two^^string', '<http://x/b> three^^string'])
      const opt = `SELECT ?d ?w { ?d <http://x/src> ?t OPTIONAL { (?t "o") sx:matches (?w ?at) FILTER(?at = 1) } } ORDER BY ?d`
      expect(rows(s, opt, ['d', 'w'])).toEqual(['<http://x/a> o^^string', '<http://x/b> -'])
      const ex = `SELECT ?d { ?d <http://x/src> ?t FILTER EXISTS { (?t "^t") sx:matches (?m) } }`
      expect(rows(s, ex, ['d'])).toEqual(['<http://x/b>'])
      const n = `SELECT (COUNT(*) AS ?n) { ?d <http://x/src> ?t . (?t) sx:chars (?c ?i) }`
      expect(rows(s, n, ['n'])).toEqual(['12^^integer'])
    })

    it('a magic relation written with a list of the wrong shape is an ordinary pattern', () => {
      expect(rows(s, `SELECT ?m { "abc" sx:matches (?m) }`, ['m'])).toEqual([])
      expect(rows(s, `SELECT ?m { ("a" "a") sx:matches ?m }`, ['m'])).toEqual([])
    })

    it('sx:chars: one row per code point', () => {
      expect(rows(s, `SELECT ?c ?i { ("a€😀") sx:chars (?c ?i) } ORDER BY ?i`, ['c', 'i'])).toEqual(['a^^string 1^^integer', '€^^string 2^^integer', '😀^^string 3^^integer'])
      expect(rows(s, `SELECT ?c { ("") sx:chars (?c ?i) }`, ['c'])).toEqual([])
      expect(rows(s, `SELECT ?i { ("abca"@en) sx:chars ("a" ?i) } ORDER BY ?i`, ['i'])).toEqual(['1^^integer', '4^^integer'])
    })

    it('sx:json: one row per value, in document order', () => {
      const json = '{"items": [{"name": "a/b~c", "n": 3}, true, null, 1.50, -2e3, "\\u20ac\\ud83d\\ude00"], "e": {}, "": []}'
      const q = `SELECT ?path ?parent ?key ?kind ?value { (${JSON.stringify(json)}) sx:json (?path ?parent ?key ?kind ?value) }`
      const got = rows(s, q, ['path', 'parent', 'key', 'kind', 'value'])
      expect(got).toEqual([
        '^^string - - object^^string -',
        '/items^^string ^^string items^^string array^^string -',
        '/items/0^^string /items^^string 0^^integer object^^string -',
        '/items/0/name^^string /items/0^^string name^^string string^^string a/b~c^^string',
        '/items/0/n^^string /items/0^^string n^^string number^^string 3^^integer',
        '/items/1^^string /items^^string 1^^integer boolean^^string true^^boolean',
        '/items/2^^string /items^^string 2^^integer null^^string -',
        '/items/3^^string /items^^string 3^^integer number^^string 1.50^^decimal',
        '/items/4^^string /items^^string 4^^integer number^^string -2e3^^double',
        '/items/5^^string /items^^string 5^^integer string^^string €😀^^string',
        '/e^^string ^^string e^^string object^^string -',
        '/^^string ^^string ^^string array^^string -',
      ])
      const esc = `SELECT ?path { ("{\\"a/b~c\\": 1}") sx:json (?path ?parent ?key ?kind ?value) FILTER(?kind = "number") }`
      expect(rows(s, esc, ['path'])).toEqual(['/a~1b~0c^^string'])
    })

    it('sx:json: scalars at the root, invalid JSON, depth', () => {
      expect(rows(s, `SELECT ?k ?v { (" 42 ") sx:json (?p ?parent ?key ?k ?v) }`, ['k', 'v'])).toEqual(['number^^string 42^^integer'])
      expect(rows(s, `SELECT ?k ?v { ("\\"x\\"") sx:json (?p ?parent ?key ?k ?v) }`, ['k', 'v'])).toEqual(['string^^string x^^string'])
      for (const bad of ['{', '[1,]', '{"a" 1}', '01', '1.', '"\\ud800"', 'tru', '[1] 2', '', "{'a': 1}", '"a\nb"', '-', '1e']) {
        expect(rows(s, `SELECT ?k { (${JSON.stringify(bad)}) sx:json (?p ?parent ?key ?k ?v) }`, ['k']), bad).toEqual([])
      }
      const deep = (n: number) => '['.repeat(n) + ']'.repeat(n)
      expect(rows(s, `SELECT (COUNT(*) AS ?n) { (${JSON.stringify(deep(512))}) sx:json (?p ?parent ?key ?k ?v) }`, ['n'])).toEqual(['512^^integer'])
      expect(rows(s, `SELECT (COUNT(*) AS ?n) { (${JSON.stringify(deep(513))}) sx:json (?p ?parent ?key ?k ?v) }`, ['n'])).toEqual(['0^^integer'])
    })

    it('extensions in CONSTRUCT rules bound per focus', () => {
      s.loadTurtle(`<http://x/doc> <http://x/json> "[10, 20]" .`)
      const q = `${PREFIXES}CONSTRUCT { ?item <http://x/value> ?v ; <http://x/log> ?l } WHERE {
        $this <http://x/json> ?j . (?j) sx:json (?path ?parent ?key ?kind ?v) FILTER(?kind = "number")
        BIND(IRI(CONCAT(STR($this), "/~", ENCODE_FOR_URI(?path))) AS ?item)
        BIND(sx:log10(?v) AS ?l)
      }`
      const out = s.constructFor!(q, 'this', [s.factory.namedNode('http://x/doc')], [s.factory.defaultGraph()])
      const got = out.map((t) => `${t.subject.value} ${t.predicate.value.replace('http://x/', '')} ${show(t.object as Term)}`).sort()
      expect(got.filter((t) => t.includes(' value '))).toEqual(['http://x/doc/~%2F0 value 10^^integer', 'http://x/doc/~%2F1 value 20^^integer'])
      const logs = got.filter((t) => t.includes(' log '))
      expect(logs.map((t) => t.split(' ')[0])).toEqual(['http://x/doc/~%2F0', 'http://x/doc/~%2F1'])
      sameDouble(logs[0]!.split(' ')[2], 1)
      sameDouble(logs[1]!.split(' ')[2], Math.log10(20))
    })
  })
})
