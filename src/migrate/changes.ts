// The changes (ontology/changes/*.ttl) read for use by the migration tool (#473): each with its
// text for people and agents and its migrations in order.
import type { Quad, Term } from '@rdfjs/types'
import { Parser } from 'n3'
import { NS, RDF_TYPE } from '../ns.ts'

const CHG = NS.chg
const MIG = NS.mig
const RDF_FIRST = NS.rdf + 'first'
const RDF_REST = NS.rdf + 'rest'
const RDF_NIL = NS.rdf + 'nil'

export interface Rename {
  /** An IRI, or a slug (`kind: 'slug'`). */
  old: string
  new: string
  kind: 'term' | 'slug'
}

export interface MigrationStep {
  iri: string
  of?: string
  from?: number
  to?: number
  renames: Rename[]
  forward?: string
  backward?: string
  loses?: string
  discriminator?: string
  examples: { before: string; after: string }[]
}

export interface LoadedChange {
  iri: string
  label: string
  issue?: string
  motivation: string
  substance: string
  forwardGuide: string
  backwardGuide: string
  affects: string[]
  retires: string[]
  after: string[]
  /** The release it shipped in; absent while unreleased. */
  release?: string
  migrations: MigrationStep[]
}

export function loadChanges(texts: string[]): LoadedChange[] {
  const out: LoadedChange[] = []
  for (const text of texts) {
    const quads = new Parser().parse(text) as Quad[]
    const of = (s: Term, p: string) => quads.filter((q) => q.subject.equals(s) && q.predicate.value === p).map((q) => q.object as Term)
    const one = (s: Term, p: string) => of(s, p)[0]?.value
    const list = (head: Term | undefined): Term[] => {
      const items: Term[] = []
      for (let at = head; at && at.value !== RDF_NIL; at = of(at, RDF_REST)[0]) items.push(...of(at, RDF_FIRST))
      return items
    }
    for (const q of quads) {
      if (q.predicate.value !== RDF_TYPE || q.object.value !== CHG + 'Change') continue
      const c = q.subject as Term
      const migrations = list(of(c, CHG + 'migrations')[0]).map((m): MigrationStep => {
        const from = one(m, MIG + 'from')
        const to = one(m, MIG + 'to')
        return {
          iri: m.value,
          of: one(m, MIG + 'of'),
          from: from === undefined ? undefined : Number(from),
          to: to === undefined ? undefined : Number(to),
          renames: of(m, MIG + 'renames').map((r) => {
            const old = of(r, MIG + 'old')[0]!
            return { old: old.value, new: of(r, MIG + 'new')[0]!.value, kind: old.termType === 'Literal' ? ('slug' as const) : ('term' as const) }
          }),
          forward: one(m, MIG + 'forward'),
          backward: one(m, MIG + 'backward'),
          loses: one(m, MIG + 'loses'),
          discriminator: one(m, MIG + 'discriminator'),
          examples: of(m, MIG + 'example').map((e) => ({ before: one(e, MIG + 'before') ?? '', after: one(e, MIG + 'after') ?? '' })),
        }
      })
      const retires = new Set(of(c, CHG + 'retires').map((t) => t.value))
      for (const m of migrations) for (const r of m.renames) if (r.kind === 'term') retires.add(r.old)
      out.push({
        iri: c.value,
        label: one(c, NS.rdfs + 'label') ?? '',
        issue: one(c, CHG + 'issue'),
        motivation: one(c, CHG + 'motivation') ?? '',
        substance: one(c, CHG + 'substance') ?? '',
        forwardGuide: one(c, CHG + 'forwardGuide') ?? '',
        backwardGuide: one(c, CHG + 'backwardGuide') ?? '',
        affects: of(c, CHG + 'affects').map((t) => t.value),
        retires: [...retires],
        after: of(c, CHG + 'after').map((t) => t.value),
        release: one(c, CHG + 'release'),
        migrations,
      })
    }
  }
  return orderChanges(out)
}

/** A change after those it says it comes after; otherwise by name, so the order is stable. */
export function orderChanges(changes: LoadedChange[]): LoadedChange[] {
  const byIri = new Map(changes.map((c) => [c.iri, c]))
  const out: LoadedChange[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (c: LoadedChange) => {
    const s = state.get(c.iri)
    if (s === 'done') return
    if (s === 'visiting') throw new Error(`changes depend on each other: ${c.iri}`)
    state.set(c.iri, 'visiting')
    for (const a of c.after.sort()) if (byIri.has(a)) visit(byIri.get(a)!)
    state.set(c.iri, 'done')
    out.push(c)
  }
  for (const c of [...changes].sort((a, b) => (a.iri < b.iri ? -1 : 1))) visit(c)
  return out
}
