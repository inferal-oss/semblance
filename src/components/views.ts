// Function rules for general view components and the tooltip layer.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { BEH, C, H, MOD, NS, RDF_TYPE, SEM } from '../ns.ts'
import { owningFocus } from '../rdf.ts'
import { matchTokens } from '../sparql-tokens.ts'
import type { Token } from '../turtle.ts'
import { section, topNode } from './turtle.ts'
import { componentOf, shownNode } from './markup.ts'
import { fullscreenToggles } from '../layers/fullscreen.ts'
import { labelOf as textLabelOf, text, named, rdfList, str } from './util.ts'
import { md5Key } from './data.ts'
import { formatNumber } from '../../rdf-engine/host/intl.ts'

const SH_PREFIX = NS.sh + 'prefix'
const SH_NAMESPACE = NS.sh + 'namespace'

const C_GRAPH_MARK = NS.c + 'GraphMark'
const C_ACTIVE = NS.c + 'active'
const C_BYLINE = NS.c + 'byline'
const NAV_HREF = NS.nav + 'href'
const C_HREF = NS.c + 'href'
const C_MORE_ACTIONS = NS.c + 'moreActions'
const C_MORE_LABEL = NS.c + 'moreLabel'
const C_EXPANDED = NS.c + 'expanded'
const C_FOLDS = NS.c + 'folds'
const C_VIEW_BOX = NS.c + 'viewBox'
const C_PATH_DATA = NS.c + 'pathData'
const C_FILL_RULE = NS.c + 'fillRule'
const C_COLOR = NS.c + 'color'
const C_DECORATIVE = NS.c + 'decorative'
const C_MARK_PATH = NS.c + 'markPath'
const C_MARK_ECHO = NS.c + 'markEcho'
const C_MARK_NODE = NS.c + 'markNode'
const C_CX = NS.c + 'cx'
const C_CY = NS.c + 'cy'
const C_R = NS.c + 'r'

const RDFS_LABEL = NS.rdfs + 'label'

export const labelOf = (ctx: RuleContext, t: Term) =>
  text(ctx, t, C.label) ?? text(ctx, t, RDFS_LABEL) ?? t.value.replace(/^.*[#/]/, '')

// --- Card ----------------------------------------------------------------------------------

const card: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const label = text(ctx, focus, C.label)
  const badge = text(ctx, focus, C.badge)
  const note = text(ctx, focus, C.note)
  const content = ctx.object(focus, C.content)
  const actions = rdfList(ctx, ctx.object(focus, C.actions)).filter(named)
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Div', {}, [o.el('title', 'Div', {}, [o.text('title-text', `── ${label ?? ''} ──`)]), ...(named(content) ? [content] : [])]))
    return o.quads
  }
  const head: NamedNode[] = []
  if (label) head.push(o.el('title', 'H2', {}, [o.text('title-text', label)]))
  if (badge) head.push(o.el('badge', 'Span', { class: 'sem-badge' }, [o.text('badge-text', badge)]))
  if (actions.length) head.push(o.el('actions', 'Div', { class: 'sem-actions' }, actions))
  if (note) head.push(o.el('note', 'P', {}, [o.text('note-text', note)]))
  const parts = [o.el('head', 'Header', {}, head)]
  if (named(content)) parts.push(o.el('body', 'Div', { class: 'sem-card-body' }, [content]))
  o.renders(o.el('root', 'Article', {}, parts))
  return o.quads
}

// --- App bar and its logo ------------------------------------------------------------------

const appbar: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const logo = ctx.object(focus, C.logo)
  const label = text(ctx, focus, C.label) ?? ''
  const subtitle = text(ctx, focus, C.subtitle)
  const actions = rdfList(ctx, ctx.object(focus, C.actions)).filter(named)
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Div', {}, [o.text('line', `${label}${subtitle ? ' — ' + subtitle : ''}`)]))
    return o.quads
  }
  const byline = ctx.object(focus, C_BYLINE)
  // Home: the logo and the name are one link (c:to, resolved as nav:href; else c:href). The byline
  // may hold a link of its own, so it stays outside.
  const href = (ctx.object(focus, NAV_HREF) ?? ctx.object(focus, C_HREF))?.value
  const mark = [...(named(logo) ? [logo] : []), o.el('name', 'Strong', {}, [o.text('name-text', label)])]
  const brand = o.el('brand', 'Div', { class: 'sem-brand' }, [
    ...(href !== undefined ? [o.el('home', 'A', { class: 'sem-home', href }, mark)] : mark),
    ...(subtitle ? [o.el('subtitle', 'Span', {}, [o.text('subtitle-text', subtitle)])] : []),
    ...(named(byline) ? [o.el('byline', 'Span', { class: 'sem-byline' }, [byline])] : []),
  ])
  // The more actions: after the others where there is room, behind a More button on a compact
  // screen (the theme decides which); the button's c:folds opens and closes them (c:expanded).
  const more = rdfList(ctx, ctx.object(focus, C_MORE_ACTIONS)).filter(named)
  const group: NamedNode[] = []
  if (more.length) {
    const open = ctx.object(focus, C_EXPANDED)?.value === 'true'
    const body = o.node('more-body')
    const icon = o.el('more-icon', 'Span', { 'aria-hidden': 'true' }, [o.text('more-icon-text', '⋯')])
    const toggle = o.el(
      'more-toggle',
      'Button',
      {
        type: 'button',
        class: 'sem-more-toggle',
        'aria-expanded': String(open),
        'aria-controls': body.value,
        'aria-label': text(ctx, focus, C_MORE_LABEL) ?? 'More',
        // Open, Escape or a press outside closes it: the toggle says so (the event bus clicks it).
        ...(open ? { 'data-sem-escape': '', 'data-sem-dismiss-outside': '' } : {}),
      },
      [icon],
    )
    o.t(toggle, C_FOLDS, focus)
    group.push(o.el('more', 'Div', { class: 'sem-more', 'data-open': String(open) }, [toggle, o.el('more-body', 'Div', { class: 'sem-more-body', id: body.value }, more)]))
  }
  o.renders(o.el('root', 'Header', {}, [brand, o.el('actions', 'Div', { class: 'sem-actions' }, [...actions, ...group])]))
  return o.quads
}

/** Semblance's mark: the edge, its echo and the nodes declared on c:GraphMark, on a gradient tile. */
const graphmark: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const mark = ctx.nn(C_GRAPH_MARK)
  const d = str(ctx.object(mark, C_MARK_PATH)) ?? ''
  const offset = str(ctx.object(mark, C_MARK_ECHO)) ?? '0'
  const id = 'g' + focus.value.replace(/[^a-z0-9]/gi, '').slice(-12)
  const nodes = ctx
    .match(mark, C_MARK_NODE, null)
    .map((q) => q.object)
    .filter(named)
    .map((n) => ({ order: Number(str(ctx.object(n, SEM.order))), cx: str(ctx.object(n, C_CX)), cy: str(ctx.object(n, C_CY)), r: str(ctx.object(n, C_R)) }))
    .sort((a, b) => a.order - b.order)
  const defs = o.svg('defs', 'Defs', {}, [
    o.svg('gradient', 'LinearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 1 }, [
      o.svg('stop-a', 'Stop', { offset: 0, class: 'sem-stop-a' }),
      o.svg('stop-b', 'Stop', { offset: 1, class: 'sem-stop-b' }),
    ]),
  ])
  const tile = o.svg('tile', 'Rect', { width: 32, height: 32, rx: 9, fill: `url(#${id})` })
  const echo = o.svg('echo', 'Path', { d, transform: `translate(${offset} ${offset})`, class: 'sem-echo' })
  const edge = o.svg('edge', 'Path', { d, class: 'sem-edge' })
  const dots = nodes.map((n) => o.svg(`n${n.order}`, 'Circle', { cx: n.cx, cy: n.cy, r: n.r, class: 'sem-node' }))
  o.renders(o.svg('root', 'Svg', { viewBox: '0 0 32 32', role: 'img', 'aria-label': textLabelOf(ctx, focus) }, [defs, tile, echo, edge, ...dots]))
  return o.quads
}

/** A logo drawn from data: one path in its view box, in its color or the text's. */
const emblem: FnRule = (ctx, focus) => {
  const viewBox = str(ctx.object(focus, C_VIEW_BOX))
  const d = str(ctx.object(focus, C_PATH_DATA))
  if (viewBox === undefined || d === undefined) return []
  const o = ctx.out(focus)
  const decorative = str(ctx.object(focus, C_DECORATIVE)) === 'true'
  const label = decorative ? undefined : textLabelOf(ctx, focus)
  const path = o.svg('path', 'Path', { d, fill: str(ctx.object(focus, C_COLOR)) ?? 'currentColor', 'fill-rule': str(ctx.object(focus, C_FILL_RULE)) ?? 'nonzero' })
  o.renders(o.svg('root', 'Svg', { viewBox, role: decorative ? undefined : 'img', 'aria-label': label, 'aria-hidden': decorative ? 'true' : undefined }, [path]))
  return o.quads
}

/**
 * An IRI as prefix:local by the longest declared namespace it starts with (sh:prefix; the least prefix
 * of equals), the local part percent-decoded, else its last 46 characters: as c:MetricsRendering-sparql.
 */
function compact(ctx: RuleContext, iri: string): string {
  const declared = ctx.memo('metrics:declarations', () =>
    ctx.untraced(() =>
      ctx.match(null, SH_PREFIX, null).flatMap((q) => ctx.objects(q.subject, SH_NAMESPACE).map((ns) => ({ prefix: q.object.value, ns: ns.value }))),
    ),
  )
  let best: { prefix: string; ns: string } | undefined
  for (const d of declared)
    if (iri.startsWith(d.ns) && (!best || d.ns.length > best.ns.length || (d.ns.length === best.ns.length && d.prefix < best.prefix))) best = d
  if (best) {
    const local = iri.slice(best.ns.length)
    let decoded = local
    try {
      decoded = decodeURIComponent(local)
    } catch {}
    return `${best.prefix}:${decoded}`
  }
  return [...iri].length > 48 ? '…' + [...iri].slice(-46).join('') : iri
}

// --- Metrics and Toggle --------------------------------------------------------------------

const metrics: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const of = ctx.object(focus, C.of)
  const fields = rdfList(ctx, ctx.object(focus, C.fields))
  if (!of) return []
  const chips = fields.flatMap((p, i) => {
    if (!named(p)) return []
    const v = ctx.object(of, p)
    if (!v) return []
    const unit = text(ctx, p, C.unit)
    const value =
      v.termType === 'NamedNode'
        ? compact(ctx, v.value)
        : v.termType === 'Literal' && /^-?\d+\.\d+$/.test(v.value)
          ? formatNumber(Number(v.value), 'en-US', 'minimumFractionDigits=2;maximumFractionDigits=2;useGrouping=false')
          : v.value
    const label = text(ctx, p, RDFS_LABEL) || undefined
    // Presentation is declared on the property: c:emphasis, c:hideLabel.
    const emphasis = str(ctx.object(p, C.emphasis)) === 'true'
    const showLabel = label && str(ctx.object(p, C.hideLabel)) !== 'true'
    const chip = o.el(`m${i}`, 'Span', { class: emphasis ? 'sem-metric sem-lead' : 'sem-metric' }, [
      o.el(`m${i}-v`, 'B', {}, [o.text(`m${i}-v-text`, unit ? `${value} ${unit}` : value)]),
      ...(showLabel ? [o.text(`m${i}-l`, label)] : []),
    ])
    o.t(chip, SEM.orderKey, ctx.f.literal(String(i), ctx.nn(NS.xsd + 'integer')))
    if (label) o.tip(chip, label)
    return [chip]
  })
  const root = o.el('root', 'Div', { hidden: chips.length ? undefined : '' })
  for (const chip of chips) o.t(root, H.hasChild, chip)
  o.renders(root)
  return o.quads
}

const toggle: FnRule = (ctx, focus) => {
  const target = ctx.object(focus, C.controls)
  const property = ctx.object(focus, C.property)
  if (!target || !property) return []
  const o = ctx.out(focus)
  const on = ctx.object(target, property)?.value === 'true'
  const label = text(ctx, focus, C.label) ?? textLabelOf(ctx, property)
  const b = o.el('root', 'Button', { type: 'button' }, [o.text('label', label)])
  o.attr(b, 'aria-pressed', String(on))
  const note = text(ctx, focus, C.note)
  if (note) o.tip(b, note)
  o.renders(b)
  return o.quads
}

// --- Query views -----------------------------------------------------------------------------

/** A query view's queries in their list's order, each with its run (c:QueryViewRuns: iv:runOf it), if any. */
function viewRuns(ctx: RuleContext, focus: NamedNode): { q: NamedNode; run?: Term }[] {
  const runs = ctx.objects(focus, NS.iv + 'run')
  return rdfList(ctx, ctx.object(focus, C.queries))
    .filter(named)
    .map((q) => ({ q, run: runs.find((r) => ctx.object(r, NS.iv + 'runOf')?.equals(q)) }))
}

const RS = NS.rs
/** A run's rows as triples: (subject, predicate, object) of each solution. */
function runTriples(ctx: RuleContext, run: Term): [Term, NamedNode, Term][] {
  const out: [Term, NamedNode, Term][] = []
  for (const r of ctx.objects(run, RS + 'solution')) {
    const value = (v: string) => ctx.object(ctx.nn(r.value + '-' + v), RS + 'value')
    const [s, p, o] = [value('subject'), value('predicate'), value('object')]
    if (s && named(p) && o) out.push([s, p, o])
  }
  return out
}

/** Its element: the tokens' (turtle.ts) when its runs have triples, else a sentence. */
const queryview: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const message = (text: string) => {
    o.renders(o.el('root', 'Div', { class: 'sem-empty' }, [o.text('empty', text)]))
    return o.quads
  }
  if (!ctx.sparql) return message('This view runs SPARQL; choose a store with SPARQL (Semblance WASM, Semblance Rust, Oxigraph or Hybrid).')
  const variable = str(ctx.object(focus, C.bindVariable))
  const from = ctx.object(focus, C.bindFrom)
  const property = ctx.object(focus, C.bindProperty)
  const value = from && property ? ctx.object(from, property) : undefined
  if (variable && !named(value)) return message(text(ctx, focus, C.emptyText) ?? 'Nothing selected.')
  const runs = viewRuns(ctx, focus)
  for (const { q, run } of runs) {
    const error = run && ctx.object(run, NS.iv + 'error')
    if (error) return message(`Query ${text(ctx, q, RDFS_LABEL) ?? q.value.replace(/^.*[#/]/, '')} failed: ${error.value}`)
  }
  if (!ctx.objects(focus, NS.iv + 'run').some((r) => ctx.objects(r, RS + 'solution').length)) return message(text(ctx, focus, C.emptyText) ?? 'No results.')
  o.renders(o.el('root', 'Pre', { class: 'sem-turtle' }))
  return o.quads
}

/**
 * What a query view prints: a section per query (by its place in the list, under its label) with the
 * subjects of its run, by the query's sem:orderBy values, then IRI.
 */
const queryviewTurtle: FnRule = (ctx, focus) => {
  const runs = viewRuns(ctx, focus)
  // Nothing while it says something instead: a failed query, a bound variable without a value.
  if (ctx.objects(focus, NS.iv + 'run').some((r) => ctx.object(r, NS.iv + 'error'))) return []
  const from = ctx.object(focus, C.bindFrom)
  const property = ctx.object(focus, C.bindProperty)
  if (str(ctx.object(focus, C.bindVariable)) && !(from && property && named(ctx.object(from, property)))) return []
  const o = ctx.out(focus)
  const pointed = new Set(ctx.objects(focus, NS.iv + 'run').flatMap((r) => runTriples(ctx, r).flatMap(([, , x]) => (x.termType === 'BlankNode' ? [x.value] : []))))
  runs.forEach(({ q, run }, i) => {
    if (!run || ctx.object(run, NS.iv + 'error')) return
    section(ctx, o, i, text(ctx, q, RDFS_LABEL))
    const triples = runTriples(ctx, run)
    const orderBy = ctx.object(q, SEM.orderBy)
    const descending = str(ctx.object(q, SEM.descending)) === 'true'
    const subjects = new Map<string, Term>()
    for (const [s] of triples) if (!(s.termType === 'BlankNode' && pointed.has(s.value))) subjects.set(s.termType + s.value, s)
    for (const s of subjects.values()) {
      let rank: { missing: number; value: number; lexical?: string } | undefined
      if (orderBy) {
        const values = triples.filter(([x, p, v]) => x.equals(s) && p.equals(orderBy) && v.termType === 'Literal' && isNumericLiteral(v)).map(([, , v]) => v)
        const least = values.sort((a, b) => Number(a.value) - Number(b.value))[0]
        rank = least ? { missing: descending ? 0 : 1, value: 0, lexical: (descending ? '-n' : 'n') + least.value } : { missing: descending ? 1 : 0, value: 0 }
      }
      topNode(ctx, o, i, s, { rows: run, rank })
    }
  })
  return o.quads
}

const NUMERIC = new Set(['integer', 'decimal', 'double', 'float', 'long', 'int', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger', 'negativeInteger', 'nonPositiveInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte'].map((t) => NS.xsd + t))
const isNumericLiteral = (v: Term) => v.termType === 'Literal' && NUMERIC.has(v.datatype.value)

/**
 * Source text as lines of tokens of the Turtle highlighter's kinds (Turtle and SPARQL share their
 * lexical forms), each with where it starts (in code points, as c:SourceViewRendering-sparql keys
 * them). A token over several lines (a long string) is cut at the line breaks, each piece keeping
 * its kind.
 */
function sourceLines(text: string): { kind: Token['kind']; text: string; start: number }[][] {
  const kinds = { keyword: 'keyword', var: 'pname', string: 'literal', pname: 'pname', iri: 'iri', number: 'number', comment: 'comment', text: 'punct' } as const
  const lines: { kind: Token['kind']; text: string; start: number }[][] = [[]]
  for (const t of matchTokens(text)) {
    let at = t.start
    t.text.split('\n').forEach((piece, i) => {
      if (i > 0) lines.push([]), at++
      if (piece) lines[lines.length - 1]!.push({ kind: kinds[t.kind], text: piece, start: at })
      at += [...piece].length
    })
  }
  return lines
}

/**
 * A source text, verbatim and colored, under its path: one element per line (numbered, c:line),
 * so a statement's lines can be highlighted (c:SourceHighlight). Lines are keyed by their number:
 * the text does not change while it is shown.
 */
const sourceView: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const source = ctx.object(focus, C.of)
  const body = named(source) ? str(ctx.object(source, NS.c + 'text')) : undefined
  if (body === undefined) {
    o.renders(o.el('root', 'Div', { class: 'sem-empty' }, [o.text('empty', text(ctx, focus, C.emptyText) ?? 'No source.')]))
    return o.quads
  }
  const path = str(ctx.object(source!, NS.c + 'path')) ?? ''
  const pathEl = o.el('path', 'Code', { class: 'sem-source-path' }, [o.text('path-text', path)])
  const head = o.el('head', 'Div', { class: 'sem-source-head' }, [
    o.el('name', 'Span', { class: 'sem-source-name' }, [o.text('name-text', text(ctx, focus, C.label) ?? 'Source')]),
    pathEl,
  ])
  // Its toggles last, after the path but not right after it: a highlighted statement's note goes there.
  if (ctx.modality === MOD.Screen) {
    const toggles = o.el('fullscreen-toggles', 'Span', { class: 'sem-fullscreen-toggles' }, fullscreenToggles(ctx, o, focus))
    o.t(head, H.hasChild, toggles).t(pathEl, NS.ord + 'precedes', toggles)
  }
  const lines = sourceLines(body.replace(/[ \t\n\r]+$/, ''))
  const number = (n: number) => ctx.f.literal(String(n), ctx.nn(NS.xsd + 'integer'))
  const rows = lines.map((tokens, i) => {
    const key = `L${i + 1}`
    // Plain runs are text; colored tokens are spans. The line break belongs to the line it ends.
    const parts = tokens.map((t) => (t.kind === 'punct' || t.kind === 'space' ? o.text(`${key}-${t.start}`, t.text) : o.el(`${key}-${t.start}`, 'Span', { class: 'ttl-' + t.kind }, [o.text(`${key}-${t.start}-text`, t.text)])))
    if (i < lines.length - 1) parts.push(o.text(`${key}-nl`, '\n'))
    const row = o.el(key, 'Span', { class: 'sem-line' }, parts)
    o.t(row, NS.c + 'line', number(i + 1))
    return row
  })
  o.renders(o.el('root', 'Figure', {}, [head, o.el('code', 'Pre', { class: 'sem-turtle sem-source' }, rows)]))
  return o.quads
}

/**
 * The bound element without its RDF/HTML encoding, while c:active: hidden while off, a sentence when
 * bound to nothing, else the element the Turtle printer (the component, turtle.ts) and the markup
 * blocks (the HTML, markup.ts) put their tokens in.
 */
const elementMarkup: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  if (str(ctx.object(focus, C_ACTIVE)) !== 'true') {
    o.renders(o.el('root', 'Div', { hidden: '' }))
    return o.quads
  }
  if (!shownNode(ctx, focus)) {
    o.renders(o.el('root', 'Div', { class: 'sem-empty' }, [o.text('empty', text(ctx, focus, C.emptyText) ?? 'Nothing selected.')]))
    return o.quads
  }
  o.renders(o.el('root', 'Pre', { class: 'sem-turtle sem-markup' }))
  return o.quads
}

/** What an element markup prints as Turtle: the component that rendered the node, under "# the component". */
const elementMarkupTurtle: FnRule = (ctx, focus) => {
  const node = shownNode(ctx, focus)
  if (!node) return []
  const o = ctx.out(focus)
  section(ctx, o, 0, 'the component')
  topNode(ctx, o, 0, componentOf(ctx, node))
  return o.quads
}

/**
 * Marks the selected node. Of its own it renders an empty hidden root: the theme shows the mark
 * only while that root is shown, so a highlight parked out of sight leaves no visible mark.
 */
const highlight: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  o.renders(o.el('root', 'Span', { hidden: '' }))
  const from = ctx.object(focus, C.bindFrom)
  const property = ctx.object(focus, C.bindProperty)
  const node = from && property ? ctx.object(from, property) : undefined
  if (named(node)) o.attr(node, 'data-sem-highlighted', 'true', 'mark')
  return o.quads
}

// --- tooltip layer ---------------------------------------------------------------------------

/** Projects sem:tooltip annotations on nodes minted under the focus. */
const tooltips: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  for (const q of ctx.match(null, SEM.tooltip, null)) {
    const node = q.subject
    if (!named(node) || owningFocus(node.value) !== focus.value) continue
    const svg = ctx.match(node, RDF_TYPE, null).some((t) => t.object.value.startsWith(NS.svg))
    const local = node.value.slice(focus.value.length + 2) + '-tip'
    if (svg) {
      // Only leaf marks get a title (ignoring the title this layer itself adds).
      const tipIri = o.node(local).value
      if (ctx.match(node, H.hasChild, null).some((c) => c.object.value !== tipIri)) continue
      const title = o.svg(local, 'Title', {}, [o.text(local + '-text', q.object.value)])
      o.t(node, H.hasChild, title)
    } else {
      o.attr(node, 'data-sem-tooltip', q.object.value, local)
      o.attr(node, 'aria-description', q.object.value, local + '-aria')
    }
  }
  return o.quads
}

// --- stream members -----------------------------------------------------------------------

const LDES_NS = 'https://w3id.org/ldes#'
const TREE_MEMBER = 'https://w3id.org/tree#member'

const streammembers: FnRule = (ctx, focus) => {
  const stream = ctx.object(focus, C.of)
  if (!named(stream)) return []
  // At most 16: the SPARQL twin walks an unrolled chain of that length.
  const limit = Math.min(Number(str(ctx.object(focus, C.limit)) ?? 8), 16)
  const sequence = ctx.object(stream, LDES_NS + 'sequencePath')
  const rank = (m: Term) => (sequence ? Number(str(ctx.object(m, sequence)) ?? 0) : 0)
  // A stream that names its head (beh:latest / beh:previous) is read in `limit` steps;
  // any other LDES is ranked by its sequence path.
  const members: { m: NamedNode }[] = []
  const head = ctx.object(stream, BEH.latest)
  if (named(head)) {
    for (let m: Term | undefined = head; named(m) && members.length < limit && ctx.object(m, RDF_TYPE); m = ctx.object(m, BEH.previous)) members.push({ m })
  } else {
    members.push(
      ...ctx
        .objects(stream, TREE_MEMBER)
        .filter(named)
        .map((m) => ({ m, n: rank(m) }))
        .sort((a, b) => b.n - a.n)
        .slice(0, limit),
    )
  }
  const o = ctx.out(focus)
  const views = members.map(({ m }) => {
    const view = o.node('m-' + md5Key(m.value))
    o.t(view, RDF_TYPE, ctx.nn(C.TriplesView))
    o.t(view, C.of, m)
    return view
  })
  if (!views.length) {
    o.renders(o.el('root', 'Div', { class: 'sem-empty' }, [o.text('empty', text(ctx, focus, C.emptyText) ?? 'No members yet.')]))
    return o.quads
  }
  o.renders(o.el('root', 'Div', {}, views))
  return o.quads
}

/** The element the Turtle printer puts the node's tokens in (turtle.ttl). */
const triplesview: FnRule = (ctx, focus) => {
  if (!named(ctx.object(focus, C.of))) return []
  const o = ctx.out(focus)
  o.renders(o.el('root', 'Pre', { class: 'sem-turtle' }))
  return o.quads
}

/** What a triples view prints: the node at the top of its one section. */
const triplesviewTurtle: FnRule = (ctx, focus) => {
  const subject = ctx.object(focus, C.of)
  if (!named(subject)) return []
  const o = ctx.out(focus)
  topNode(ctx, o, 0, subject)
  section(ctx, o, 0)
  return o.quads
}

// --- Switch and projection view ------------------------------------------------------------

const switchCases: FnRule = (ctx, focus) => {
  const target = ctx.object(focus, C.controls)
  const property = ctx.object(focus, C.property)
  const current = target && property ? ctx.object(target, property)?.value : undefined
  const o = ctx.out(focus)
  const cases = rdfList(ctx, ctx.object(focus, C.cases)).map((c, i) => {
    const content = ctx.object(c, C.content)
    const on = ctx.object(c, C.when)?.value === current
    return o.el(`case-${i}`, 'Div', { hidden: on ? undefined : '' }, named(content) ? [content] : [])
  })
  o.renders(o.el('root', 'Div', {}, cases))
  return o.quads
}

const hostslot: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const slot = o.el('root', 'Div', {})
  o.t(slot, SEM.slot, str(ctx.object(focus, C.slot)) ?? 'projection')
  o.renders(slot)
  return o.quads
}

export const viewFunctions: Record<string, FnRule> = {
  card,
  appbar,
  graphmark,
  emblem,
  'element-markup': elementMarkup,
  'element-markup:turtle': elementMarkupTurtle,
  'source-view': sourceView,
  metrics,
  toggle,
  queryview,
  highlight,
  tooltips,
  switch: switchCases,
  hostslot,
  streammembers,
  triplesview,
  'triplesview:turtle': triplesviewTurtle,
  'queryview:turtle': queryviewTurtle,
}
