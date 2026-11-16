// Block documents (ontology/components/blocks.ttl): the function twins of the block renderings.
// Each mints the same IRIs and renders the same HTML as its SPARQL sibling. Offsets count
// characters as SPARQL does (code points), so text is sliced as an array of them.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule, RuleContext } from '../engine/context.ts'
import { BLK, C, CO, DND, H, L10N, MOD, NS, OA, ORD, PO, RDF_TYPE, RDFS_SUBCLASS, SEM } from '../ns.ts'
import { encodeForUri, isA, isTrue, named, str, text } from './util.ts'

const RDF_VALUE = NS.rdf + 'value'
const C_EXPANDED = NS.c + 'expanded'
const C_TOGGLES = NS.c + 'toggles'
const SCHEMA = NS.schema
const local = (iri: string) => iri.slice(H.ns.length)

/** The classes of a node with their superclasses (`?x a/rdfs:subClassOf* ?cls`). */
function classes(ctx: RuleContext, node: Term): Set<string> {
  const out = new Set<string>()
  const todo = ctx.objects(node, RDF_TYPE).map((t) => t.value)
  while (todo.length && out.size < 64) {
    const c = todo.pop()!
    if (out.has(c)) continue
    out.add(c)
    for (const s of ctx.objects(c, RDFS_SUBCLASS)) todo.push(s.value)
  }
  return out
}

/** Whether `sub` is a strict subclass of `sup` (`?sub rdfs:subClassOf+ ?sup`). */
function below(ctx: RuleContext, sub: string, sup: string): boolean {
  const seen = new Set<string>()
  const todo = ctx.objects(sub, RDFS_SUBCLASS).map((t) => t.value)
  while (todo.length && seen.size < 64) {
    const c = todo.pop()!
    if (c === sup) return true
    if (seen.has(c)) continue
    seen.add(c)
    for (const s of ctx.objects(c, RDFS_SUBCLASS)) todo.push(s.value)
  }
  return false
}

/** A class-level value of the node's most specific class that has one (blk:element, blk:prefix). */
function nearest(ctx: RuleContext, node: Term, p: string): Term | undefined {
  const own = [...classes(ctx, node)].filter((c) => ctx.object(c, p))
  const best = own.find((c) => !own.some((d) => d !== c && below(ctx, d, c)))
  return best === undefined ? undefined : ctx.object(best, p)
}

const has = (ctx: RuleContext, s: Term, p: string) => ctx.match(s, p, null).length > 0
const valueOf = (ctx: RuleContext, s: Term) => str(ctx.object(s, RDF_VALUE)) ?? ''
const chars = (s: string) => Array.from(s)
const substr = (s: string, from: number, length: number) => chars(s).slice(from, from + length).join('')
const SAFE_LINK = /^(https?:|mailto:|\/|#|[^:]*$)/
const SAFE_IMAGE = /^(https?:|\/|data:image\/|[^:]*$)/
const SAFE_FILE = /^(https?:|\/|[^:]*$)/

/** The block that holds `block` (`?parent po:contains $this`). */
const parentOf = (ctx: RuleContext, block: Term) => ctx.match(null, PO.contains, block)[0]?.subject

interface Mark {
  types: Set<string>
  start: number
  end: number
  target?: Term
}

function marksOf(ctx: RuleContext, block: Term): Mark[] {
  const out: Mark[] = []
  for (const m of ctx.objects(block, BLK.mark)) {
    const start = Number(str(ctx.object(m, OA.start)))
    const end = Number(str(ctx.object(m, OA.end)))
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const types = new Set(ctx.objects(m, RDF_TYPE).map((t) => t.value))
    const target = types.has(BLK.Link) ? ctx.object(m, SCHEMA + 'url') : types.has(BLK.Mention) ? ctx.object(m, OA.hasBody) : undefined
    out.push({ types, start, end, target })
  }
  return out
}

/** The runs of a block's text: each start with the nearest boundary after it (as the SPARQL subquery). */
function runs(ctx: RuleContext, block: Term, marks: Mark[]): { b: number; n: number }[] {
  const raw = ctx.object(block, RDF_VALUE)
  const starts = new Set([0, ...marks.flatMap((m) => [m.start, m.end])])
  const ends = [...(raw ? [chars(raw.value).length] : []), ...marks.flatMap((m) => [m.start, m.end])]
  const out: { b: number; n: number }[] = []
  for (const b of starts) {
    const after = ends.filter((c) => c > b)
    if (after.length) out.push({ b, n: Math.min(...after) })
  }
  return out
}

const covers = (m: Mark, type: string, b: number, n: number) => m.types.has(type) && m.start <= b && m.end >= n

// --- the shared renderings ----------------------------------------------------------------------------

/** A block an editor's caret is in is entered (its sources show); an atom with an address is not editable text. */
const entered: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const root = o.node('root')
  if (ctx.match(null, NS.c + 'focusBlock', focus).length) o.attr(root, 'data-sem-entered', '')
  if (isA(ctx, focus, NS.blk + 'Addressed')) o.t(root, H.ns + 'contenteditable', 'false')
  return o.quads
}

const members: FnRule = (ctx, focus, member) => {
  // A member it no longer holds (re-evaluated for a change to the member itself) renders nothing.
  if (!member || !ctx.match(focus, PO.contains, member).length) return []
  const o = ctx.out(focus)
  const region = o.node(isA(ctx, focus, BLK.TextBlock) || isA(ctx, focus, BLK.Table) ? 'children' : 'root')
  o.t(region, H.hasChild, member)
  const next = ctx.object(member, CO.nextItem)
  const sibling = next && ctx.match(focus, PO.contains, next).length ? next : undefined
  if (ctx.modality === MOD.Text) {
    if (sibling) o.t(member, ORD.immediatelyPrecedes, sibling)
    return o.quads
  }
  // On the screen, a handle before it (inside it, ahead of its first part, for a list's item; none
  // for a table's rows and cells or a layout's columns), carrying it.
  // None in a copy on an editor's clipboard (block-editor.ttl), which is never edited.
  const fixed = [BLK.Row, BLK.Cell, NS.blk + 'Column'].some((c) => isA(ctx, member, c)) || onClipboard(ctx, focus)
  const item = isA(ctx, member, BLK.Item)
  const handleOf = (b: Term) => o.node('handle-' + encodeForUri(b.value))
  if (!fixed) {
    const handle = handleOf(member)
    const first = item ? ctx.nn(member.value + '/~' + (isA(ctx, member, BLK.TodoItem) ? 'check' : 'text')) : member
    o.t(item ? ctx.nn(member.value + '/~root') : region, H.hasChild, handle).t(handle, ORD.immediatelyPrecedes, first)
    o.t(handle, RDF_TYPE, ctx.nn(NS.blk + 'BlockHandle')).t(handle, DND.carries, member)
  }
  if (sibling) o.t(member, ORD.immediatelyPrecedes, fixed || item ? sibling : handleOf(sibling))
  return o.quads
}

/** Whether a block is in an editor's clipboard document, or is it (`?e c:clipboard ?d . ?d po:contains* $this`). */
function onClipboard(ctx: RuleContext, block: Term): boolean {
  for (let b: Term | undefined = block, hops = 0; b && hops < 256; b = parentOf(ctx, b), hops++) if (ctx.match(null, NS.c + 'clipboard', b).length) return true
  return false
}

/** The nodes of an editor's clipboard document: the document, its blocks and their marks. */
function clipboardNodes(ctx: RuleContext, doc: Term): Term[] {
  const out: Term[] = []
  const todo = [doc]
  const seen = new Set<string>()
  while (todo.length) {
    const n = todo.pop()!
    if (seen.has(n.value)) continue
    seen.add(n.value)
    out.push(n, ...ctx.objects(n, NS.blk + 'mark'))
    todo.push(...ctx.objects(n, PO.contains))
  }
  return out
}

/** What to call a block's type: the label of its first class (by IRI) that is a block's. */
function typeName(ctx: RuleContext, block: Term): string | undefined {
  const type = ctx
    .objects(block, RDF_TYPE)
    .map((c) => c.value)
    .filter((c) => c === BLK.Block || below(ctx, c, BLK.Block))
    .sort()[0]
  return type === undefined ? undefined : picked(ctx, ctx.nn(type), NS.rdfs + 'label')
}

/** A block's handle: a grip named after its block (its text's start, else its type), which the drag status says. */
const handle: FnRule = (ctx, focus) => {
  const block = ctx.object(focus, DND.carries)
  if (!block) return []
  const o = ctx.out(focus)
  const start = [...valueOf(ctx, block)].slice(0, 40).join('').replace(/[ \t\n\r]+/g, ' ')
  const name = start !== '' && start !== ' ' ? start : (typeName(ctx, block) ?? '')
  o.t(focus, DND.name, name)
  const label = `${text(ctx, ctx.nn(NS.c + 'BlockHandlePhrase'), NS.rdfs + 'label') ?? ''}: ${name}`
  // Its menu: open, or just closed (the focus comes back to it).
  const open = ctx.match(null, NS.c + 'handleMenuBlock', block).length > 0
  const returning = ctx.match(null, NS.c + 'handleMenuReturn', block).length > 0
  const attrs = { class: 'sem-block-handle', contenteditable: 'false', role: 'button', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': String(open), 'data-sem-takes-focus': returning ? '' : undefined }
  o.renders(o.el('root', 'Span', attrs, [o.el('grip', 'Span', { class: 'sem-grip', 'aria-hidden': 'true' })]))
  return o.quads
}

/** A handle's menu: what the block can turn into, Duplicate and Delete, anchored to the handle. */
const handleMenu: FnRule = (ctx, focus) => {
  const b = ctx.object(focus, NS.c + 'handleMenuBlock')
  const parent = b && ctx.match(null, PO.contains, b)[0]?.subject
  if (!isTrue(ctx.object(focus, NS.c + 'editable')) || !b || !parent) return []
  const o = ctx.out(focus)
  const phrase = (p: string) => text(ctx, ctx.nn(NS.c + p), NS.rdfs + 'label') ?? ''
  const items: NamedNode[] = []
  for (const conv of convertsTo(ctx, classes(ctx, b))) {
    const type = ctx.object(conv, NS.blk + 'to')!
    const order = ctx.object(type, NS.blk + 'menuOrder')
    if (!order) continue
    const local = 'hm-' + encodeForUri(conv.value)
    const item = o.el(local, 'Button', { type: 'button', tabIndex: '-1', role: 'menuitem', 'data-sem-takes-focus': '' }, [o.text(local + '-text', `${phrase('TurnIntoPhrase')} ${picked(ctx, type, NS.rdfs + 'label') ?? ''}`)])
    o.t(item, SEM.orderKey, order.value).t(item, NS.c + 'converts', conv)
    items.push(item)
  }
  for (const [action, p, key, keys] of [['duplicate', 'DuplicatePhrase', '1000', 'Control+D'], ['delete', 'DeletePhrase', '1001', undefined]] as const) {
    const local = 'hm-' + action
    const item = o.el(local, 'Button', { type: 'button', tabIndex: '-1', role: 'menuitem', 'data-sem-takes-focus': '', 'aria-keyshortcuts': keys }, [o.text(local + '-text', phrase(p))])
    o.t(item, SEM.orderKey, key).t(item, NS.blk + 'handleAction', action)
    items.push(item)
  }
  const handleRoot = `${parent.value}/~handle-${encodeForUri(b.value)}/~root`
  const menu = o.el('handle-menu', 'Div', { class: 'sem-handle-menu', role: 'menu', 'aria-label': phrase('BlockHandlePhrase'), 'data-sem-nav-items': '[role=menuitem]', 'data-sem-nav-orientation': 'vertical', 'data-sem-nav-wrap': '', 'data-sem-anchor': handleRoot })
  for (const item of items) o.t(menu, H.hasChild, item)
  o.t(o.node('root'), H.hasChild, menu).t(o.node('body'), ORD.immediatelyPrecedes, menu)
  return o.quads
}

/** A container takes blocks dragged by their handles, into the region its blocks are in, ordered by the chain. */
const dropZone: FnRule = (ctx, focus) => {
  // None in a copy on an editor's clipboard (block-editor.ttl), which nothing is dropped on.
  if (isA(ctx, focus, BLK.Table) || onClipboard(ctx, focus)) return []
  const o = ctx.out(focus)
  o.t(focus, DND.members, ctx.nn(PO.contains)).t(focus, DND.orderBy, ctx.nn(CO.nextItem))
  // A text block's: its children region, shown once it holds blocks (never its whole root, its text).
  const zone = o.node(isA(ctx, focus, BLK.TextBlock) ? 'children' : 'root')
  o.t(focus, DND.zone, zone).t(zone, DND.receptacle, focus)
  // Named by its type, which the drag status says ("Numbered list refuses it").
  const name = typeName(ctx, focus)
  if (name !== undefined) o.t(zone, C.label, name)
  return o.quads
}

/** Objections to a drag into a container: a block its shapes do not allow, or one that would go inside itself. */
const dropObjections: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const word = (phrase: string) => text(ctx, ctx.nn(phrase), NS.rdfs + 'label') ?? ''
  for (const drag of ctx.objects(focus, DND.offered)) {
    const reasons: string[] = []
    for (const b of ctx.objects(drag, DND.carrying)) {
      // Inside itself: the carried block holds the container (or is it).
      const seen = new Set<string>()
      const todo: Term[] = [focus]
      while (todo.length) {
        const x = todo.pop()!
        if (x.value === b.value) {
          reasons.push(word(NS.c + 'InsideItselfPhrase'))
          break
        }
        if (seen.has(x.value)) continue
        seen.add(x.value)
        for (const q of ctx.match(null, PO.contains, x)) todo.push(q.subject)
      }
      const types = classes(ctx, b)
      for (const tc of classes(ctx, focus)) {
        for (const q of ctx.match(null, NS.sh + 'targetClass', tc)) {
          for (const ps of ctx.objects(q.subject, NS.sh + 'property')) {
            if (ctx.object(ps, NS.sh + 'path')?.value !== PO.contains) continue
            for (const required of ctx.objects(ps, NS.sh + 'class')) {
              if (types.has(required.value)) continue
              const said = ctx
                .objects(ps, NS.sh + 'message')
                .filter((m) => m.termType === 'Literal' && (m.language === '' || m.language.toLowerCase().startsWith('en')))
                .map((m) => m.value)
                .sort()[0]
              reasons.push(said ?? word(NS.dnd + 'UnfitPhrase'))
            }
          }
        }
      }
    }
    if (!reasons.length) continue
    const objection = o.node('objection')
    o.t(objection, RDF_TYPE, ctx.nn(NS.dnd + 'Objection')).t(objection, DND.receptacle, focus).t(objection, NS.dnd + 'against', drag)
    o.t(objection, DND.reason, reasons.sort()[0]!)
  }
  return o.quads
}

const textRuns: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const value = valueOf(ctx, focus)
  const textNode = o.el('text', 'Span', { class: 'sem-text', id: o.node('text').value, 'data-sem-text': focus.value })
  const marks = marksOf(ctx, focus)
  for (const { b, n } of runs(ctx, focus, marks)) {
    const base = `run-${b}`
    let inner: NamedNode = o.text(`${base}-t`, substr(value, b, n - b))
    if (marks.some((m) => covers(m, BLK.InlineCode, b, n))) inner = o.el(`${base}-code`, 'Code', {}, [inner])
    if (marks.some((m) => covers(m, BLK.Strike, b, n))) inner = o.el(`${base}-s`, 'S', {}, [inner])
    if (marks.some((m) => covers(m, BLK.Emphasis, b, n))) inner = o.el(`${base}-em`, 'Em', {}, [inner])
    if (marks.some((m) => covers(m, BLK.Strong, b, n))) inner = o.el(`${base}-strong`, 'Strong', {}, [inner])
    const linked = marks.filter((m) => m.target && m.start <= b && m.end >= n)
    if (linked.length) {
      const kind = linked.some((m) => m.types.has(BLK.Link)) ? 'link' : 'mention'
      const target = linked.map((m) => m.target!.value).sort()[0]!
      inner = o.el(`${base}-a`, 'A', { href: SAFE_LINK.test(target) ? target : undefined, 'data-sem-mark': kind }, [inner])
    }
    o.t(textNode, H.hasChild, inner).t(inner, SEM.orderKey, String(b))
  }
  if (value === '' || value.endsWith('\n')) {
    const br = o.el('text-br', 'Br')
    o.t(textNode, H.hasChild, br).t(br, SEM.orderKey, String(chars(value).length))
  }
  return o.quads
}

const escapeMarkdown = (s: string) => s.replace(/([*_`~[\]\\])/g, '\\$1')

const textRunsText: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const value = valueOf(ctx, focus)
  const textNode = o.node('text')
  o.t(textNode, RDF_TYPE, ctx.nn(H.ns + 'Span'))
  const marks = marksOf(ctx, focus)
  const starts = (type: string, b: number) => marks.some((m) => m.types.has(type) && m.start === b)
  const ends = (type: string, n: number) => marks.some((m) => m.types.has(type) && m.end === n)
  for (const { b, n } of runs(ctx, focus, marks)) {
    const chunk = substr(value, b, n - b)
    const code = marks.some((m) => covers(m, BLK.InlineCode, b, n))
    const closing = marks.find((m) => m.target && m.end === n)
    const data = [
      starts(BLK.Link, b) || starts(BLK.Mention, b) ? '[' : '',
      starts(BLK.Strong, b) ? '**' : '',
      starts(BLK.Emphasis, b) ? '_' : '',
      starts(BLK.Strike, b) ? '~~' : '',
      starts(BLK.InlineCode, b) ? '`' : '',
      code ? chunk : escapeMarkdown(chunk),
      ends(BLK.InlineCode, n) ? '`' : '',
      ends(BLK.Strike, n) ? '~~' : '',
      ends(BLK.Emphasis, n) ? '_' : '',
      ends(BLK.Strong, n) ? '**' : '',
      closing ? `](${closing.target!.value})` : '',
    ].join('')
    const t = o.text(`run-${b}`, data)
    o.t(textNode, H.hasChild, t).t(t, SEM.orderKey, String(b))
  }
  return o.quads
}

/** Its children region, when it holds blocks. */
const childrenOf = (ctx: RuleContext, o: ReturnType<RuleContext['out']>, focus: NamedNode, attrs: Record<string, string | undefined> = {}) =>
  has(ctx, focus, PO.contains) ? [o.el('children', 'Div', attrs)] : []

const textBlock: FnRule = (ctx, focus) => {
  const element = nearest(ctx, focus, BLK.element)
  if (!element) return []
  const o = ctx.out(focus)
  const root = o.node('root')
  o.renders(o.el('root', local(element.value), { id: root.value }, [o.node('text'), ...childrenOf(ctx, o, focus, { class: 'sem-children' })]))
  return o.quads
}

/** What a text block's line starts with in the Text modality (blk:linePrefix, derived below the renderings). */
const linePrefix: FnRule = (ctx, focus) => {
  let prefix: string | undefined
  if (isA(ctx, focus, BLK.Item)) {
    let depth = 0
    const seen = new Set<string>()
    for (let p = parentOf(ctx, focus); p && !seen.has(p.value); p = parentOf(ctx, p)) {
      seen.add(p.value)
      if (isA(ctx, p, BLK.List)) depth++
    }
    const list = parentOf(ctx, focus)
    const marker =
      list && isA(ctx, list, BLK.NumberedList) ? '1. ' : isA(ctx, focus, BLK.TodoItem) ? (isTrue(ctx.object(focus, BLK.checked)) ? '- [x] ' : '- [ ] ') : '- '
    prefix = ' '.repeat(Math.min(20, 2 * Math.max(0, depth - 1))) + marker
  } else if (isA(ctx, focus, BLK.Toggle)) prefix = isTrue(ctx.object(focus, C_EXPANDED)) ? '▾ ' : '▸ '
  else if (isA(ctx, focus, BLK.Callout)) prefix = `> ${glyphOf(ctx, focus)} `
  else prefix = str(nearest(ctx, focus, BLK.prefix))
  return prefix === undefined ? [] : ctx.out(focus).t(focus, BLK.linePrefix, prefix).quads
}

const textBlockText: FnRule = (ctx, focus) => {
  if (isA(ctx, focus, BLK.Cell)) return []
  const o = ctx.out(focus)
  const prefix = str(ctx.object(focus, BLK.linePrefix))
  const closed = isA(ctx, focus, BLK.Toggle) && !isTrue(ctx.object(focus, C_EXPANDED))
  const lead = prefix === undefined ? [] : [o.text('lead', prefix)]
  const rows = [o.el('line', 'Pre', {}, [...lead, o.node('text')]), ...(has(ctx, focus, PO.contains) && !closed ? [o.el('children', 'Div')] : [])]
  o.renders(o.el('root', 'Div', {}, rows))
  return o.quads
}

const container: FnRule = (ctx, focus) => {
  const element = nearest(ctx, focus, BLK.element)
  if (!element || isA(ctx, focus, BLK.TextBlock)) return []
  const o = ctx.out(focus)
  o.renders(o.el('root', local(element.value), { id: o.node('root').value }))
  return o.quads
}

const containerText: FnRule = (ctx, focus) => {
  if (!nearest(ctx, focus, BLK.element) || isA(ctx, focus, BLK.TextBlock)) return []
  // The text element of the class that names the element.
  const own = [...classes(ctx, focus)].filter((c) => ctx.object(c, BLK.element))
  const cls = own.find((c) => !own.some((d) => d !== c && below(ctx, d, c)))!
  const element = ctx.object(cls, BLK.textElement)
  const o = ctx.out(focus)
  o.renders(o.el('root', element ? local(element.value) : 'Div'))
  return o.quads
}

const todoItem: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const done = isTrue(ctx.object(focus, BLK.checked))
  const textId = o.node('text').value
  const check = o.el('check', 'Input', { type: 'checkbox', class: 'sem-check', checked: done ? '' : undefined, 'aria-labelledby': textId, contenteditable: 'false' })
  const root = o.node('root')
  o.renders(o.el('root', 'Li', { id: root.value, 'data-sem-done': String(done) }, [check, o.node('text'), ...childrenOf(ctx, o, focus, { class: 'sem-children' })]))
  return o.quads
}

const toggle: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const open = isTrue(ctx.object(focus, C_EXPANDED))
  const children = o.node('children')
  const twisty = o.el('twisty', 'Button', { type: 'button', class: 'sem-twisty', contenteditable: 'false', 'aria-expanded': String(open), 'aria-controls': children.value, 'aria-labelledby': o.node('text').value })
  o.t(twisty, C_TOGGLES, focus)
  const region = o.el('children', 'Div', { class: 'sem-children', id: children.value, hidden: open ? undefined : '' })
  o.renders(o.el('root', 'Div', { id: o.node('root').value, 'data-expanded': String(open) }, [twisty, o.node('text'), region]))
  return o.quads
}

const glyphOf = (ctx: RuleContext, focus: Term) => str(ctx.object(focus, C.icon)) ?? '💡'

const callout: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const icon = o.el('icon', 'Span', { class: 'sem-icon', contenteditable: 'false', 'aria-hidden': 'true' }, [o.text('icon-text', glyphOf(ctx, focus))])
  const body = o.el('body', 'Div', { class: 'sem-body' }, [o.node('text'), ...childrenOf(ctx, o, focus, { class: 'sem-children' })])
  o.renders(o.el('root', 'Div', { id: o.node('root').value, role: 'note' }, [icon, body]))
  return o.quads
}

const divider: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  if (ctx.modality === MOD.Text) o.renders(o.el('root', 'Div', {}, [o.text('line', '---')]))
  else o.renders(o.el('root', 'Hr', { id: o.node('root').value }))
  return o.quads
}

/** A plain text block's text, and a <br> when it is empty or ends in a line break (so the line shows and takes the caret). */
const plainText = (o: ReturnType<RuleContext['out']>, value: string) => [o.text('source', value), ...(value === '' || value.endsWith('\n') ? [o.el('br', 'Br')] : [])]

const code: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const value = valueOf(ctx, focus)
  const language = str(ctx.object(focus, SCHEMA + 'programmingLanguage'))
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Pre', {}, [o.text('source', '```' + (language ?? '') + '\n' + value + '\n```')]))
    return o.quads
  }
  const pre = o.el('pre', 'Pre', {}, [o.el('code', 'Code', { 'data-language': language, 'data-sem-text': focus.value }, plainText(o, value))])
  const label = language === undefined ? [] : [o.el('language', 'Span', { class: 'sem-language' }, [o.text('language-text', language)])]
  // The language field, offering its class's languages (any other can be typed).
  const hint = text(ctx, ctx.nn(NS.c + 'LanguagePhrase'), NS.rdfs + 'label') ?? ''
  const options = o.node('languages')
  const field = o.el('language-field', 'Input', { type: 'text', class: 'sem-language-field', value: language ?? '', placeholder: hint, list: options.value, spellcheck: 'false', 'aria-label': hint })
  o.el('languages', 'Datalist', { id: options.value })
  const offered = new Set<string>()
  for (const cls of classes(ctx, focus)) for (const v of ctx.objects(cls, NS.blk + 'languageOption')) offered.add(v.value)
  for (const v of offered) {
    const opt = o.el('language-' + encodeURIComponent(v), 'Option', { value: v })
    o.t(options, H.hasChild, opt).t(opt, SEM.orderKey, v)
  }
  o.renders(o.el('root', 'Div', { id: o.node('root').value }, [...label, field, options, pre]))
  return o.quads
}

const math: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const value = valueOf(ctx, focus)
  if (ctx.modality === MOD.Text) o.renders(o.el('root', 'Pre', {}, [o.text('source', `$$ ${value} $$`)]))
  else {
    // Typeset by the island (blk:Typeset), the TeX editable beneath it.
    const typeset = o.node('typeset')
    o.t(typeset, RDF_TYPE, ctx.nn(NS.blk + 'Typeset')).t(typeset, C.of, focus)
    o.renders(o.el('root', 'Div', { id: o.node('root').value, role: 'math', 'aria-label': value }, [typeset, o.el('code', 'Code', { 'data-sem-text': focus.value }, plainText(o, value))]))
  }
  return o.quads
}

const table: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  if (ctx.modality === MOD.Text) o.renders(o.el('root', 'Div', {}, [o.el('children', 'Div')]))
  else o.renders(o.el('root', 'Table', { id: o.node('root').value }, [o.el('children', 'Tbody')]))
  return o.quads
}

const cell: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const row = parentOf(ctx, focus)
  const head = !!row && isTrue(ctx.object(row, BLK.header))
  if (ctx.modality !== MOD.Text) {
    // Its column's edge (blk:ResizeColumn), reached by Tab in the first row.
    const raw = str(ctx.object(focus, NS.c + 'width'))
    const width = raw === undefined ? undefined : String(Math.round(Number(raw)))
    const first = !!row && ctx.match(null, CO.nextItem, row).length === 0
    const edge = o.el('edge', 'Span', {
      class: 'sem-resize',
      contenteditable: 'false',
      tabIndex: first ? '0' : '-1',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': text(ctx, ctx.nn(NS.c + 'ColumnWidthPhrase'), NS.rdfs + 'label') ?? '',
      'aria-valuenow': width,
      'aria-valuemin': '48',
      'data-sem-gesture': 'size',
      'data-sem-axis': 'x',
      'data-sem-sizes': 'th, td',
      'data-sem-min': '48',
    })
    const attrs = { id: o.node('root').value, scope: head ? 'col' : undefined, style: width === undefined ? undefined : `width: ${width}px; min-width: ${width}px` }
    o.renders(o.el('root', head ? 'Th' : 'Td', attrs, [o.node('text'), edge]))
    return o.quads
  }
  const last = !has(ctx, focus, CO.nextItem)
  const cells = row ? ctx.objects(row, PO.contains).length : 0
  const rule = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'.slice(0, 4 * cells + 1)
  const end = last ? (head ? ` |\n${rule}` : ' |') : ' '
  o.renders(o.el('root', 'Span', {}, [o.text('lead', '| '), o.node('text'), o.text('tail', end)]))
  return o.quads
}

const image: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const url = str(ctx.object(focus, SCHEMA + 'contentUrl'))
  const caption = str(ctx.object(focus, SCHEMA + 'caption'))
  const description = str(ctx.object(focus, SCHEMA + 'description'))
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Pre', {}, [o.text('line', `![${description ?? caption ?? ''}](${url ?? ''})`)]))
    return o.quads
  }
  const kept = keptFile(ctx, focus)
  const img = o.el('img', 'Img', { src: kept?.url ?? (url !== undefined && SAFE_IMAGE.test(url) ? url : undefined), alt: description ?? '', loading: 'lazy' })
  const figcaption = caption === undefined ? [] : [o.el('caption', 'Figcaption', {}, [o.text('caption-text', caption)])]
  o.renders(o.el('root', 'Figure', { id: o.node('root').value }, [img, ...figcaption]))
  return o.quads
}

const ariaHidden = { 'aria-hidden': 'true' }

/** The latest file a block took (blk:file, by sem:order) with a page address (file:url), if any. */
function keptFile(ctx: RuleContext, block: Term): { url: string; name?: string } | undefined {
  let best: { url: string; name?: string; at: number } | undefined
  for (const f of ctx.objects(block, NS.blk + 'file')) {
    const url = str(ctx.object(f, NS.file + 'url'))
    const at = Number(str(ctx.object(f, SEM.order)) ?? NaN)
    if (url === undefined) continue
    if (!best || at > best.at) best = { url, name: str(ctx.object(f, NS.file + 'name')), at }
  }
  return best
}

const file: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const url = str(ctx.object(focus, SCHEMA + 'contentUrl'))
  const kept = keptFile(ctx, focus)
  const name = kept?.name ?? str(ctx.object(focus, SCHEMA + 'name')) ?? (url === undefined ? '' : url.replace(/^.*\//, ''))
  const size = str(ctx.object(focus, SCHEMA + 'contentSize'))
  const parts = [
    o.el('icon', 'Span', { class: 'sem-icon', ...ariaHidden }, [o.text('icon-text', '📎')]),
    o.el('name', 'Span', { class: 'sem-name' }, [o.text('name-text', name)]),
    ...(size === undefined ? [] : [o.el('size', 'Span', { class: 'sem-size' }, [o.text('size-text', size)])]),
  ]
  const link = o.el('link', 'A', { href: kept?.url ?? (url !== undefined && SAFE_FILE.test(url) ? url : undefined), download: '', class: 'sem-file' }, parts)
  o.renders(o.el('root', 'Div', { id: o.node('root').value }, [link]))
  return o.quads
}

const bookmark: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const url = str(ctx.object(focus, SCHEMA + 'url'))
  const address = url === undefined ? undefined : url.replace(/^[a-z]+:\/\//, '').replace(/\/$/, '')
  const title = str(ctx.object(focus, SCHEMA + 'name')) ?? address ?? ''
  const summary = str(ctx.object(focus, SCHEMA + 'description'))
  const parts = [
    o.el('title', 'Span', { class: 'sem-title' }, [o.text('title-text', title)]),
    ...(summary === undefined ? [] : [o.el('summary', 'Span', { class: 'sem-summary' }, [o.text('summary-text', summary)])]),
    ...(address === undefined ? [] : [o.el('address', 'Span', { class: 'sem-address' }, [o.text('address-text', address)])]),
  ]
  const link = o.el('link', 'A', { href: url !== undefined && SAFE_FILE.test(url) ? url : undefined, class: 'sem-card' }, parts)
  o.renders(o.el('root', 'Div', { id: o.node('root').value }, [link]))
  return o.quads
}

const embed: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const url = str(ctx.object(focus, SCHEMA + 'embedUrl'))
  const title = str(ctx.object(focus, SCHEMA + 'name')) ?? url ?? ''
  const frame = o.el('frame', 'Iframe', { src: url !== undefined && /^https:/.test(url) ? url : undefined, title, loading: 'lazy', sandbox: 'allow-scripts allow-same-origin allow-popups' })
  o.renders(o.el('root', 'Figure', { id: o.node('root').value }, [frame]))
  return o.quads
}

/** A link to a document: its address and name, from the document or the block. */
function documentLinkData(ctx: RuleContext, focus: NamedNode) {
  const doc = ctx.object(focus, BLK.target)
  const docUrl = doc && str(ctx.object(doc, SCHEMA + 'url'))
  const docName = doc && str(ctx.object(doc, SCHEMA + 'name'))
  const url = docUrl ?? str(ctx.object(focus, SCHEMA + 'url'))
  const name = docName ?? str(ctx.object(focus, SCHEMA + 'name')) ?? url ?? (doc ? doc.value.replace(/^.*[#/]/, '') : '')
  return { url, name }
}

const documentLink: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const { url, name } = documentLinkData(ctx, focus)
  const link = o.el('link', 'A', { href: url !== undefined && SAFE_LINK.test(url) ? url : undefined, class: 'sem-page' }, [
    o.el('icon', 'Span', { class: 'sem-icon', ...ariaHidden }, [o.text('icon-text', '📄')]),
    o.el('name', 'Span', { class: 'sem-name' }, [o.text('name-text', name)]),
  ])
  o.renders(o.el('root', 'Div', { id: o.node('root').value }, [link]))
  return o.quads
}

const linkText: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const doc = ctx.object(focus, BLK.target)
  const docUrl = doc && str(ctx.object(doc, SCHEMA + 'url'))
  const docName = doc && str(ctx.object(doc, SCHEMA + 'name'))
  const url = docUrl ?? str(ctx.object(focus, SCHEMA + 'url')) ?? str(ctx.object(focus, SCHEMA + 'embedUrl')) ?? str(ctx.object(focus, SCHEMA + 'contentUrl')) ?? ''
  const name = docName ?? str(ctx.object(focus, SCHEMA + 'name')) ?? url
  const arrow = isA(ctx, focus, BLK.DocumentLink) ? '→ ' : ''
  o.renders(o.el('root', 'Pre', {}, [o.text('line', `${arrow}[${name}](${url})`)]))
  return o.quads
}

const contentsEntry: FnRule = (ctx, focus) => {
  const level = str(nearest(ctx, focus, BLK.level))
  if (level === undefined) return []
  const o = ctx.out(focus)
  const value = valueOf(ctx, focus)
  if (ctx.modality === MOD.Text) {
    o.el('contents-entry', 'Div', {}, [o.text('contents-label', ' '.repeat(Math.min(8, 2 * (Number(level) - 1))) + '- ' + value)])
    return o.quads
  }
  const href = '#' + encodeForUri(o.node('root').value)
  o.el('contents-entry', 'Li', { class: `sem-level-${level}` }, [o.el('contents-link', 'A', { href }, [o.text('contents-label', value)])])
  return o.quads
}

const contents: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const text = ctx.modality === MOD.Text
  const root = text ? o.el('root', 'Div') : o.el('root', 'Nav', { id: o.node('root').value, role: 'doc-toc' })
  o.renders(root)
  const list = text ? root : o.el('list', 'Ol')
  if (!text) o.t(root, H.hasChild, list)
  // The documents it is in; their headings, by how many blocks come before each.
  const docs = new Set<string>()
  const seen = new Set<string>()
  for (let p = parentOf(ctx, focus); p && !seen.has(p.value); p = parentOf(ctx, p)) {
    seen.add(p.value)
    if (isA(ctx, p, BLK.Document)) docs.add(p.value)
  }
  for (const doc of docs) {
    for (const heading of ctx.objects(doc, PO.contains)) {
      if (!named(heading) || !isA(ctx, heading, BLK.Heading)) continue
      let before = 0
      const passed = new Set<string>()
      for (let q = ctx.match(null, CO.nextItem, heading)[0]?.subject; q && !passed.has(q.value); q = ctx.match(null, CO.nextItem, q)[0]?.subject) {
        passed.add(q.value)
        before++
      }
      const entry = ctx.nn(heading.value + '/~contents-entry')
      o.t(list, H.hasChild, entry).t(entry, SEM.orderKey, String(before))
    }
  }
  return o.quads
}

/** An atom (neither text nor a container): the caret goes around it. */
const atom: FnRule = (ctx, focus) => {
  if (isA(ctx, focus, BLK.TextBlock) || isA(ctx, focus, BLK.Container) || isA(ctx, focus, NS.blk + 'PlainTextBlock')) return []
  const o = ctx.out(focus)
  o.t(o.node('root'), H.ns + 'contenteditable', 'false')
  return o.quads
}

// --- the / menu (block-editor.ttl) ----------------------------------------------------------------------

/** Whether the / menu is open (the caret after its "/" in its block), and the text typed after it. */
const menuState: FnRule = (ctx, focus) => {
  const b = ctx.object(focus, NS.c + 'menuBlock')
  const from = Number(str(ctx.object(focus, NS.c + 'menuFrom')))
  const fb = ctx.object(focus, NS.c + 'focusBlock')
  const at = Number(str(ctx.object(focus, NS.c + 'focusOffset')))
  if (!b || !fb || fb.value !== b.value || !(at > from)) return []
  const v = ctx.object(b, RDF_VALUE)
  if (!v || substr(v.value, from, 1) !== (str(ctx.object(focus, NS.c + 'menuTrigger')) ?? '/')) return []
  const q = substr(v.value, from + 1, at - from - 1).toLowerCase()
  if (q.startsWith(' ')) return []
  const chars = [...v.value]
  const blank = chars.slice(0, from).length + chars.slice(at).length === 0
  const bool = (b: boolean) => ctx.f.literal(String(b), ctx.nn(NS.xsd + 'boolean'))
  return ctx.out(focus).t(focus, NS.c + 'menuOpen', bool(true)).t(focus, NS.c + 'foldedQuery', q).t(focus, NS.c + 'menuBlank', bool(blank)).quads
}

/** A text of a class in the viewer's language as the SPARQL rules pick it: its twin, else the untagged one, else English. */
function picked(ctx: RuleContext, cls: Term, p: string): string | undefined {
  const values = ctx.objects(cls, p).filter((t) => t.termType === 'Literal')
  if (values.length > 1) return text(ctx, cls, p)
  return values.find((t) => (t as { language: string }).language === '')?.value ?? values.find((t) => (t as { language: string }).language.toLowerCase().startsWith('en'))?.value
}

/** The block types the menu offers (every class with a blk:menuOrder), as typeahead options of the editor. */
const menuOptions: FnRule = (ctx, focus) => {
  if (!ctx.object(focus, NS.c + 'menuBlock')) return []
  const o = ctx.out(focus)
  const list = o.node('menu-list')
  // After an "@": the resources the editor mentions, by name (their least label, else their IRI; then their IRI).
  if (str(ctx.object(focus, NS.c + 'menuTrigger')) === '@') {
    const found = new Map<string, Term>()
    for (const cls of ctx.objects(focus, NS.blk + 'mentionable')) for (const q of ctx.match(null, RDF_TYPE, cls)) found.set(q.subject.value, q.subject)
    const keyOf = (r: Term) => ctx.objects(r, NS.rdfs + 'label').map((l) => l.value).reduce<string | undefined>((a, b) => (a === undefined || b < a ? b : a), undefined) ?? r.value
    const ranked = [...found.values()].map((r) => ({ r, k: keyOf(r) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.r.value < b.r.value ? -1 : a.r.value > b.r.value ? 1 : 0))
    ranked.forEach(({ r }, i) => {
      const label = picked(ctx, r, NS.rdfs + 'label')
      if (label === undefined) return
      const key = label.toLowerCase()
      const item = o.node('opt-' + encodeForUri(r.value))
      o.t(list, H.hasChild, item)
      o.t(item, RDF_TYPE, ctx.nn(NS.c + 'TypeaheadOption')).t(item, NS.c + 'of', focus).t(item, NS.c + 'option', r)
      o.t(item, C.label, label).t(item, NS.c + 'searchKey', key).t(item, NS.c + 'matchKey', key + ' ')
      const help = picked(ctx, r, C.help)
      if (help !== undefined) o.t(item, C.help, help)
      const icon = ctx.object(r, C.icon)
      if (icon) o.t(item, C.icon, icon)
      o.t(item, NS.c + 'rank', ctx.f.literal(String(i), ctx.nn(NS.xsd + 'integer'))).t(item, SEM.orderKey, String(i))
    })
    return o.quads
  }
  for (const q of ctx.match(null, NS.blk + 'menuOrder', null)) {
    const cls = q.subject as NamedNode
    const label = picked(ctx, cls, NS.rdfs + 'label')
    if (label === undefined) continue
    const key = label.toLowerCase()
    const words = ctx.objects(cls, NS.blk + 'keyword').map((w) => w.value.toLowerCase())
    const item = o.node('opt-' + encodeForUri(cls.value))
    o.t(list, H.hasChild, item)
    o.t(item, RDF_TYPE, ctx.nn(NS.c + 'TypeaheadOption')).t(item, NS.c + 'of', focus).t(item, NS.c + 'option', cls)
    o.t(item, C.label, label).t(item, NS.c + 'searchKey', key).t(item, NS.c + 'matchKey', [key, ...words].join(' '))
    const help = picked(ctx, cls, C.help)
    if (help !== undefined) o.t(item, C.help, help)
    const icon = ctx.object(cls, C.icon)
    if (icon) o.t(item, C.icon, icon)
    o.t(item, NS.c + 'rank', q.object).t(item, SEM.orderKey, q.object.value)
  }
  // On a block with text: what it can turn into (the most specific conversion to each type), first.
  const block = ctx.object(focus, NS.c + 'menuBlock')
  if (block && ctx.object(focus, NS.c + 'menuBlank')?.value === 'false') {
    const kinds = classes(ctx, block)
    const lead = text(ctx, ctx.nn(NS.c + 'TurnIntoPhrase'), NS.rdfs + 'label') ?? ''
    for (const conv of convertsTo(ctx, kinds)) {
      const type = ctx.object(conv, NS.blk + 'to')!
      const order = ctx.object(type, NS.blk + 'menuOrder')
      const name = picked(ctx, type, NS.rdfs + 'label')
      if (!order || name === undefined) continue
      const label = `${lead} ${name}`
      const key = label.toLowerCase()
      const words = ctx.objects(type, NS.blk + 'keyword').map((w) => w.value.toLowerCase())
      const item = o.node('opt-' + encodeForUri(conv.value))
      o.t(list, H.hasChild, item)
      o.t(item, RDF_TYPE, ctx.nn(NS.c + 'TypeaheadOption')).t(item, NS.c + 'of', focus).t(item, NS.c + 'option', conv)
      o.t(item, C.label, label).t(item, NS.c + 'searchKey', key).t(item, NS.c + 'matchKey', [key, ...words].join(' '))
      const help = picked(ctx, type, C.help)
      if (help !== undefined) o.t(item, C.help, help)
      const icon = ctx.object(type, C.icon)
      if (icon) o.t(item, C.icon, icon)
      const rank = rankLiteral(ctx, order, -100)
      o.t(item, NS.c + 'rank', rank).t(item, SEM.orderKey, rank.value)
    }
  }
  return o.quads
}

/** The conversions a block of these classes has: for each type, the most specific one (its source class lowest). */
function convertsTo(ctx: RuleContext, kinds: Set<string>): Term[] {
  const out: Term[] = []
  const all = ctx.match(null, RDF_TYPE, NS.blk + 'Conversion').map((q) => q.subject)
  for (const conv of all) {
    const to = ctx.object(conv, NS.blk + 'to')
    const from = ctx.object(conv, NS.beh + 'sourceClass')
    if (!to || !from || !kinds.has(from.value)) continue
    const better = all.some((other) => {
      const of = ctx.object(other, NS.beh + 'sourceClass')
      return other.value !== conv.value && ctx.object(other, NS.blk + 'to')?.value === to.value && !!of && kinds.has(of.value) && below(ctx, of.value, from.value)
    })
    if (!better) out.push(conv)
  }
  return out
}

/** An order plus a shift, as SPARQL adds them: an integer stays one, a decimal a decimal. */
function rankLiteral(ctx: RuleContext, order: Term, shift: number): Term {
  const integer = order.termType === 'Literal' && order.datatype.value === NS.xsd + 'integer'
  const n = Number(order.value) + shift
  return ctx.f.literal(String(n), ctx.nn(NS.xsd + (integer ? 'integer' : 'decimal')))
}

/** The menu's options shown, by rank, and the active one (c:activeOption when shown, else the first). */
function menuRows(ctx: RuleContext, focus: NamedNode) {
  const q = str(ctx.object(focus, NS.c + 'foldedQuery')) ?? ''
  const shown = ctx
    .match(null, NS.c + 'of', focus)
    .map((t) => t.subject)
    .filter((opt) => ctx.object(opt, NS.c + 'matchKey') && (q === '' || str(ctx.object(opt, NS.c + 'matchKey'))!.includes(q)))
    .map((opt) => ({ cls: ctx.object(opt, NS.c + 'option')!, rank: Number(str(ctx.object(opt, NS.c + 'rank'))) }))
  const chosen = ctx.object(focus, NS.c + 'activeOption')
  const first = shown.length ? Math.min(...shown.map((r) => r.rank)) : undefined
  const rank = shown.find((r) => chosen && r.cls.value === chosen.value)?.rank ?? first
  const active = shown.filter((r) => r.rank === rank).map((r) => r.cls)[0]
  return { shown, active }
}

const TOOLBAR_MARKS: [kind: string, local: string, glyph: string][] = [
  [BLK.Strong, 'strong', 'B'],
  [BLK.Emphasis, 'em', 'I'],
  [BLK.InlineCode, 'code', '</>'],
  [BLK.Strike, 's', 'S'],
  [BLK.Link, 'link', '🔗'],
]

/** The editor's toolbar: mark buttons over a selection in one block; a link's address and its remove button. */
const toolbar: FnRule = (ctx, focus) => {
  if (!isTrue(ctx.object(focus, NS.c + 'editable'))) return []
  const at = (p: string) => ctx.object(focus, NS.c + p)
  const [ab, ao, fb, fo] = [at('anchorBlock'), at('anchorOffset'), at('focusBlock'), at('focusOffset')]
  const link = at('linkMark')
  const href = link && str(ctx.object(link, NS.schema + 'url'))
  const ranged = !!ab && !!fb && ab.value === fb.value && ao?.value !== fo?.value
  const linked = href !== undefined
  if (!ranged && !linked) return []
  const s = Math.min(Number(ao?.value), Number(fo?.value))
  const e = Math.max(Number(ao?.value), Number(fo?.value))
  const o = ctx.out(focus)
  const phrase = (name: string) => text(ctx, ctx.nn(NS.c + name), NS.rdfs + 'label') ?? ''
  const linkBlock = link ? ctx.match(null, BLK.mark, link)[0]?.subject : undefined
  const parts: NamedNode[] = []
  if (ranged) {
    const buttons = TOOLBAR_MARKS.map(([kind, local, glyph], i) => {
      const pressed = marksOf(ctx, ab!).some((m) => covers(m, kind, s, e))
      const btn = o.el(`tb-${local}`, 'Button', { type: 'button', 'aria-pressed': String(pressed), 'aria-label': text(ctx, ctx.nn(kind), NS.rdfs + 'label') }, [o.text(`tb-${local}-text`, glyph)])
      o.t(btn, NS.blk + 'toggles', ctx.nn(kind)).t(btn, SEM.orderKey, String(i + 1))
      return btn
    })
    const group = o.el('toolbar-marks', 'Div', { class: 'sem-marks', 'data-sem-keep-focus': '' })
    for (const b of buttons) o.t(group, H.hasChild, b)
    parts.push(group)
  }
  if (linked) {
    const url = o.el('link-url', 'Input', { type: 'url', value: href, 'aria-label': phrase('LinkAddressPhrase') })
    const remove = o.el('link-remove', 'Button', { type: 'button' }, [o.text('link-remove-text', phrase('RemoveLinkPhrase'))])
    parts.push(o.el('link-row', 'Div', { class: 'sem-link' }, [url, remove]))
  }
  const anchor = (linkBlock ?? ab)!.value + '/~root'
  const bar = o.el('toolbar', 'Div', { class: 'sem-text-toolbar', role: 'toolbar', 'aria-label': phrase('TextToolbarPhrase'), 'data-sem-anchor': anchor }, parts)
  o.t(o.node('root'), H.hasChild, bar).t(o.node('body'), ORD.precedes, bar)
  return o.quads
}

/** What was copied last, out of sight before the editor's body, with its Turtle. */
const clipboard: FnRule = (ctx, focus) => {
  const doc = ctx.object(focus, NS.c + 'clipboard')
  if (!named(doc)) return []
  const o = ctx.out(focus)
  const turtle = o.node('clipboard-turtle')
  o.t(turtle, RDF_TYPE, ctx.nn(NS.c + 'TriplesView'))
  for (const n of clipboardNodes(ctx, doc)) o.t(turtle, C.of, n)
  const box = o.el('clipboard', 'Div', { class: 'sem-clipboard', 'aria-hidden': 'true' }, [doc as NamedNode, turtle])
  o.t(o.node('root'), H.hasChild, box).t(box, ORD.precedes, o.node('body'))
  return o.quads
}

/** A block with an address: a field for it, after what the block shows. */
const addressField: FnRule = (ctx, focus) => {
  const property = nearest(ctx, focus, NS.blk + 'address')
  if (!property) return []
  const o = ctx.out(focus)
  const hint = text(ctx, ctx.nn(NS.c + 'AddressPhrase'), NS.rdfs + 'label') ?? ''
  const field = o.el('address-field', 'Input', { type: 'url', class: 'sem-address-field', value: str(ctx.object(focus, property.value)) ?? '', placeholder: hint, 'aria-label': hint })
  const before = isA(ctx, focus, BLK.Image) ? 'img' : isA(ctx, focus, BLK.Embed) ? 'frame' : 'link'
  o.t(o.node('root'), H.hasChild, field).t(o.node(before), ORD.precedes, field)
  return o.quads
}

const TABLE_ACTIONS: [action: string, local: string][] = [
  ['RowAbove', 'row-above'],
  ['RowBelow', 'row-below'],
  ['ColumnBefore', 'column-before'],
  ['ColumnAfter', 'column-after'],
  ['RemoveRow', 'remove-row'],
  ['RemoveColumn', 'remove-column'],
]

/** The editor's table toolbar, with the caret in a cell: above its table, a button per thing it does to it. */
const tableTools: FnRule = (ctx, focus) => {
  if (!isTrue(ctx.object(focus, NS.c + 'editable'))) return []
  const cell = ctx.object(focus, NS.c + 'focusBlock')
  if (!cell || !isA(ctx, cell, BLK.Cell)) return []
  const row = parentOf(ctx, cell)
  const table = row && parentOf(ctx, row)
  if (!table) return []
  const o = ctx.out(focus)
  const tools = o.el('table-tools', 'Div', {
    class: 'sem-table-tools',
    role: 'toolbar',
    'aria-label': text(ctx, ctx.nn(NS.c + 'TableToolsPhrase'), NS.rdfs + 'label'),
    'data-sem-anchor': table.value + '/~root',
    'data-sem-keep-focus': '',
  })
  TABLE_ACTIONS.forEach(([action, local], i) => {
    const btn = o.el(`tt-${local}`, 'Button', { type: 'button' }, [o.text(`tt-${local}-text`, text(ctx, ctx.nn(NS.blk + action), NS.rdfs + 'label') ?? '')])
    o.t(btn, NS.blk + 'tableAction', ctx.nn(NS.blk + action)).t(btn, SEM.orderKey, String(i + 1))
    o.t(tools, H.hasChild, btn)
  })
  o.t(o.node('root'), H.hasChild, tools).t(o.node('body'), ORD.precedes, tools).t(tools, ORD.precedes, o.node('toolbar'))
  return o.quads
}

const COLUMNS_ACTIONS: [action: string, local: string][] = [
  ['LayoutColumnBefore', 'column-before'],
  ['LayoutColumnAfter', 'column-after'],
  ['RemoveLayoutColumn', 'remove-column'],
]

/** The editor's columns toolbar, with the caret in a layout column (not in a cell): under the columns, a button per thing it does to them. */
const columnsTools: FnRule = (ctx, focus) => {
  if (!isTrue(ctx.object(focus, NS.c + 'editable'))) return []
  const block = ctx.object(focus, NS.c + 'focusBlock')
  if (!block || isA(ctx, block, BLK.Cell)) return []
  let column = parentOf(ctx, block)
  while (column && !isA(ctx, column, NS.blk + 'Column')) column = parentOf(ctx, column)
  const columns = column && parentOf(ctx, column)
  if (!columns) return []
  const o = ctx.out(focus)
  const tools = o.el('columns-tools', 'Div', {
    class: 'sem-table-tools',
    role: 'toolbar',
    'aria-label': text(ctx, ctx.nn(NS.c + 'ColumnsToolsPhrase'), NS.rdfs + 'label'),
    'data-sem-anchor': columns.value + '/~root',
    'data-sem-keep-focus': '',
  })
  COLUMNS_ACTIONS.forEach(([action, local], i) => {
    const btn = o.el(`ct-${local}`, 'Button', { type: 'button' }, [o.text(`ct-${local}-text`, text(ctx, ctx.nn(NS.blk + action), NS.rdfs + 'label') ?? '')])
    o.t(btn, NS.blk + 'columnsAction', ctx.nn(NS.blk + action)).t(btn, SEM.orderKey, String(i + 1))
    o.t(tools, H.hasChild, btn)
  })
  o.t(o.node('root'), H.hasChild, tools).t(o.node('body'), ORD.precedes, tools).t(tools, ORD.precedes, o.node('toolbar'))
  return o.quads
}

/** A block that takes a file: Upload…, after its address field. */
const uploadButton: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const button = o.el('upload', 'Button', { type: 'button', class: 'sem-upload' }, [o.text('upload-text', text(ctx, ctx.nn(NS.c + 'UploadPhrase'), NS.rdfs + 'label') ?? '')])
  o.t(o.node('root'), H.hasChild, button).t(o.node('address-field'), ORD.immediatelyPrecedes, button)
  return o.quads
}

const editor: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const doc = ctx.object(focus, C.of)
  const children = named(doc) ? [doc] : []
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Div', {}, children))
    return o.quads
  }
  const label = str(ctx.object(focus, L10N.label)) ?? text(ctx, focus, C.label)
  const editable = isTrue(ctx.object(focus, NS.c + 'editable'))
  const at = (p: string) => ctx.object(focus, NS.c + p)
  const [ab, ao, fb, fo] = [at('anchorBlock'), at('anchorOffset'), at('focusBlock'), at('focusOffset')]
  const selection = ab && ao && fb && fo ? `${ab.value} ${ao.value} ${fb.value} ${fo.value}` : ''
  const body = o.el('body', 'Div', {
    class: 'sem-body',
    role: editable ? 'textbox' : 'document',
    'aria-label': label,
    'aria-multiline': editable ? 'true' : undefined,
    contenteditable: editable ? 'true' : undefined,
    spellcheck: editable ? 'true' : undefined,
    'data-sem-text-root': editable ? selection : undefined,
  }, children)
  // The / menu, while it is open: below its block, its options shown or why there are none.
  const open = isTrue(ctx.object(focus, NS.c + 'menuOpen'))
  if (editable) o.attr(body, 'aria-expanded', open ? 'true' : 'false').attr(body, 'aria-haspopup', 'listbox')
  const parts = [body]
  if (open) {
    const { shown, active } = menuRows(ctx, focus)
    // Its name and what it says when nothing matches: of block types, or of mentions (opened by an "@").
    const mentioning = str(ctx.object(focus, NS.c + 'menuTrigger')) === '@'
    const phrase = (blocks: string, mentions: string) => text(ctx, ctx.nn(NS.c + (mentioning ? mentions : blocks)), NS.rdfs + 'label')
    const list = o.el('menu-list', 'Ul', { id: o.node('menu-list').value, role: 'listbox', 'aria-label': phrase('BlockMenuPhrase', 'MentionMenuPhrase') })
    const menuParts = [list]
    if (!shown.length) menuParts.push(o.el('menu-empty', 'Div', { class: 'sem-empty' }, [o.text('menu-empty-text', phrase('NoBlocksPhrase', 'NoMentionsPhrase') ?? '')]))
    const block = ctx.object(focus, NS.c + 'menuBlock')!
    parts.push(o.el('menu', 'Div', { class: 'sem-block-menu', 'data-sem-anchor': block.value + '/~root', 'data-sem-keep-focus': '' }, menuParts))
    o.attr(body, 'aria-controls', list.value)
    if (active) {
      const row = ctx.nn(o.node('opt-' + encodeForUri(active.value)).value + '/~root')
      o.attr(body, 'aria-activedescendant', row.value)
      o.attr(row, 'aria-selected', 'true', 'active-aria-selected')
    }
  }
  // Where the caret is, collapsed: its text says what typing / does (shown while the block is empty).
  if (editable && ab && fb && ab.value === fb.value && ao?.value === fo?.value) {
    o.attr(ctx.nn(ab.value + '/~text'), 'data-sem-placeholder', text(ctx, ctx.nn(NS.c + 'TypeSlashPhrase'), NS.rdfs + 'label') ?? '', 'caret-placeholder')
  }
  o.renders(o.el('root', 'Div', {}, parts))
  return o.quads
}

export const functions: Record<string, FnRule> = {
  'blk:members': members,
  'blk:text': textRuns,
  'blk:text-text': textRunsText,
  'blk:text-block': textBlock,
  'blk:text-block-text': textBlockText,
  'blk:container': container,
  'blk:container-text': containerText,
  'blk:line-prefix': linePrefix,
  'blk:todo-item': todoItem,
  'blk:toggle': toggle,
  'blk:callout': callout,
  'blk:divider': divider,
  'blk:code': code,
  'blk:math': math,
  'blk:table': table,
  'blk:cell': cell,
  'blk:image': image,
  'blk:file': file,
  'blk:bookmark': bookmark,
  'blk:embed': embed,
  'blk:document-link': documentLink,
  'blk:link-text': linkText,
  'blk:contents-entry': contentsEntry,
  'blk:contents': contents,
  'blk:editor': editor,
  'blk:atom': atom,
  'blk:toolbar': toolbar,
  'blk:clipboard': clipboard,
  'blk:address-field': addressField,
  'blk:entered': entered,
  'blk:handle': handle,
  'blk:handle-menu': handleMenu,
  'blk:drop-zone': dropZone,
  'blk:drop-objections': dropObjections,
  'blk:table-tools': tableTools,
  'blk:columns-tools': columnsTools,
  'blk:upload-button': uploadButton,
  'blk:menu-state': menuState,
  'blk:menu-options': menuOptions,
}
