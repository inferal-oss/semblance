// What on the page Semblance did not make (ontology/layers/unmanaged.ttl, docs/UNMANAGED.md).
//
// An element is Semblance's when a renderer (DomRenderer) made it from a rendering - its keyOf knows
// it, so it traces back to a graph node and the rule that rendered it - when a host library drew it
// for a graph node (ext:Hosted, through the adapter's keyOf), or when it is inside an island
// (ext:Island) or a custom element the graph names (ext:tag): mounting foreign components is what
// islands are for. Renderers register on the element they render into, so a renderer inside another
// one's slot (a live example's sandbox) is followed too. Everything else that is visible on the page
// - anywhere in the document, not only in the viewport - is a finding: the topmost element of each
// subtree of such elements, with how many visible elements it holds, in one of four categories.
//
// It is one walk of the DOM, reading each renderer's own map (no query per element), and it reads
// layout (checkVisibility, a box), so it runs on demand only: a test's assertion, or the Tools'
// "Not made by Semblance" view, whose request the effect below performs.
import type { NamedNode, Quad } from '@rdfjs/types'
import { NS, RDF_TYPE, RENDERED_GRAPH, XSD_INTEGER } from '../ns.ts'
import { fnv } from '../components/util.ts'
import { liveRenderers, rendererAt, type DomRenderer } from '../render/dom.ts'
import type { Runtime } from '../runtime.ts'

export const UM = 'https://semblance.dev/ns/unmanaged#'
const TREE_MEMBER = 'https://w3id.org/tree#member'

/** What an element not made by Semblance is. */
export type UnmanagedCategory =
  /** Foreign on purpose: a hosted library's own DOM, embedded media. */
  | 'sanctioned'
  /** Inserted by host code: inside a renderer's tree, or marked by one of the framework's effects. */
  | 'host-code'
  /** Injected by an extension or devtools. */
  | 'third-party'
  | 'unknown'

/** The category's individual in the um: vocabulary. */
export const CATEGORY_IRI: Record<UnmanagedCategory, string> = {
  sanctioned: UM + 'Sanctioned',
  'host-code': UM + 'HostCode',
  'third-party': UM + 'ThirdParty',
  unknown: UM + 'Unknown',
}

/** One visible subtree not made by Semblance. */
export interface UnmanagedFinding {
  /** Its topmost element. */
  element: Element
  category: UnmanagedCategory
  /** Why it is in its category: "embedded media", "host-owned slot gallery-host", "data-sem-anchor", … */
  reason: string
  /** How many visible elements it holds, itself included. */
  elements: number
  /** The nearest element Semblance made above it, with its RDF/HTML node and the renderer that made it. */
  near?: { element: Element; key: string; renderer: DomRenderer }
  /** A short selector-like path to it from `near` (or from the document). */
  path: string
  /** The host-owned slot it is in, if it is in one. */
  slot?: string
}

/** What a walk found: the findings, in document order, and how many visible elements there are. */
export interface UnmanagedSurvey {
  findings: UnmanagedFinding[]
  /** Visible elements, Semblance's or not (the renderers' frames not counted). */
  visible: number
  /** Visible elements Semblance made. */
  managed: number
  /** Visible elements in the findings (visible - managed). */
  unmanaged: number
}

export interface UnmanagedOptions {
  /** Whether an element is visible on the page. Default: checkVisibility (with opacity and visibility) and a box of more than a pixel; where there is no layout (linkedom), not hidden. */
  visible?: (el: Element) => boolean
  /** Whether an element's descendants can be visible. Default: it has a box or is display: contents; without layout, not hidden. */
  displayed?: (el: Element) => boolean
  /** Only these categories (default: all). */
  categories?: readonly UnmanagedCategory[]
}

/** Never rendered: not walked. */
const SKIP = new Set(['head', 'script', 'style', 'link', 'meta', 'title', 'template', 'noscript', 'base'])
/** Embedded media: foreign content by nature. */
const MEDIA = new Set(['iframe', 'video', 'audio', 'canvas', 'embed', 'object'])

type CheckVisibility = (options?: { opacityProperty?: boolean; visibilityProperty?: boolean }) => boolean

/** Without layout (linkedom): what is not hidden, nor display: none in its own style, is shown. */
function notHidden(el: Element): boolean {
  return !el.hasAttribute('hidden') && (el as HTMLElement).style?.display !== 'none'
}

function displayedByDefault(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: CheckVisibility }).checkVisibility
  if (!check) return notHidden(el)
  if (check.call(el)) return true
  // No box of its own (display: contents: <sem-host>, a layout's wrapper): its children may have one.
  return el.ownerDocument.defaultView?.getComputedStyle(el).display === 'contents'
}

function visibleByDefault(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: CheckVisibility }).checkVisibility
  if (!check) return notHidden(el)
  if (!check.call(el, { opacityProperty: true, visibilityProperty: true })) return false
  // A box of a pixel or less is a visually hidden one (a live region for assistive technology), not UI.
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && r.width * r.height > 1
}

interface Context {
  renderer?: DomRenderer
  /** Inside an island or a custom element the graph names: Semblance's. */
  island: boolean
  /** Inside a <sem-host>: what the library drew for no graph node is its own. */
  hosted: boolean
  /** The host-owned slot it is in. */
  slot?: string
  near?: UnmanagedFinding['near']
}

/** The visible subtrees of `root` not made by Semblance, and how many visible elements there are. */
export function surveyUnmanaged(root: ParentNode = document, opts: UnmanagedOptions = {}): UnmanagedSurvey {
  const visible = opts.visible ?? visibleByDefault
  const displayed = opts.displayed ?? displayedByDefault
  const wanted = opts.categories && new Set(opts.categories)
  const out: UnmanagedSurvey = { findings: [], visible: 0, managed: 0, unmanaged: 0 }
  // What only frames renderers (the page's mount point, a sandbox's box): neither Semblance's nor not.
  const frames = new Set<Node>()
  for (const r of liveRenderers()) {
    for (let n: Node | null = r.host; n && n !== root; n = n.parentNode ?? (n as ShadowRoot).host ?? null) {
      if (frames.has(n)) break
      frames.add(n)
    }
  }

  const childrenOf = (el: Element): Element[] => {
    const shadow = el.shadowRoot
    return shadow ? [...shadow.children, ...el.children] : [...el.children]
  }
  /** Visible elements in a subtree not made by Semblance. */
  const count = (el: Element): number => {
    if (SKIP.has(el.localName) || !displayed(el)) return 0
    let n = visible(el) ? 1 : 0
    for (const c of childrenOf(el)) n += count(c)
    return n
  }

  const visit = (el: Element, ctx: Context): void => {
    if (SKIP.has(el.localName) || !displayed(el)) return
    const key = ctx.renderer?.keyOf(el)
    const inner = rendererAt(el)
    if (key !== undefined || ctx.island) {
      if (visible(el)) out.visible++, out.managed++
      const node = key !== undefined ? ctx.renderer!.index.nodes.get(key) : undefined
      const next: Context = {
        renderer: inner ?? ctx.renderer,
        island: ctx.island || (!inner && (node?.island !== undefined || node?.tag !== undefined)),
        hosted: !inner && (ctx.hosted || el.localName === 'sem-host'),
        slot: inner ? undefined : (node?.slot ?? ctx.slot),
        near: key !== undefined ? { element: el, key, renderer: ctx.renderer! } : ctx.near,
      }
      // An island's (or a named custom element's) shadow root is its own drawing: Semblance's, as islands are.
      if (el.shadowRoot && !next.island) for (const c of el.shadowRoot.children) visit(c, { ...next, island: true })
      for (const c of el.shadowRoot && !next.island ? el.children : childrenOf(el)) visit(c, next)
      return
    }
    if (inner || frames.has(el)) {
      const next: Context = inner ? { renderer: inner, island: false, hosted: false, near: ctx.near } : ctx
      for (const c of childrenOf(el)) visit(c, next)
      return
    }
    const elements = count(el)
    if (!elements) return
    out.visible += elements
    out.unmanaged += elements
    const [category, reason] = classify(el, ctx)
    if (wanted && !wanted.has(category)) return
    out.findings.push({ element: el, category, reason, elements, near: ctx.near, path: pathOf(el, ctx.near?.element), slot: ctx.slot })
  }

  const top = root.nodeType === 9 ? (root as Document).documentElement : (root as Element)
  // The root may be inside a renderer's tree (a test asks about one component): that renderer's map.
  if (top) visit(top, { island: false, hosted: false, renderer: enclosingRenderer(top) })
  return out
}

/** The elements of `root` that are visible on the page and that Semblance did not make: each finding's topmost element. */
export function unmanagedElements(root: ParentNode = document, opts: UnmanagedOptions = {}): Element[] {
  return surveyUnmanaged(root, opts).findings.map((f) => f.element)
}

/** The renderer whose tree an element is in: the one rendering into its nearest such ancestor. */
function enclosingRenderer(el: Element): DomRenderer | undefined {
  for (let n: Node | null = el.parentNode; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) {
    const r = rendererAt(n)
    if (r) return r
  }
  return undefined
}

/** A framework effect's own element: it bears one of Semblance's hooks. */
function frameworkMark(el: Element): string | undefined {
  for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-sem-')) return a.name
  for (const c of Array.from(el.classList ?? [])) if (c.startsWith('sem-')) return '.' + c
  if (el.localName.startsWith('sem-')) return el.localName
  return undefined
}

function classify(el: Element, ctx: Context): [UnmanagedCategory, string] {
  const tag = el.localName
  if (ctx.hosted) return ['sanctioned', 'hosted component']
  if (MEDIA.has(tag)) return ['sanctioned', 'embedded media']
  const mark = frameworkMark(el)
  if (!mark) {
    // An extension's elements are defined in its own world, not the page's: a custom element the page does not know.
    const registry = el.ownerDocument.defaultView?.customElements
    if (tag.includes('-') && registry && !registry.get(tag)) return ['third-party', 'undefined custom element']
    if (el.parentElement === el.ownerDocument.documentElement) return ['third-party', 'outside <body>']
  }
  if (ctx.slot !== undefined) return ['host-code', `host-owned slot ${ctx.slot}`]
  if (mark) return ['host-code', mark]
  if (ctx.renderer) return ['host-code', 'inside a rendered element']
  return ['unknown', 'outside every renderer']
}

/** tag#id.class, short. */
function describe(el: Element): string {
  let s = el.localName
  if (el.id) s += '#' + el.id
  const cls = Array.from(el.classList ?? [])[0]
  if (cls) s += '.' + cls
  const c = el.getAttribute('data-sem-c')
  if (c) s += `[data-sem-c=${c}]`
  return s
}

/** From the nearest element Semblance made (exclusive) down to `el`, at most four steps. */
function pathOf(el: Element, from: Element | undefined): string {
  const steps: string[] = []
  for (let n: Element | null = el; n && n !== from; n = n.parentElement) {
    steps.unshift(describe(n))
    if (n.localName === 'body') break
  }
  const head = from ? describe(from) + ' > ' : ''
  return head + (steps.length > 4 ? ['…', ...steps.slice(-3)] : steps).join(' > ')
}

// --- what is allowed: categories by kind, the rest by an exception that says why ------------------

/** A site's exception (um:Exception): what it allows, and why. */
export interface UnmanagedException {
  iri: string
  label?: string
  selector?: string
  slot?: string
  category?: UnmanagedCategory
  because?: string
  issue?: string
}

/** What a store says is allowed: the categories allowed by kind (um:allowed), and the exceptions. */
export function readAllowed(store: Pick<Runtime['store'], 'match' | 'factory'>): { categories: Set<UnmanagedCategory>; exceptions: UnmanagedException[] } {
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const dg = f.defaultGraph()
  const one = (s: Quad['subject'], p: string) => store.match(s as NamedNode, nn(p), null, dg)[0]?.object
  const byIri = Object.fromEntries(Object.entries(CATEGORY_IRI).map(([k, v]) => [v, k as UnmanagedCategory]))
  const categories = new Set<UnmanagedCategory>()
  for (const [iri, c] of Object.entries(byIri)) if (one(nn(iri), UM + 'allowed')?.value === 'true') categories.add(c)
  const exceptions = store.match(null, nn(RDF_TYPE), nn(UM + 'Exception'), dg).map((q) => ({
    iri: q.subject.value,
    label: one(q.subject, NS.rdfs + 'label')?.value,
    selector: one(q.subject, UM + 'selector')?.value,
    slot: one(q.subject, UM + 'slot')?.value,
    category: byIri[one(q.subject, UM + 'category')?.value ?? ''],
    because: one(q.subject, UM + 'because')?.value,
    issue: one(q.subject, UM + 'issue')?.value,
  }))
  return { categories, exceptions }
}

/** The exception that allows a finding: all it states holds (one that states neither a selector nor a slot allows nothing). */
export function exceptionFor(finding: UnmanagedFinding, exceptions: readonly UnmanagedException[]): UnmanagedException | undefined {
  return exceptions.find((x) => {
    if (x.selector === undefined && x.slot === undefined) return false
    if (x.category && x.category !== finding.category) return false
    if (x.slot !== undefined && x.slot !== finding.slot) return false
    if (x.selector !== undefined) {
      try {
        if (!finding.element.matches(x.selector)) return false
      } catch {
        return false
      }
    }
    return true
  })
}

/** A finding the guard fails on: not of a category allowed by kind, and no exception allows it. */
export function unexcused(survey: UnmanagedSurvey, allowed: ReturnType<typeof readAllowed>): UnmanagedFinding[] {
  return survey.findings.filter((f) => !allowed.categories.has(f.category) && !exceptionFor(f, allowed.exceptions))
}

// --- the effect: findings in the graph, on request -------------------------------------------------

export interface UnmanagedHost {
  /** The renderers whose graph the findings go into: a finding's um:near is the nearest element one of them made. */
  renderers: () => readonly (DomRenderer | undefined)[]
  /** What to walk (default: the renderers' document). */
  root?: () => ParentNode
  /** After the findings were written (to patch the page). */
  onWrite?: () => void
  options?: UnmanagedOptions
}

/**
 * The host effect of um:Survey: when a survey is asked (um:request um:Run), the page is walked and
 * its findings written into the rendered graph (unrecorded) as the survey's members, replacing the
 * last ones; the finding held in the survey's c:bindProperty of c:bindFrom (a data grid's selection)
 * is marked on the page (data-sem-unmanaged) and scrolled to. Nothing runs until a survey is asked.
 */
export function attachUnmanaged(runtime: Runtime, host: UnmanagedHost): () => void {
  const f = runtime.store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const dg = f.defaultGraph()
  const g = nn(RENDERED_GRAPH)
  /** The elements of the last findings, by finding, and what each survey wrote. */
  const elements = new Map<string, { element: WeakRef<Element>; category: UnmanagedCategory }>()
  const written = new Map<string, Quad[]>()
  let marked: Element | undefined

  const one = (s: string, p: string) => runtime.store.match(nn(s), nn(p), null, dg)[0]?.object
  const selected = (survey: string) => {
    const from = one(survey, NS.c + 'bindFrom')
    const property = one(survey, NS.c + 'bindProperty')
    return from && property ? runtime.store.match(from as NamedNode, property as NamedNode, null, dg)[0]?.object : undefined
  }
  const surveys = () => runtime.store.match(null, nn(RDF_TYPE), nn(UM + 'Survey'), dg).map((q) => q.subject.value)
  const bindings = () => surveys().flatMap((s) => {
    const from = one(s, NS.c + 'bindFrom')
    const p = one(s, NS.c + 'bindProperty')
    return from && p ? [[from.value, p.value] as const] : []
  })
  const mark = () => {
    let next: Element | undefined
    let category: UnmanagedCategory | undefined
    for (const s of surveys()) {
      const picked = selected(s)
      const hit = picked && elements.get(picked.value)
      const el = hit && hit.element.deref()
      if (hit && el?.isConnected) (next = el), (category = hit.category)
    }
    if (marked && marked !== next) marked.removeAttribute('data-sem-unmanaged')
    if (next && category) {
      // Into the upper part of the viewport: below what sticks to the top, above a window docked to the bottom.
      if (next !== marked && next.scrollIntoView) {
        next.scrollIntoView({ block: 'start', inline: 'nearest' })
        const view = next.ownerDocument.defaultView
        view?.scrollBy?.(0, -Math.round(view.innerHeight / 4))
      }
      next.setAttribute('data-sem-unmanaged', category)
    }
    marked = next
  }

  const run = (survey: NamedNode) => {
    const renderers = host.renderers().filter((r): r is DomRenderer => !!r)
    const doc = renderers[0]?.host.ownerDocument ?? (globalThis.document as Document | undefined)
    if (!doc) return
    const found = surveyUnmanaged(host.root?.() ?? doc, host.options)
    const allowed = readAllowed(runtime.store)
    const int = (n: number) => f.literal(String(n), nn(XSD_INTEGER))
    const add: Quad[] = []
    const t = (s: NamedNode, p: string, o: Quad['object']) => add.push(f.quad(s, nn(p), o, g))
    elements.clear()
    // A finding is named by where it is and what it is, so the same element keeps its name from one
    // survey to the next (a selection stays on it) and another one gets a name of its own.
    const seen = new Map<string, number>()
    found.findings.forEach((x, i) => {
      const what = `${x.category} ${x.reason} ${x.path}`
      const nth = (seen.get(what) ?? 0) + 1
      seen.set(what, nth)
      const m = nn(`${survey.value}/~finding-${fnv(`${what} ${nth}`)}`)
      elements.set(m.value, { element: new WeakRef(x.element), category: x.category })
      t(survey, TREE_MEMBER, m)
      t(m, RDF_TYPE, nn(UM + 'Finding'))
      t(m, UM + 'order', int(i + 1))
      t(m, UM + 'category', nn(CATEGORY_IRI[x.category]))
      t(m, UM + 'reason', f.literal(x.reason))
      t(m, UM + 'element', f.literal(x.element.localName))
      t(m, UM + 'path', f.literal(x.path))
      t(m, UM + 'elements', int(x.elements))
      const excused = exceptionFor(x, allowed.exceptions)
      if (excused) t(m, UM + 'exceptedBy', nn(excused.iri))
      // The nearest element one of these renderers made: a node of this graph (a sandbox's are its own).
      for (let a: Element | null = x.element.parentElement; a; a = a.parentElement) {
        const r = renderers.find((r) => r.keyOf(a!) !== undefined)
        const key = r?.keyOf(a)
        if (!r || key === undefined) continue
        t(m, UM + 'near', nn(key))
        const component = r.index.focusOf(key)
        if (component) t(m, UM + 'nearComponent', nn(component))
        break
      }
    })
    t(survey, UM + 'visibleElements', int(found.visible))
    t(survey, UM + 'managedElements', int(found.managed))
    t(survey, UM + 'unmanagedElements', int(found.unmanaged))
    const share = found.visible ? Math.round((found.unmanaged / found.visible) * 1000) / 10 : 0
    t(survey, UM + 'share', f.literal(share.toFixed(1), nn(NS.xsd + 'decimal')))
    t(survey, UM + 'surveyedAt', f.literal(new Date().toISOString(), nn(NS.xsd + 'dateTime')))
    runtime.write(RENDERED_GRAPH, { add, remove: written.get(survey.value) ?? [] })
    written.set(survey.value, add)
    mark()
    host.onWrite?.()
  }

  const stop = runtime.onInput((graph, delta) => {
    if (graph !== undefined) return
    const asked = delta.add.filter((q) => q.predicate.value === UM + 'request')
    // The selection a survey marks (c:bindProperty of its c:bindFrom) moved: only once there are findings.
    const moved = elements.size > 0 && [...delta.add, ...delta.remove].some((q) => bindings().some(([from, p]) => q.subject.value === from && q.predicate.value === p))
    if (asked.length)
      queueMicrotask(() => {
        for (const q of asked) {
          runtime.apply({ add: [], remove: [q] })
          if (q.subject.termType === 'NamedNode') run(q.subject)
        }
      })
    else if (moved) queueMicrotask(mark)
  })
  return () => {
    stop()
    marked?.removeAttribute('data-sem-unmanaged')
    marked = undefined
  }
}
