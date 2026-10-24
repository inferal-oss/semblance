import { Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { highlightTurtle, toTurtle, turtleTokens } from '../src/turtle.ts'

const parse = (ttl: string) => new Parser().parse(ttl)
const prefixes = { ex: 'https://example.org/', rdfs: 'http://www.w3.org/2000/01/rdf-schema#' }

describe('turtle formatter', () => {
  const src = `
    @prefix ex: <https://example.org/> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    ex:page a ex:Stack ; ex:children ( ex:a ex:b ) ; ex:gap 3 ; ex:on [ ex:event "click" ; ex:does ex:x ] ;
      rdfs:label "Page"@en, "Seite"@de, "Page" ; ex:at "2026-10-24"^^<http://www.w3.org/2001/XMLSchema#date> .
    ex:a ex:done true .`

  it('pretty-prints with prefixes, inline blank nodes and lists', () => {
    expect(toTurtle([{ title: 'input', quads: parse(src) }], prefixes)).toBe(
      [
        '@prefix ex: <https://example.org/> .',
        '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
        '',
        '# input',
        'ex:page a ex:Stack ;',
        '    ex:at "2026-10-24"^^<http://www.w3.org/2001/XMLSchema#date> ;',
        '    ex:children ( ex:a ex:b ) ;',
        '    ex:gap 3 ;',
        '    ex:on [',
        '        ex:does ex:x ;',
        '        ex:event "click"',
        '    ] ;',
        '    rdfs:label',
        '        "Page"@en,',
        '        "Seite"@de,',
        '        "Page" .',
        'ex:a ex:done true .',
        '',
      ].join('\n'),
    )
  })

  it('round-trips through a Turtle parser', () => {
    const quads = parse(src)
    const again = parse(toTurtle([{ quads }], prefixes))
    expect(again.length).toBe(quads.length)
  })

  it('emits highlight spans', () => {
    const html = highlightTurtle(turtleTokens([{ quads: parse('<https://example.org/a> a <https://example.org/B> .') }], prefixes))
    expect(html).toContain('<span class="ttl-pname">ex:a</span>')
    expect(html).toContain('<span class="ttl-keyword">a</span>')
  })
})
