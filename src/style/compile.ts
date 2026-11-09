import type { Term } from '@rdfjs/types'
import { NS, RDFS_RANGE, RDFS_SUBCLASS, RDF_FIRST, RDF_NIL, RDF_REST, RDF_TYPE, SEM, STY } from '../ns.ts'
import type { GraphStore } from '../store/types.ts'
import { cssProblem, propertyProblem, Refused, type SafetyPolicy } from '../safety.ts'

/**
 * Compile the style graph to CSS.
 *
 *   @layer sem.tokens     :root custom properties, density overrides
 *   @layer sem.hooks      values of hookable properties that carry declarations
 *                         (e.g. pos:Row) and token-valued hooks (e.g. pos:gap)
 *   @layer sem.components sty:StyleRule without intent
 *   @layer sem.variants   sty:StyleRule with sty:when (a value of a hooked axis such as
 *                         tone, emphasis or size): wins over the component's base rule
 *   @layer sem.intents    sty:StyleRule with intent (wins over the base rule)
 *
 * A rule with sty:atWidth (a sty:WidthClass such as sty:CompactWidth) is compiled into its
 * layer inside the width class's media condition, after that layer's other rules, so at
 * equal specificity it wins where the condition holds. With several, it applies at any of them.
 * A value with sty:underMedia (mot:System) gets a copy of every rule that selects the value it
 * stands for (mot:Reduced) inside the media condition, at the end of each layer.
 *
 * With a `policy` (authored content, src/safety.ts), every string written from the graph is checked
 * first: a property, a value (sty:raw, a token's, a density's), a slug, a hook attribute, a part, a
 * state, a media condition, a keyframes name and step. A declaration that fails is left out, as is a
 * rule whose selector or condition fails; each is reported through `onRefused`.
 */
const hyphens = (decl: string) => decl.slice(0, decl.indexOf(':')).split('-').length
const STY_AT_WIDTH = NS.sty + 'atWidth'
const STY_MEDIA = NS.sty + 'media'
const STY_UNDER_MEDIA = NS.sty + 'underMedia'
const STY_AS = NS.sty + 'as'

export interface CompileOptions {
  /** Authored content: what the policy refuses is left out. */
  policy?: SafetyPolicy
  /** Hear about each refusal (by default console.warn). */
  onRefused?: (e: Refused) => void
}

export function compileStyles(store: GraphStore, opts: CompileOptions = {}): string {
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const objects = (s: Term | null, p: string) => store.match(s, nn(p), null, f.defaultGraph()).map((q) => q.object)
  const object = (s: Term, p: string) => objects(s, p)[0]
  const subjects = (p: string, o: string) => store.match(null, nn(p), nn(o), f.defaultGraph()).map((q) => q.subject)
  const { policy } = opts
  const reported = new Set<string>()
  /** Whether a string from the graph may be written as `as` (always, without a policy); refusals are reported once. */
  const allowed = (text: string, as: Parameters<typeof cssProblem>[2] | 'property' | 'slug' | 'attribute', at: Term): boolean => {
    if (!policy) return true
    const why =
      as === 'property' ? propertyProblem(policy, text)
      : as === 'slug' ? (/^[A-Za-z0-9_-]+$/.test(text) ? undefined : `"${text}" is not a slug`)
      : as === 'attribute' ? (/^[a-z][a-z0-9-]*$/.test(text) ? undefined : `"${text}" is not an attribute name`)
      : cssProblem(policy, text, as)
    if (!why) return true
    const message = `Refused a style${at.termType === 'NamedNode' ? ` of <${at.value}>` : ''}: ${why}.`
    if (!reported.has(at.value + message)) reported.add(at.value + message), (opts.onRefused ?? ((e) => console.warn(e.message)))(new Refused(at.value, 'style', message))
    return false
  }
  const slug = (t: Term) => {
    const v = object(t, SEM.slug)?.value
    return v === undefined || allowed(v, 'slug', t) ? v : undefined
  }
  const cssVar = (token: Term) => {
    const s = slug(token)
    return s === undefined ? undefined : `var(--sem-${s})`
  }
  const list = (head: Term | undefined) => {
    const out: Term[] = []
    for (let n = head; n && n.value !== RDF_NIL; n = object(n, RDF_REST)) out.push(object(n, RDF_FIRST)!)
    return out
  }
  const declarations = (s: Term) =>
    objects(s, STY.declares)
      .map((d) => {
        const prop = object(d, STY.property)?.value
        const token = object(d, STY.token)
        const tokens = object(d, STY.tokens)
        const raw = object(d, STY.raw)?.value
        const vars = tokens && list(tokens).map(cssVar)
        const value = token ? cssVar(token) : vars ? (vars.includes(undefined) ? undefined : vars.join(' ')) : raw !== undefined && allowed(raw, 'value', d) ? raw : undefined
        return prop && allowed(prop, 'property', d) && value !== undefined ? `${prop}: ${value};` : undefined
      })
      .filter((d): d is string => d !== undefined)
      // RDF object lists are unordered; put shorthands (fewer hyphens) before
      // their longhands so `border` never overrides `border-color`.
      .sort((a, b) => hyphens(a) - hyphens(b) || (a < b ? -1 : 1))
  const block = (selector: string, decls: string[]) => (decls.length ? `  ${selector} { ${decls.join(' ')} }` : undefined)
  const hookAttr = (property: string) => {
    const attr = store.match(nn(property), nn(STY.hookAttribute), null)[0]?.object.value
    return attr === undefined || allowed(attr, 'attribute', nn(property)) ? attr : undefined
  }
  const sel = (attr: string | undefined, value: string | undefined) => `[${attr}="${value}"]`
  const layer = (name: string, rules: (string | undefined)[], ordered = false) => {
    const body = rules.filter(Boolean)
    if (!ordered) body.sort()
    return body.length ? `@layer sem.${name} {\n${body.join('\n')}\n}` : ''
  }

  /** A token's custom property and its value, or nothing when either is refused. */
  const customProperty = (token: Term, value: string | undefined, at: Term): string[] => {
    const s = slug(token)
    return s !== undefined && (value === undefined || allowed(value, 'value', at)) ? [`--sem-${s}: ${value};`] : []
  }
  const tokens = subjects(RDF_TYPE, STY.Token)
  const densityAttr = hookAttr(STY.density)
  const tokenRules = [
    block(':root', tokens.flatMap((t) => customProperty(t, object(t, STY.value)?.value, t)).sort()),
    ...subjects(RDF_TYPE, STY.Density).map((d) =>
      block(
        sel(densityAttr, slug(d)),
        objects(d, STY.override).flatMap((o) => customProperty(object(o, STY.token)!, object(o, STY.value)?.value, o)),
      ),
    ),
  ]

  const hookRules: (string | undefined)[] = []
  // A property that sty:overrides another is emitted after it, so it wins at equal specificity.
  const hooked = store.match(null, nn(STY.hookAttribute), null, f.defaultGraph())
  const rank = new Map<string, number>()
  const depth = (p: string, seen = new Set<string>()): number => {
    if (rank.has(p)) return rank.get(p)!
    if (seen.has(p)) return 0
    seen.add(p)
    const d = Math.max(-1, ...objects(nn(p), STY.overrides).map((o) => depth(o.value, seen))) + 1
    rank.set(p, d)
    return d
  }
  hooked.sort((a, b) => depth(a.subject.value) - depth(b.subject.value) || (a.object.value < b.object.value ? -1 : 1))
  for (const q of hooked) {
    const group: (string | undefined)[] = []
    const attr = q.object.value
    if (!allowed(attr, 'attribute', q.subject)) continue
    const cssProp = object(q.subject, STY.hookCssProperty)?.value
    const scale = object(q.subject, STY.tokenScale)
    if (cssProp && scale && allowed(cssProp, 'property', q.subject)) {
      for (const t of subjects(STY.scale, scale.value)) {
        const v = cssVar(t)
        if (v) group.push(block(sel(attr, slug(t)), [`${cssProp}: ${v};`]))
      }
    }
    // Individuals in the property's range that carry declarations (pos:Row, ...).
    for (const range of objects(q.subject, RDFS_RANGE)) {
      for (const v of subjects(RDF_TYPE, range.value)) group.push(block(sel(attr, slug(v)), declarations(v)))
    }
    hookRules.push(...group.filter(Boolean).sort())
  }

  function withSubclasses(cls: Term): Term[] {
    const out = [cls]
    for (let i = 0; i < out.length; i++) {
      for (const q of store.match(null, nn(RDFS_SUBCLASS), out[i]!, f.defaultGraph())) if (!out.some((c) => c.equals(q.subject))) out.push(q.subject)
    }
    return out.filter((c) => slug(c) !== undefined)
  }

  const typeAttr = hookAttr(RDF_TYPE)
  const intentAttr = hookAttr(STY.intent)
  // sty:when <value>: the attribute of the hooked property whose range the value belongs to.
  const whenAttr = (v: Term) => {
    for (const t of objects(v, RDF_TYPE)) {
      for (const p of subjects(RDFS_RANGE, t.value)) {
        const attr = object(p, STY.hookAttribute)?.value
        if (attr) return sel(attr, slug(v))
      }
    }
    return undefined
  }
  // How deep a class sits under sem:Component: a subclass's rules come after its
  // superclass's, so a refinement (c:NavList of c:Segmented) wins at equal specificity.
  const depthOf = new Map<string, number>()
  const classDepth = (cls: Term): number => {
    if (depthOf.has(cls.value)) return depthOf.get(cls.value)!
    depthOf.set(cls.value, 0)
    const d = Math.max(-1, ...objects(cls, RDFS_SUBCLASS).map(classDepth)) + 1
    depthOf.set(cls.value, d)
    return d
  }
  // [class depth, block, media condition (sty:atWidth) or ''].
  type Ranked = [number, string | undefined, string]
  const ranked = (rules: Ranked[]) => {
    const sorted = rules
      .filter((r): r is [number, string, string] => r[1] !== undefined)
      .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    const plain = sorted.filter((r) => !r[2]).map((r) => r[1])
    // Width-conditioned rules last, one @media block per condition (in a stable order).
    const conditions = [...new Set(sorted.map((r) => r[2]).filter(Boolean))].sort()
    const sized = conditions.map(
      (media) => `  @media ${media} {\n${sorted.filter((r) => r[2] === media).map((r) => '  ' + r[1]).join('\n')}\n  }`,
    )
    return [...plain, ...sized]
  }
  const componentRules: Ranked[] = []
  const variantRules: Ranked[] = []
  const intentRules: Ranked[] = []
  for (const r of subjects(RDF_TYPE, STY.StyleRule)) {
    const classes = objects(r, STY.appliesTo)
    const intent = object(r, STY.intent)
    const state = object(r, STY.state)?.value
    const part = object(r, STY.part)?.value
    if ((state !== undefined && !allowed(state, 'selector', r)) || (part !== undefined && !allowed(part, 'selector', r))) continue
    const when = objects(r, STY.when).map(whenAttr).filter(Boolean).sort().join('')
    // Several width classes: the rule applies at any of them (a media query list).
    const conditions = objects(r, STY_AT_WIDTH)
      .map((w) => object(w, STY_MEDIA)?.value)
      .filter((m): m is string => !!m)
    // A refused condition leaves the rule out (without it, the rule would apply at every width).
    if (!conditions.every((m) => allowed(m, 'media', r))) continue
    const media = conditions.sort().join(', ')
    // Without sty:appliesTo, a rule styles its part wherever it appears (e.g. a mark any layer
    // may add), or every element carrying its sty:when value.
    if (!classes.length) {
      if (when) variantRules.push([0, block(when + (state ?? '') + (part ? ' ' + part : ''), declarations(r)), media])
      else if (part) componentRules.push([0, block(part, declarations(r)), media])
      continue
    }
    // A rule for a class also styles its subclasses (data-sem-c names only the direct class).
    // A part listing several selectors (a, b) is scoped to the component in each. A rule for
    // several classes (one style a family shares) styles each, ranked with the most general
    // of them, so each class's own refinements still come after it.
    const parts = part ? splitSelectors(part) : ['']
    const selector = [...new Set(classes.flatMap(withSubclasses).map((c) => c.value))]
      .map((c) => nn(c))
      .flatMap((c) => parts.map((p) => sel(typeAttr, slug(c)) + when + (intent ? sel(intentAttr, slug(intent)) : '') + (state ?? '') + (p ? ' ' + p : '')))
      .join(', ')
    // No class it applies to has a slug here (an abstract class whose subclasses are not loaded): it styles nothing.
    if (!selector) continue
    const classRank = Math.min(...classes.map(classDepth))
    ;(intent ? intentRules : when ? variantRules : componentRules).push([classRank, block(selector, declarations(r)), media])
  }

  // Animations: sty:Keyframes with sty:name and sty:step [ sty:at "50%" ; sty:declares ... ].
  const keyframes = subjects(RDF_TYPE, STY.Keyframes)
    .map((k) => {
      const name = object(k, STY.name)?.value
      if (!name || !allowed(name, 'name', k)) return undefined
      const steps = objects(k, STY.step)
        .map((st) => ({ at: object(st, STY.at)?.value ?? '0%', decls: declarations(st), st }))
        .filter((st) => allowed(st.at, 'step', st.st))
        .sort((a, b) => (a.at === 'from' ? -1 : b.at === 'from' ? 1 : a.at === 'to' ? 1 : b.at === 'to' ? -1 : parseFloat(a.at) - parseFloat(b.at)))
      return `@keyframes ${name} {\n${steps.map((st) => `  ${st.at} { ${st.decls.join(' ')} }`).join('\n')}\n}`
    })
    .filter((k): k is string => k !== undefined)
    .sort()

  // sty:underMedia: a value styled as another under a media condition (mot:System is mot:Reduced
  // where the system asks for reduced motion). Every rule of a layer that selects the other value
  // is copied, with this value's attribute, into the condition after the layer's other rules.
  const aliases = store.match(null, nn(STY_UNDER_MEDIA), null, f.defaultGraph()).flatMap((q) => {
    const media = object(q.object, STY_MEDIA)?.value
    if (media !== undefined && !allowed(media, 'media', q.object)) return []
    const as = object(q.object, STY_AS)
    const to = as && whenAttr(as)
    const from = whenAttr(q.subject)
    return media && to && from ? [{ media, from, to, bare: to.replace(/"/g, '') }] : []
  })
  const underMedia = (rules: (string | undefined)[]) => {
    const extra: string[] = []
    for (const a of aliases.sort((x, y) => (x.from < y.from ? -1 : 1))) {
      const copies = rules
        .filter((r): r is string => !!r && r.startsWith('  ') && !r.startsWith('  @'))
        .flatMap((r) => {
          const brace = r.indexOf(' { ')
          const selector = r.slice(0, brace)
          if (!selector.includes(a.to) && !selector.includes(a.bare)) return []
          return ['  ' + selector.split(a.to).join(a.from).split(a.bare).join(a.from) + r.slice(brace)]
        })
      if (copies.length) extra.push(`  @media ${a.media} {\n${copies.join('\n')}\n  }`)
    }
    return [...rules, ...extra]
  }

  return [
    ...keyframes,
    '@layer sem.tokens, sem.hooks, sem.components, sem.variants, sem.intents;',
    layer('tokens', tokenRules),
    layer('hooks', underMedia(hookRules), true),
    layer('components', underMedia(ranked(componentRules)), true),
    layer('variants', underMedia(ranked(variantRules)), true),
    layer('intents', underMedia(ranked(intentRules)), true),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Split a selector list on its top-level commas (not those inside :is(), :not(), [attr="a,b"]). */
function splitSelectors(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(list.slice(start).trim())
  return out.filter(Boolean)
}
