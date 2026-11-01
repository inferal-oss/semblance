// The layout invariants (ontology/layers/constraints.ttl) over a page's geometry: read the declarations
// with SPARQL, instantiate them over a box tree for the function checker (check.ts), and say what a
// finding means. The geometry is the rendered state (rnd:, with rnd:Layout) of a live store, read
// into a box tree (fromRendered) for the function checker and queried as it is by the SPARQL checker
// (lc:Checker, checkSparql), or a recorded page (measure.ts), turned into the same triples (toTurtle).
import type { Quad_Graph } from '@rdfjs/types'
import type { GraphStore } from '../store/types.ts'
import { packBoxes, Rel, type Box, type Finding, type Invariant } from './check.ts'
import { checkLayout } from './engine.ts'
import { pagePath, type MeasuredNode, type MeasuredPage } from './measure.ts'

export const LC = 'https://semblance.dev/ns/layout-constraints#'
export const RND = 'https://semblance.dev/ns/rendered#'
const C = 'https://semblance.dev/ns/component#'
const POS = 'https://semblance.dev/ns/position#'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RENDERED = 'urn:semblance:rendered'

export const PREFIXES = `PREFIX lc: <${LC}>
PREFIX rnd: <${RND}>
PREFIX c: <${C}>
PREFIX pos: <${POS}>
PREFIX sem: <https://semblance.dev/ns/core#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
`

const RELATIONS: Record<string, Rel | 'page' | 'content'> = {
  SameBlockSize: Rel.SameBlockSize,
  SameInlineSize: Rel.SameInlineSize,
  SameTop: Rel.SameTop,
  SameBottom: Rel.SameBottom,
  FitsInline: Rel.FitsInline,
  FitsWithin: Rel.FitsWithin,
  NoPageOverflow: 'page',
  ContentFits: 'content',
}

export interface Declaration {
  iri: string
  label: string
  relation: Rel | 'page' | 'content'
  over: string[]
  members: 'EachChild' | 'Parts' | 'Descendants' | ''
  part: string
  tolerance: number
}

/** What the checker needs from the ontology: the invariants, and which classes a slug stands for. */
export interface Declarations {
  invariants: Declaration[]
  /** slug → the classes with it, and every class above them */
  typesOf: Map<string, Set<string>>
  /** slug → the classes with it (no closure) */
  directTypes: Map<string, string[]>
  /** the component classes lc:Field includes */
  fields: Set<string>
}

const local = (iri: string) => iri.slice(iri.lastIndexOf('#') + 1)

/** Read the declarations from a store with the ontology loaded (SPARQL, as the layer would). */
export function readDeclarations(store: GraphStore): Declarations {
  const g = [store.factory.defaultGraph()]
  const rows = store.select(
    PREFIXES +
      `SELECT ?inv ?rel ?over ?members ?part ?tol (SAMPLE(?l) AS ?label) WHERE {
        ?inv a lc:Invariant ; lc:relation ?rel ; lc:over ?over ; lc:tolerance ?tol .
        OPTIONAL { ?inv lc:members ?members } OPTIONAL { ?inv lc:part ?part }
        OPTIONAL { ?inv rdfs:label ?l FILTER(LANG(?l) = "en") }
      } GROUP BY ?inv ?rel ?over ?members ?part ?tol ORDER BY ?inv ?over`,
    g,
  )
  const byIri = new Map<string, Declaration>()
  for (const r of rows) {
    const iri = r.get('inv')!.value
    let d = byIri.get(iri)
    if (!d) {
      d = {
        iri,
        label: r.get('label')?.value ?? local(iri),
        relation: RELATIONS[local(r.get('rel')!.value)],
        over: [],
        members: (r.get('members') ? local(r.get('members')!.value) : '') as Declaration['members'],
        part: r.get('part') ? local(r.get('part')!.value) : '',
        tolerance: Number(r.get('tol')!.value),
      }
      byIri.set(iri, d)
    }
    d.over.push(r.get('over')!.value)
  }
  const typesOf = new Map<string, Set<string>>()
  const directTypes = new Map<string, string[]>()
  for (const r of store.select(PREFIXES + `SELECT ?slug ?cls ?up WHERE { ?cls sem:slug ?slug ; rdfs:subClassOf* ?up . }`, g)) {
    const slug = r.get('slug')!.value
    const cls = r.get('cls')!.value
    if (!typesOf.has(slug)) typesOf.set(slug, new Set())
    typesOf.get(slug)!.add(r.get('up')!.value)
    const d = directTypes.get(slug) ?? []
    if (!d.includes(cls)) directTypes.set(slug, [...d, cls])
  }
  const fields = new Set(store.select(PREFIXES + `SELECT ?k WHERE { lc:Field lc:includes ?k }`, g).map((r) => r.get('k')!.value))
  return { invariants: [...byIri.values()], typesOf, directTypes, fields }
}

/** One invariant over one group: what a finding's `invariant` index refers to. */
export interface Instance {
  declaration: Declaration
  /** the group's (or container's) node index; -1 for the page */
  scope: number
  /** for lc:ContentFits: the member whose own content is checked */
  member?: number
}

/** The children (components) of each node, in document order. */
function childrenOf(nodes: readonly MeasuredNode[]): number[][] {
  const out: number[][] = nodes.map(() => [])
  nodes.forEach((n, i) => {
    if (!n.part && n.parent >= 0) out[n.parent].push(i)
  })
  return out
}

function isFieldRow(nodes: readonly MeasuredNode[], i: number, kids: number[][], d: Declarations): boolean {
  if (nodes[i].direction !== 'row' && nodes[i].layout !== 'field-row') return false
  const fields = kids[i].filter((k) => (d.directTypes.get(nodes[k].slug) ?? []).some((c) => d.fields.has(c)))
  return fields.length >= 2
}

/** Whether node `i` has `ancestor` above it; with `noScrollerBetween`, through no scrolling node. */
function within(nodes: readonly MeasuredNode[], i: number, ancestor: number, noScrollerBetween: boolean): boolean {
  for (let p = nodes[i].parent; p >= 0; p = nodes[p].parent) {
    if (p === ancestor) return true
    if (noScrollerBetween && nodes[p].scrolls) return false
  }
  return false
}

/** Every invariant instantiated over a page: packed for the function checker, with what each means. */
export function instantiate(page: MeasuredPage, d: Declarations): { boxes: Box[]; invariants: Invariant[]; instances: Instance[] } {
  const nodes = page.nodes
  const kids = childrenOf(nodes)
  const boxes: Box[] = nodes.map(({ x, y, width, height }) => ({ x, y, width, height }))
  // the viewport and the document, for the page relation
  const viewport = boxes.push({ x: 0, y: 0, width: page.width, height: page.height }) - 1
  const documentBox = boxes.push({ x: 0, y: 0, width: page.scrollWidth, height: page.height }) - 1
  const invariants: Invariant[] = []
  const instances: Instance[] = []
  // the first part of each role per component
  const firstPart = new Map<string, number>()
  nodes.forEach((n, i) => {
    if (n.part && !firstPart.has(n.parent + ' ' + n.part)) firstPart.set(n.parent + ' ' + n.part, i)
  })
  for (const decl of d.invariants) {
    if (decl.relation === 'page') {
      invariants.push({ rel: Rel.FitsInline, members: [viewport, documentBox], tolerance: decl.tolerance })
      instances.push({ declaration: decl, scope: -1 })
      continue
    }
    const over = new Set(decl.over)
    nodes.forEach((n, i) => {
      if (n.part) return
      const types = d.typesOf.get(n.slug)
      const inScope = (types && [...types].some((t) => over.has(t))) || (over.has(LC + 'FieldRow') && isFieldRow(nodes, i, kids, d))
      if (!inScope) return
      let members: number[] = []
      // the line of a row a member is on (a child of the scope, or a part of one), 0 elsewhere
      const lineOf = (m: number) => {
        const owner = nodes[m].part ? nodes[m].parent : m
        return nodes[owner].parent === i ? (nodes[owner].line ?? 0) : 0
      }
      if (decl.members === 'EachChild')
        members = decl.part ? kids[i].map((k) => firstPart.get(k + ' ' + decl.part) ?? -1).filter((m) => m >= 0) : kids[i]
      else if (decl.members === 'Parts') members = nodes.flatMap((m, j) => (m.part === decl.part && within(nodes, j, i, false) ? [j] : []))
      else if (decl.members === 'Descendants') {
        if (n.scrolls) return
        members = nodes.flatMap((m, j) => (!m.part && within(nodes, j, i, true) ? [j] : []))
      }
      if (decl.relation === 'content') {
        // each member's content against its own box: the box, and the box widened by its overflow
        for (const m of members) {
          const b = boxes[m]
          const content = boxes.push({ ...b, width: b.width + (nodes[m].overflowsBy ?? 0) }) - 1
          invariants.push({ rel: Rel.FitsInline, members: [m, content], tolerance: decl.tolerance })
          instances.push({ declaration: decl, scope: i, member: m })
        }
        return
      }
      const fits = decl.relation === Rel.FitsInline || decl.relation === Rel.FitsWithin
      if (fits) {
        if (members.length === 0) return
        invariants.push({ rel: decl.relation as Rel, members: [i, ...members], tolerance: decl.tolerance })
        instances.push({ declaration: decl, scope: i })
        return
      }
      // a group is compared line by line
      const lines = new Map<number, number[]>()
      for (const m of members) lines.set(lineOf(m), [...(lines.get(lineOf(m)) ?? []), m])
      for (const group of lines.values()) {
        if (group.length < 2) continue
        invariants.push({ rel: decl.relation as Rel, members: group, tolerance: decl.tolerance })
        instances.push({ declaration: decl, scope: i })
      }
    })
  }
  return { boxes, invariants, instances }
}

export interface PageFinding extends Finding {
  instance: Instance
}

export function checkMeasured(page: MeasuredPage, d: Declarations): PageFinding[] {
  const { boxes, invariants, instances } = instantiate(page, d)
  return checkInstantiated(boxes, invariants, instances)
}

export function checkInstantiated(boxes: Box[], invariants: Invariant[], instances: Instance[]): PageFinding[] {
  const program: number[] = []
  for (const inv of invariants) program.push(inv.rel, Math.round(inv.tolerance * 100), inv.members.length, ...inv.members)
  return checkLayout(packBoxes(boxes), Int32Array.from(program)).map((f) => ({ ...f, member: instances[f.invariant].member ?? f.member, instance: instances[f.invariant] }))
}

/** A finding in words: the invariant, where, and by how much. */
export function describe(page: MeasuredPage, f: PageFinding): string {
  const at = `${pagePath(page)} at ${page.width}px${page.theme ? ' in ' + page.theme : ''}${page.lang && page.lang !== 'en' ? ' (' + page.lang + ')' : ''}${page.dir === 'rtl' ? ' (rtl)' : ''}`
  const name = (i: number) => {
    const n = page.nodes[i]
    if (!n) return 'the page'
    return `${n.part ? n.part + ' of ' : ''}${n.slug}${n.text ? ` "${n.text.slice(0, 24)}"` : ''}`
  }
  const where = f.instance.scope >= 0 ? ` in ${name(f.instance.scope)}` : ''
  return `${at}: ${f.instance.declaration.label}${where}: ${name(f.member)} is off by ${f.by.toFixed(1)}px`
}

const num = (n: number) => `"${n}"^^xsd:decimal`

/**
 * A measured page as rendered-state triples (Turtle), the shape the rnd: layer writes: a box per
 * component and per part (rnd:of, x, y, width, height, rnd:parent, rnd:scrolls; parts lc:role and
 * lc:index), the viewport, and for each component what the graph would say of it here: its classes
 * (from its slug), pos:direction, c:children.
 */
export function toTurtle(page: MeasuredPage, d: Declarations): string {
  const nodes = page.nodes
  const kids = childrenOf(nodes)
  const box = (i: number) => `<urn:semblance:rendered:n${i}>`
  const comp = (i: number) => `<urn:fixture:c${i}>`
  const lines: string[] = [PREFIXES.replace(/^PREFIX (\S+) (\S+)$/gm, '@prefix $1 $2 .')]
  const index = new Map<string, number>()
  nodes.forEach((n, i) => {
    const owner = n.part ? n.parent : i
    const t = [`${box(i)} rnd:of ${comp(owner)} ; rnd:x ${num(n.x)} ; rnd:y ${num(n.y)} ; rnd:width ${num(n.width)} ; rnd:height ${num(n.height)}`]
    if (n.parent >= 0) t.push(`rnd:parent ${box(n.parent)}`)
    if (n.scrolls) t.push('rnd:scrolls true')
    if (n.line !== undefined) t.push(`rnd:line ${n.line}`)
    if (n.overflowsBy) t.push(`rnd:clientWidth ${num(n.width)}`, `rnd:scrollWidth ${num(n.width + n.overflowsBy)}`)
    if (n.part) {
      const k = index.get(owner + ' ' + n.part) ?? 0
      index.set(owner + ' ' + n.part, k + 1)
      t.push(`lc:role lc:${n.part}`, `lc:index ${k}`)
    } else {
      const c = [`${comp(i)} a sem:Component`, ...(d.directTypes.get(n.slug) ?? []).map((cls) => `a <${cls}>`)]
      if (n.direction === 'row') c.push('pos:direction pos:Row')
      if (n.layout === 'field-row') c.push('pos:layout pos:FieldRow')
      if (kids[i].length) c.push(`c:children ( ${kids[i].map(comp).join(' ')} )`)
      lines.push(c.join(' ; ') + ' .')
    }
    lines.push(t.join(' ; ') + ' .')
  })
  lines.push(`<urn:semblance:rendered:viewport> a rnd:Viewport ; rnd:width ${num(page.width)} ; rnd:scrollWidth ${num(page.scrollWidth)} .`)
  return lines.join('\n')
}

/** The node index of a component or state IRI in a page made by toTurtle (-1: none). */
export function fixtureNode(iri: string | undefined): number {
  return iri?.startsWith('urn:fixture:c') ? Number(iri.slice(13)) : iri?.startsWith('urn:semblance:rendered:n') ? Number(iri.slice(24)) : -1
}

/**
 * The rendered state of a live store (the urn:semblance:rendered graph, written with rnd:Layout) as
 * a box tree, for the function checker: a node per state with a box, its slug from its component's
 * class, a part's role and order, and for each component what the graph says of it (pos:direction,
 * pos:layout). `components` and `states` give each node's component (or part) IRI and its state's, to read findings by.
 */
export function fromRendered(store: GraphStore, d: Declarations): { page: MeasuredPage; components: string[]; states: string[] } {
  const f = store.factory
  const g = f.namedNode(RENDERED)
  const nn = (iri: string) => f.namedNode(iri)
  const one = (s: string, p: string, graph: Quad_Graph | null = g) => store.match(nn(s), nn(p), null, graph)[0]?.object.value
  const slugOf = new Map<string, string>()
  for (const [slug, classes] of d.directTypes) for (const c of classes) slugOf.set(c, slug)
  const states = store
    .match(null, nn(RND + 'x'), null, g)
    .map((q) => q.subject.value)
    .filter((s) => one(s, RND + 'of'))
  // parts after components, each component's parts of a role in their order
  const index = (s: string) => Number(one(s, LC + 'index') ?? -1)
  states.sort((a, b) => index(a) - index(b) || (a < b ? -1 : a > b ? 1 : 0))
  const at = new Map(states.map((s, i) => [s, i]))
  const components: string[] = []
  const nodes: MeasuredNode[] = states.map((s) => {
    const of = one(s, RND + 'of')!
    components.push(of)
    const role = one(s, LC + 'role')
    const parentState = one(s, RND + 'parent')
    const parent = parentState !== undefined ? (at.get(parentState) ?? -1) : -1
    const num = (p: string) => Number(one(s, RND + p))
    const node: MeasuredNode = { slug: '', parent, x: num('x'), y: num('y'), width: num('width'), height: num('height') }
    if (role) node.part = local(role)
    else {
      const types = store.match(nn(of), nn(RDF_TYPE), null).map((q) => q.object.value)
      node.slug = types.map((t) => slugOf.get(t)).find((x) => x !== undefined) ?? ''
      if (store.match(nn(of), nn(POS + 'direction'), nn(POS + 'Row')).length) node.direction = 'row'
      if (store.match(nn(of), nn(POS + 'layout'), nn(POS + 'FieldRow')).length) node.layout = 'field-row'
    }
    if (one(s, RND + 'scrolls') === 'true') node.scrolls = true
    const line = one(s, RND + 'line')
    if (line !== undefined) node.line = Number(line)
    const sw = one(s, RND + 'scrollWidth')
    const cw = one(s, RND + 'clientWidth')
    if (sw !== undefined && cw !== undefined && Number(sw) > Number(cw)) node.overflowsBy = Number(sw) - Number(cw)
    return node
  })
  // a part's slug is its component's
  for (const n of nodes) if (n.part && n.parent >= 0) n.slug = nodes[n.parent]!.slug
  const vp = 'urn:semblance:rendered:viewport'
  const width = Number(one(vp, RND + 'width') ?? 0)
  const page: MeasuredPage = { url: '', width, height: Number(one(vp, RND + 'height') ?? 0), theme: '', dir: '', scrollWidth: Number(one(vp, RND + 'scrollWidth') ?? width), nodes }
  return { page, components, states }
}

/** A SPARQL finding: the invariant, the group's node (-1: the page), the member (-1 for a group), by. */
export interface SparqlFinding {
  invariant: string
  scope: number
  member: number
  by: number
}

/**
 * The SPARQL checker (lc:Checker's lc:select, its derivations first) over a store holding the
 * ontology, the app's graph and its rendered state: a live store (the rendered graph is read with the
 * default graph), or a page's triples (toTurtle) in the default graph. What the derivations type
 * (lc:FieldRow) goes into a graph of its own for the query and is taken out after it, so a live
 * store is left as it was. `nodeOf` names a finding's scope and member (a component's or a state's IRI);
 * `graphs` are read besides the default and the rendered graph: a live store's projections
 * (urn:semblance:derived:<name>), where the components rules mint (a shape form's fields) are typed.
 */
export function checkSparql(store: GraphStore, nodeOf: (iri: string | undefined) => number = fixtureNode, graphs: string[] = []): SparqlFinding[] {
  const f = store.factory
  const data = [f.defaultGraph(), f.namedNode(RENDERED), ...graphs.map((g) => f.namedNode(g))]
  const derived = f.namedNode('urn:semblance:layout-constraints')
  const g = [...data, derived]
  const added = store
    .select(PREFIXES + `SELECT ?q WHERE { ?cls lc:derive ?q }`, data)
    .flatMap((r) => store.construct(PREFIXES + r.get('q')!.value, data))
    .map((q) => f.quad(q.subject, q.predicate, q.object, derived))
    .filter((q) => !store.has(q))
  for (const q of added) store.add(q)
  try {
    const fragments = new Map(store.select(PREFIXES + `SELECT ?f ?s WHERE { ?f lc:sparql ?s }`, data).map((r) => [local(r.get('f')!.value), r.get('s')!.value]))
    const query = store.select(PREFIXES + `SELECT ?q WHERE { lc:Checker lc:select ?q }`, data)[0].get('q')!.value.replace(/%(\w+)%/g, (_, n) => fragments.get(n)!)
    return store.select(PREFIXES + query, g).map((r) => ({
      invariant: r.get('inv')!.value,
      scope: nodeOf(r.get('scope')?.value),
      member: nodeOf(r.get('member')?.value),
      by: Number(r.get('by')!.value),
    }))
  } finally {
    for (const q of added) store.delete(q)
  }
}
