// A Jelly-RDF 1.2 writer (docs/JELLY.md): statements in, frames out, one batch at a time, in
// memory bounded by the lookups and the frame size. The engines write the same bytes from the
// same statements (ABI.md "Jelly"); this one serves the stores without them and checks them.
//
// The choices a writer may make, made so that every implementation makes them alike:
// - an IRI splits after its last '#' or '/' (prefix, name); with the prefix lookup disabled, or
//   without either character, the whole IRI is the name (and the prefix the empty one, an entry);
// - each lookup is least-recently-used: a new value takes the next free identifier, then the one
//   used longest ago; a frame ends early when a statement would evict a value the frame uses;
// - a frame holds at most `frameRows` statements;
// - a simple literal has literal kind 0; language tags are listed in order of first use.
import type { Quad, Term } from '@rdfjs/types'
import { JellyError } from './decode.ts'
import { LEN, ProtoWriter, varintSize } from './wire.ts'

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string'

export interface JellyWriterOptions {
  /** 1 triples, 2 quads. */
  physical: 1 | 2
  /** 0 FLAT, 1 MESSAGES. */
  streamType?: 0 | 1
  /** 0 unspecified, 1 RDF 1.1, 2 RDF 1.2 basic, 3 RDF 1.2. */
  rdfVersion?: 0 | 1 | 2 | 3
  maxNames?: number
  maxPrefixes?: number
  maxDatatypes?: number
  /** Statements per frame, at most. */
  frameRows?: number
  name?: string
}

export const WRITER_DEFAULTS = { maxNames: 4096, maxPrefixes: 1024, maxDatatypes: 32, frameRows: 4096 }

/** One least-recently-used lookup: value -> identifier, with the values the current batch uses. */
class Lookup {
  private readonly ids = new Map<string, number>()
  private next = 1
  private last = 0
  readonly touched = new Set<string>()
  /** New entries of the batch, in order: [identifier, value]. */
  readonly fresh: [number, string][] = []

  constructor(readonly max: number) {}

  /** How many of `keys` the batch does not use yet. */
  untouched(keys: Iterable<string>): number {
    let n = 0
    for (const k of keys) if (!this.touched.has(k)) n++
    return n
  }

  /** The identifier of `key` (entering it if new), marking it used by the batch. */
  use(key: string): number {
    let id = this.ids.get(key)
    if (id !== undefined) {
      this.ids.delete(key)
      this.ids.set(key, id)
    } else {
      if (this.next <= this.max) id = this.next++
      else {
        const [old, oldId] = this.ids.entries().next().value as [string, number]
        this.ids.delete(old)
        id = oldId
      }
      this.ids.set(key, id)
      this.fresh.push([id, key])
    }
    this.touched.add(key)
    return id
  }

  id(key: string): number {
    return this.ids.get(key)!
  }

  /** The batch's new entries as packed entries (field `field` of the batch). */
  write(w: ProtoWriter, field: number): void {
    let i = 0
    while (i < this.fresh.length) {
      let j = i + 1
      while (j < this.fresh.length && this.fresh[j]![0] === this.fresh[j - 1]![0] + 1) j++
      const id = this.fresh[i]![0]
      const written = id === this.last + 1 ? 0 : id
      w.message(field, (e) => {
        e.uint(1, written)
        for (let k = i; k < j; k++) e.string(2, this.fresh[k]![1])
      })
      this.last = this.fresh[j - 1]![0]
      i = j
    }
  }

  endBatch(): void {
    this.touched.clear()
    this.fresh.length = 0
  }
}

/** Splits an IRI after its last '#' or '/'. */
export function splitIri(iri: string): [string, string] {
  const i = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'))
  return [iri.slice(0, i + 1), iri.slice(i + 1)]
}

export class JellyWriter {
  readonly options: Required<JellyWriterOptions>
  private readonly names: Lookup
  private readonly prefixes: Lookup
  private readonly datatypes: Lookup
  private started = false
  private rows: [Term, Term, Term, Term | undefined][] = []
  private messageEnds: number[] = []
  private messageStart = 0

  constructor(options: JellyWriterOptions) {
    this.options = { streamType: 0, rdfVersion: 0, name: '', ...WRITER_DEFAULTS, ...options }
    const o = this.options
    if (o.maxNames < 128) throw new JellyError('a name lookup smaller than 128')
    if (o.frameRows < 1) throw new JellyError('frameRows must be positive')
    this.names = new Lookup(o.maxNames)
    this.prefixes = new Lookup(o.maxPrefixes)
    this.datatypes = new Lookup(o.maxDatatypes)
  }

  /** Add a statement; returns the frames it completed (bare `RdfStreamFrame`s). */
  add(q: Quad): Uint8Array[] {
    const out: Uint8Array[] = []
    const keys = this.keys(q)
    const fits = () =>
      this.names.touched.size + this.names.untouched(keys[0]) <= this.names.max &&
      this.prefixes.touched.size + this.prefixes.untouched(keys[1]) <= this.prefixes.max &&
      this.datatypes.touched.size + this.datatypes.untouched(keys[2]) <= this.datatypes.max
    if (!fits()) {
      if (!this.rows.length) throw new JellyError('a statement needs more lookup entries than the lookups hold')
      out.push(this.flush()!)
    }
    for (const k of keys[0]) this.names.use(k)
    for (const k of keys[1]) this.prefixes.use(k)
    for (const k of keys[2]) this.datatypes.use(k)
    const g = q.graph.termType === 'DefaultGraph' ? undefined : q.graph
    this.rows.push([q.subject, q.predicate, q.object, g])
    if (this.rows.length >= this.options.frameRows) out.push(this.flush()!)
    return out
  }

  /** End the current RDF Message (stream type MESSAGES). */
  endMessage(): void {
    if (this.options.streamType !== 1) throw new JellyError('message boundaries in a FLAT stream')
    this.messageEnds.push(this.rows.length - this.messageStart)
    this.messageStart = this.rows.length
  }

  /** The statements added since the last frame, as a frame (undefined when there are none and nothing else to say). */
  flush(): Uint8Array | undefined {
    if (!this.rows.length && this.started && !this.messageEnds.length) return undefined
    const w = new ProtoWriter()
    if (!this.started) {
      this.started = true
      const o = this.options
      w.message(1, (row) =>
        row.message(1, (opts) => {
          if (o.name) opts.string(1, o.name)
          opts.uint(2, o.physical)
          opts.uint(5, o.streamType)
          opts.uint(6, o.rdfVersion)
          opts.uint(9, o.maxNames)
          opts.uint(10, o.maxPrefixes)
          opts.uint(11, o.maxDatatypes)
          opts.uint(15, 3)
        }),
      )
    }
    if (this.rows.length || this.messageEnds.length) w.message(2, (b) => this.batch(b))
    this.rows = []
    this.messageEnds = []
    this.messageStart = 0
    this.names.endBatch()
    this.prefixes.endBatch()
    this.datatypes.endBatch()
    return w.finish().slice()
  }

  /** The lookup values a statement uses: names, prefixes, datatypes. */
  private keys(q: Quad): [Set<string>, Set<string>, Set<string>] {
    const k: [Set<string>, Set<string>, Set<string>] = [new Set(), new Set(), new Set()]
    const o = this.options
    const term = (t: Term, pos: number, inTriple: boolean): void => {
      switch (t.termType) {
        case 'NamedNode': {
          const [prefix, name] = o.maxPrefixes ? splitIri(t.value) : ['', t.value]
          k[0].add(name)
          if (o.maxPrefixes) k[1].add(prefix)
          return
        }
        case 'BlankNode':
          if (pos === 1) throw new JellyError('a blank node predicate')
          return
        case 'Literal': {
          if (pos !== 2) throw new JellyError('a literal outside the object position')
          if (t.language) {
            if ((t as { direction?: string }).direction && o.rdfVersion === 1) throw new JellyError('a base direction in a stream of RDF 1.1')
          } else if (t.datatype.value !== XSD_STRING) {
            if (!o.maxDatatypes) throw new JellyError('a typed literal with the datatype lookup disabled')
            k[2].add(t.datatype.value)
          }
          return
        }
        case 'Quad': {
          if (pos !== 2) throw new JellyError('a triple term outside the object position')
          if (o.rdfVersion === 1 || o.rdfVersion === 2) throw new JellyError('a triple term in a stream without triple terms')
          term(t.subject, 0, true)
          term(t.predicate, 1, true)
          term(t.object, 2, true)
          return
        }
        default:
          throw new JellyError(`a ${t.termType} term${inTriple ? ' in a triple term' : ''}`)
      }
    }
    term(q.subject, 0, false)
    if (q.subject.termType === 'Quad') throw new JellyError('a triple term subject')
    term(q.predicate, 1, false)
    if (q.predicate.termType !== 'NamedNode') throw new JellyError('a predicate that is not an IRI')
    term(q.object, 2, false)
    if (q.graph.termType !== 'DefaultGraph') {
      if (o.physical === 1) throw new JellyError('a statement in a named graph, in a stream of triples')
      if (q.graph.termType !== 'NamedNode' && q.graph.termType !== 'BlankNode') throw new JellyError(`a ${q.graph.termType} graph name`)
      term(q.graph, 0, false)
    }
    return k
  }

  private batch(b: ProtoWriter): void {
    const n = this.rows.length
    b.uint(1, n)
    this.names.write(b, 2)
    this.prefixes.write(b, 3)
    this.datatypes.write(b, 4)
    if (n) {
      for (let c = 0; c < 3; c++) b.message(6 + c, (w) => this.column(w, c))
      if (this.options.physical === 2 && this.rows.some((r) => r[3])) b.message(9, (w) => this.column(w, 3))
    }
    if (this.messageEnds.length) b.packed(15, this.messageEnds)
  }

  /** An `RdfColumn` of position `c` of the batch's statements. */
  private column(w: ProtoWriter, c: number): void {
    const rows = this.rows
    // Runs: each value once per run of equal cells; unbound cells (default graph) as runs too.
    const values: Term[] = []
    const layouts: number[] = []
    let skip = 0
    const token = (kind: number, len: number) => {
      const code = Math.min(len, 15)
      layouts.push(skip * 32 + kind * 16 + code)
      if (code === 15) layouts.push(len - 15)
      skip = 0
    }
    let i = 0
    while (i < rows.length) {
      const v = rows[i]![c]
      let j = i + 1
      if (v === undefined) {
        while (j < rows.length && rows[j]![c] === undefined) j++
        // A trailing unbound run is left to the padding rule.
        if (j < rows.length) token(1, j - i - 1)
      } else {
        while (j < rows.length && rows[j]![c] !== undefined && rows[j]![c]!.equals(v)) j++
        values.push(v)
        if (j - i > 1) token(0, j - i - 2)
        else skip++
      }
      i = j
    }
    // Term types and per-type lists.
    const types = values.map((v) => (v.termType === 'NamedNode' ? 0 : v.termType === 'Literal' ? 1 : v.termType === 'BlankNode' ? 2 : 3))
    if (types.some((t) => t !== types[0])) {
      const kinds = new Uint8Array(Math.ceil(types.length / 4))
      types.forEach((t, k) => (kinds[k >> 2]! |= t << (2 * (k & 3))))
      w.tag(1, LEN)
      w.varint(kinds.length)
      w.bytes(kinds)
    }
    w.packed(2, layouts)
    // IRIs: one sequence.
    const iris = values.filter((v) => v.termType === 'NamedNode')
    const nameIds: number[] = []
    const prefixIds: number[] = []
    let prevName = 0
    for (const v of iris) {
      const [prefix, name] = this.options.maxPrefixes ? splitIri(v.value) : ['', v.value]
      const id = this.names.id(name)
      nameIds.push(id === prevName + 1 ? 0 : id)
      prevName = id
      if (this.options.maxPrefixes) prefixIds.push(this.prefixes.id(prefix))
    }
    w.packed(3, nameIds)
    if (prefixIds.length) {
      if (prefixIds.every((p) => p === prefixIds[0])) w.packed(4, [prefixIds[0]!])
      else w.packed(4, prefixIds.map((p, k) => (k > 0 && p === prefixIds[k - 1] ? 0 : p)))
    }
    // Literals.
    const literals = values.filter((v) => v.termType === 'Literal')
    const langs: string[] = []
    const dirs: number[] = []
    const literalKinds = literals.map((l) => {
      if (l.language) {
        const dir = DIRECTION[(l as { direction?: string }).direction ?? ''] ?? 0
        let j = langs.findIndex((t, k) => t === l.language && dirs[k] === dir)
        if (j < 0) j = langs.push(l.language) - 1
        dirs[j] = dir
        return 2 * (j + 1)
      }
      if (l.datatype.value === XSD_STRING) return 0
      return 2 * this.datatypes.id(l.datatype.value) - 1
    })
    for (const l of literals) w.string(5, l.value)
    if (literalKinds.length && literalKinds.some((v) => v !== literalKinds[0])) w.packed(6, literalKinds)
    else if (literalKinds.length && literalKinds[0]) w.packed(6, [literalKinds[0]])
    for (const t of langs) w.string(7, t)
    if (dirs.some((d) => d)) w.packed(8, dirs)
    // Blank nodes.
    for (const v of values) if (v.termType === 'BlankNode') w.string(9, v.value)
    // Triple terms: one IRI sequence of their own.
    const seq = [0, 0]
    for (const v of values) if (v.termType === 'Quad') w.message(10, (t) => this.tripleTerm(t, v as Quad, seq))
  }

  private rdfIri(w: ProtoWriter, iri: string, seq: number[]): void {
    const [prefix, name] = this.options.maxPrefixes ? splitIri(iri) : ['', iri]
    const p = this.options.maxPrefixes ? this.prefixes.id(prefix) : 0
    const n = this.names.id(name)
    w.uint(1, p === seq[0] ? 0 : p)
    w.uint(2, n === seq[1]! + 1 ? 0 : n)
    if (p) seq[0] = p
    seq[1] = n
  }

  private tripleTerm(w: ProtoWriter, q: Quad, seq: number[]): void {
    if (q.subject.termType === 'NamedNode') w.message(1, (m) => this.rdfIri(m, q.subject.value, seq))
    else w.string(2, q.subject.value)
    w.message(5, (m) => this.rdfIri(m, q.predicate.value, seq))
    const o = q.object
    if (o.termType === 'NamedNode') w.message(9, (m) => this.rdfIri(m, o.value, seq))
    else if (o.termType === 'BlankNode') w.string(10, o.value)
    else if (o.termType === 'Literal')
      w.message(11, (m) => {
        if (o.value) m.string(1, o.value)
        if (o.language) {
          m.string(2, o.language)
          m.uint(4, DIRECTION[(o as { direction?: string }).direction ?? ''] ?? 0)
        } else if (o.datatype.value !== XSD_STRING) m.uint(3, this.datatypes.id(o.datatype.value))
      })
    else w.message(12, (m) => this.tripleTerm(m, o as Quad, seq))
  }
}

const DIRECTION: Record<string, number> = { '': 0, ltr: 1, rtl: 2 }

/** A frame with its length in front (the delimited variant, for files and HTTP bodies). */
export function delimit(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(varintSize(frame.length) + frame.length)
  const w = new ProtoWriter()
  w.varint(frame.length)
  out.set(w.finish())
  out.set(frame, out.length - frame.length)
  return out
}

/** Write statements as a whole delimited stream. */
export function writeJelly(quads: Iterable<Quad>, options: JellyWriterOptions): Uint8Array {
  const w = new JellyWriter(options)
  const parts: Uint8Array[] = []
  for (const q of quads) for (const f of w.add(q)) parts.push(delimit(f))
  const last = w.flush()
  if (last) parts.push(delimit(last))
  let size = 0
  for (const p of parts) size += p.length
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) out.set(p, (at += p.length) - p.length)
  return out
}
