import type { Term } from '@rdfjs/types'
import { RDFS_RANGE, RDFS_SUBCLASS, RDF_FIRST, RDF_NIL, RDF_REST, RDF_TYPE, SEM, STY } from '../ns.ts'
import type { GraphStore } from '../store/types.ts'

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
 */
const hyphens = (decl: string) => decl.slice(0, decl.indexOf(':')).split('-').length

export function compileStyles(store: GraphStore): string {
  const f = store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const objects = (s: Term | null, p: string) => store.match(s, nn(p), null, f.defaultGraph()).map((q) => q.object)
  const object = (s: Term, p: string) => objects(s, p)[0]
  const subjects = (p: string, o: string) => store.match(null, nn(p), nn(o), f.defaultGraph()).map((q) => q.subject)
  const slug = (t: Term) => object(t, SEM.slug)?.value
  const cssVar = (token: Term) => `var(--sem-${slug(token)})`
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
        const value = token ? cssVar(token) : tokens ? list(tokens).map(cssVar).join(' ') : raw
        return prop && value !== undefined ? `${prop}: ${value};` : undefined
      })
      .filter((d): d is string => d !== undefined)
      // RDF object lists are unordered; put shorthands (fewer hyphens) before
      // their longhands so `border` never overrides `border-color`.
      .sort((a, b) => hyphens(a) - hyphens(b) || (a < b ? -1 : 1))
  const block = (selector: string, decls: string[]) => (decls.length ? `  ${selector} { ${decls.join(' ')} }` : undefined)
  const hookAttr = (property: string) => store.match(nn(property), nn(STY.hookAttribute), null)[0]?.object.value
  const sel = (attr: string | undefined, value: string | undefined) => `[${attr}="${value}"]`
  const layer = (name: string, rules: (string | undefined)[], ordered = false) => {
    const body = rules.filter(Boolean)
    if (!ordered) body.sort()
    return body.length ? `@layer sem.${name} {\n${body.join('\n')}\n}` : ''
  }

  const tokens = subjects(RDF_TYPE, STY.Token)
  const densityAttr = hookAttr(STY.density)
  const tokenRules = [
    block(':root', tokens.map((t) => `--sem-${slug(t)}: ${object(t, STY.value)?.value};`).sort()),
    ...subjects(RDF_TYPE, STY.Density).map((d) =>
      block(
        sel(densityAttr, slug(d)),
        objects(d, STY.override).map((o) => `--sem-${slug(object(o, STY.token)!)}: ${object(o, STY.value)?.value};`),
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
    const cssProp = object(q.subject, STY.hookCssProperty)?.value
    const scale = object(q.subject, STY.tokenScale)
    if (cssProp && scale) {
      for (const t of subjects(STY.scale, scale.value)) group.push(block(sel(attr, slug(t)), [`${cssProp}: ${cssVar(t)};`]))
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
  const componentRules: (string | undefined)[] = []
  const variantRules: (string | undefined)[] = []
  const intentRules: (string | undefined)[] = []
  for (const r of subjects(RDF_TYPE, STY.StyleRule)) {
    const cls = object(r, STY.appliesTo)
    const intent = object(r, STY.intent)
    const state = object(r, STY.state)?.value
    const part = object(r, STY.part)?.value
    const when = objects(r, STY.when).map(whenAttr).filter(Boolean).sort().join('')
    // Without sty:appliesTo, a rule styles its part wherever it appears (e.g. a mark any layer
    // may add), or every element carrying its sty:when value.
    if (!cls) {
      if (when) variantRules.push(block(when + (state ?? '') + (part ? ' ' + part : ''), declarations(r)))
      else if (part) componentRules.push(block(part, declarations(r)))
      continue
    }
    // A rule for a class also styles its subclasses (data-sem-c names only the direct class).
    const selector = withSubclasses(cls)
      .map((c) => sel(typeAttr, slug(c)) + when + (intent ? sel(intentAttr, slug(intent)) : '') + (state ?? '') + (part ? ' ' + part : ''))
      .join(', ')
    ;(intent ? intentRules : when ? variantRules : componentRules).push(block(selector, declarations(r)))
  }

  return [
    '@layer sem.tokens, sem.hooks, sem.components, sem.variants, sem.intents;',
    layer('tokens', tokenRules),
    layer('hooks', hookRules, true),
    layer('components', componentRules),
    layer('variants', variantRules),
    layer('intents', intentRules),
  ]
    .filter(Boolean)
    .join('\n\n')
}
