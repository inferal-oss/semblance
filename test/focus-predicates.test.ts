import { describe, expect, it } from 'vitest'
import { focusPredicates } from '../src/engine/focus-predicates.ts'

// Where a SPARQL rule's variable predicates come from (#153): the focus's own properties, paths from
// it, IRIs - or anything, when they can be unbound or bound by something else where they are read.
const P = new Map([['ex', 'urn:x:']])
const of = (where: string) => {
  const out = focusPredicates(`PREFIX ex: <urn:x:> CONSTRUCT { ?this ex:out ?v } WHERE { ${where} }`, P)
  return out && { via: out.via.map((p) => p.join(' ')), iris: [...out.iris], ...(out.marked.size && { marked: [...out.marked] }) }
}

describe('focus predicates', () => {
  it('reads a predicate the focus names, along a path, or chosen among IRIs', () => {
    expect(of('?this ex:controls ?t ; ex:property ?p . ?t ?p ?v')).toEqual({ via: ['urn:x:property'], iris: [] })
    expect(of('OPTIONAL { ?this ex:property ?p0 } BIND(COALESCE(?p0, ex:checked) AS ?p) BIND(EXISTS { ?this ?p ?v } AS ?on)')).toEqual({ via: ['urn:x:property'], iris: ['urn:x:checked'] })
    expect(of('?this ex:validates ?s . OPTIONAL { ?s ex:path ?p0 } ?this ex:property ?q BIND(COALESCE(?p0, ?q) AS ?p) ?t ?p ?v')).toEqual({ via: ['urn:x:validates urn:x:path', 'urn:x:property'], iris: [] })
    expect(of('?g ex:pickerFor ?this ; ex:end ?p . ?t ?p ?v')).toEqual({ via: ['^urn:x:pickerFor urn:x:end'], iris: [] })
    expect(of('VALUES (?p) { (ex:a) (ex:b) } ?this ?p ?v')).toEqual({ via: [], iris: ['urn:x:a', 'urn:x:b'] })
    expect(of('BIND(IF(?k = 1, ex:a, ex:b) AS ?p) ?this ?p ?v')).toEqual({ via: [], iris: ['urn:x:a', 'urn:x:b'] })
    // A predicate that has a property (the style layer's hooked ones): when nothing links it to the focus.
    expect(of('?this ?p ?v . ?p ex:hookAttribute ?name')).toEqual({ via: [], iris: [], marked: ['urn:x:hookAttribute'] })
    expect(of('?this ex:validates ?s . OPTIONAL { ?s ex:path ?p } ?this ex:property ?p . ?t ?p ?v')).toEqual({ via: ['urn:x:property'], iris: [] })
    // Other patterns over the variable only narrow it.
    expect(of('?this ex:property ?p . OPTIONAL { ?p ex:label ?l } ?t ?p ?v')).toEqual({ via: ['urn:x:property'], iris: [] })
    // A LATERAL subquery takes what it projects from before it.
    expect(of('?this ex:property ?p ; ex:controls ?t . LATERAL { SELECT ?t ?p (MIN(?w) AS ?v) WHERE { ?t ?p ?w } GROUP BY ?t ?p }')).toEqual({ via: ['urn:x:property'], iris: [] })
  })

  it('reads every predicate when the variable can be anything where it is read', () => {
    expect(of('?this ?p ?v')).toBeUndefined()
    // Bound by another node's property, or only in an OPTIONAL.
    expect(of('ex:n ex:property ?p . ?t ?p ?v')).toBeUndefined()
    expect(of('OPTIONAL { ?this ex:property ?p } ?t ?p ?v')).toBeUndefined()
    // Bound after a BIND reads it (in order), or outside a plain subquery.
    expect(of('BIND(EXISTS { ?t ?p ?v } AS ?x) ?this ex:property ?p')).toBeUndefined()
    expect(of('?this ex:property ?p . { SELECT ?v WHERE { ?t ?p ?v } }')).toBeUndefined()
    // COALESCE that may be unbound, or over an expression it cannot follow.
    expect(of('OPTIONAL { ?this ex:property ?p0 } BIND(COALESCE(?p0, ?q) AS ?p) ?t ?p ?v')).toBeUndefined()
    expect(of('?this ex:name ?n BIND(IRI(?n) AS ?p) ?t ?p ?v')).toBeUndefined()
    // A negated property set.
    expect(of('?this !ex:a ?v')).toBeUndefined()
  })
})
