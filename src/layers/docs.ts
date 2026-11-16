// The ontology docs layer (ontology/layers/docs.ttl): what the components on a
// gallery specimen are, shown as Turtle read from the graph that renders them.
import type { NamedNode, Quad, Term } from '@rdfjs/types'
import type { ReactionFn } from '../behaviour/events.ts'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { formatLocale } from '../engine/context.ts'
import { sortKey } from '../../rdf-engine/host/intl.ts'
import { compareKeys, TUPLE } from '../render/order-key.ts'
import { md5Key } from '../components/data.ts'
import { BEH, C, H, NS, ORD, RDF_TYPE, RDFS_SUBCLASS, SEM, XSD_BOOLEAN } from '../ns.ts'
import { encodeForUri, isTrue, labelOf, named, nodes, rdfList, text } from '../components/util.ts'
import { section, topNode } from '../components/turtle.ts'

const S = NS.sem
const RDFS_DOMAIN = NS.rdfs + 'domain'
/** Plumbing a specimen is made of rather than what it shows. */
const PLUMBING = new Set([C.Stack, NS.c + 'Specimen', NS.c + 'Flippable', NS.c + 'Grid', NS.c + 'Surface'].map(String))
/** Properties through which a specimen's components hold other components. */
const HOLDS = ['children', 'items', 'content', 'front', 'tabs', 'actions', 'steps', 'body'].map((p) => NS.c + p)

function isComponentClass(ctx: RuleContext, cls: string): boolean {
  return ctx.memo('component? ' + cls, () =>
    ctx.untraced(() => {
      const seen = new Set<string>()
      const todo = [cls]
      while (todo.length) {
        const c = todo.shift()!
        if (c === SEM.Component) return true
        if (seen.has(c)) continue
        seen.add(c)
        todo.push(...ctx.objects(ctx.nn(c), RDFS_SUBCLASS).map((t) => t.value))
      }
      return false
    }),
  )
}

/** The component classes used by a specimen's components (through lists and holding properties, at any depth). */
function classesUsed(ctx: RuleContext, specimen: Term): NamedNode[] {
  const found = new Map<string, NamedNode>()
  const seen = new Set<string>()
  const visit = (node: Term) => {
    if (!named(node) || seen.has(node.value)) return
    seen.add(node.value)
    for (const t of ctx.objects(node, RDF_TYPE)) if (named(t) && isComponentClass(ctx, t.value) && !PLUMBING.has(t.value)) found.set(t.value, t)
    for (const p of HOLDS) {
      for (const v of ctx.objects(node, p)) {
        const members = ctx.object(v, NS.rdf + 'first') ? rdfList(ctx, v) : [v]
        for (const m of members) visit(m)
      }
    }
  }
  for (const child of nodes(ctx, ctx.object(specimen, C.children))) visit(child)
  return [...found.values()]
}

const specimenOntology: FnRule = (ctx, focus) => {
  const classes = ctx.untraced(() => classesUsed(ctx, focus))
  if (!classes.length) return []
  const open = isTrue(ctx.object(focus, S + 'showsOntology'))
  const o = ctx.out(focus)
  // In the viewer's collation of their labels, as order keys (sx:sortKey), as the SPARQL rule places them.
  ctx.readsLanguage()
  const lang = formatLocale(ctx.languages)
  const sorted = classes
    .map((cls) => ({ cls, order: TUPLE + 's' + sortKey(labelOf(ctx, cls), lang), name: o.node('docs-classes-' + md5Key(cls.value)) }))
    .sort((a, b) => compareKeys(a.order, b.order) || (a.name.value < b.name.value ? -1 : a.name.value > b.name.value ? 1 : 0))
  const short = (c: Term) => c.value.replace(NS.c, 'c:')
  const names = o.el('docs-classes', 'Span')
  sorted.forEach(({ cls, order, name }, i) => {
    o.t(names, H.hasChild, name).t(name, RDF_TYPE, ctx.nn(H.Text)).t(name, H.data, (i ? ' · ' : '') + short(cls)).t(name, SEM.orderKey, order)
  })
  const toggle = o.el('docs-toggle', 'Button', { type: 'button', class: 'sem-docs-toggle', 'aria-expanded': String(open) }, [
    o.el('docs-title', 'Strong', {}, [o.text('docs-title-text', text(ctx, ctx.nn(S + 'DocsLayer'), NS.rdfs + 'label') ?? 'ontology')]),
    names,
    o.el('docs-chevron', 'Span', { class: 'sem-chevron', 'aria-hidden': 'true' }),
  ])
  o.t(toggle, S + 'revealsOntology', focus).t(toggle, SEM.orderKey, TUPLE + 'n0')
  const section = o.el('docs', 'Div', { class: 'sem-docs' })
  o.t(section, H.hasChild, toggle)
  if (open) {
    for (const { cls, order } of sorted) {
      const doc = o.node('doc-' + encodeForUri(cls.value.replace(/^.*[#/]/, '')))
      o.t(doc, RDF_TYPE, ctx.nn(NS.c + 'ClassDoc')).t(doc, C.of, cls).t(section, H.hasChild, doc).t(doc, SEM.orderKey, TUPLE + 'n1' + order)
    }
  }
  // After the specimen's stage, inside its root (the specimen rule chains header -> stage).
  o.t(ctx.nn(focus.value + '/~root'), H.hasChild, section).t(ctx.nn(focus.value + '/~stage'), ORD.precedes, section)
  return o.quads
}

/** The class a class doc shows: c:of, or what c:bindProperty of c:bindFrom holds (a selection, as the reference has). */
function shownClass(ctx: RuleContext, focus: NamedNode): NamedNode | undefined {
  const from = ctx.object(focus, C.bindFrom)
  const bound = ctx.object(focus, C.bindProperty)
  const cls = ctx.object(focus, C.of) ?? (named(from) && named(bound) ? ctx.object(from, bound) : undefined)
  return named(cls) ? cls : undefined
}

/** The element the Turtle printer puts the class's tokens in (turtle.ttl). */
const classDoc: FnRule = (ctx, focus) => {
  if (!shownClass(ctx, focus)) return []
  const o = ctx.out(focus)
  o.renders(o.el('root', 'Pre', { class: 'sem-turtle', tabindex: '0' }))
  return o.quads
}

/**
 * What a class doc prints, a section each: the class; the properties whose rdfs:domain it is; its
 * renderings and their rules; what layers it is for render; its reactions; its SHACL shapes.
 */
const classDocTurtle: FnRule = (ctx, focus) => {
  const cls = shownClass(ctx, focus)
  if (!cls) return []
  const o = ctx.out(focus)
  const subjects = (p: string) => ctx.match(null, p, cls).map((q) => q.subject)
  const renderings = subjects(S + 'targets')
  const sections: [string, Term[]][] = [
    ['the class', [cls]],
    ['its properties', subjects(RDFS_DOMAIN)],
    ['how it renders', [...renderings, ...renderings.flatMap((r) => ctx.match(null, S + 'implements', r).map((q) => q.subject))]],
    ['what the layer renders', subjects(S + 'layer')],
    ['how it reacts', subjects(BEH.sourceClass)],
    ['what a valid one looks like', subjects(NS.sh + 'targetClass')],
  ]
  sections.forEach(([title, members], i) => {
    if (!members.length) return
    section(ctx, o, i, title)
    const seen = new Set<string>()
    for (const s of members) {
      if (s.termType === 'Literal' || seen.has(s.termType + s.value)) continue
      seen.add(s.termType + s.value)
      topNode(ctx, o, i, s)
    }
  })
  return o.quads
}

const toggleOntology: ReactionFn = (ctx) => {
  const f = ctx.runtime.store.factory
  for (let n = ctx.object(ctx.event, BEH.node), hops = 0; n && hops < 32; hops++, n = ctx.match(null, H.hasChild, n)[0]?.subject) {
    if (ctx.object(n, S + 'revealsOntology')?.equals(ctx.target)) {
      const current = ctx.match(ctx.target, S + 'showsOntology', null)
      const open = current.some((q) => q.object.value === 'true')
      return { remove: current, add: [f.quad(ctx.target, f.namedNode(S + 'showsOntology'), f.literal(String(!open), f.namedNode(XSD_BOOLEAN)))] }
    }
  }
  return { add: [], remove: [] }
}

export const docsFunctions: Record<string, FnRule> = { 'docs:specimen': specimenOntology, 'class-doc': classDoc, 'class-doc:turtle': classDocTurtle }
export const docsReactions: Record<string, ReactionFn> = { 'docs:toggle': toggleOntology }
