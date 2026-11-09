// A Jelly-RDF reader (docs/JELLY.md): one frame at a time, in bounded memory. It reads Jelly-RDF
// 1.2 (version tag 3, the column layout) and 1.0 and 1.1 (tags 1 and 2, the row layout). The
// engines (rdf-engine/, ABI.md "Jelly") read the same streams the same way; this one serves the
// stores without them (N3, Oxigraph) and checks them.
import type { BlankNode, Literal, NamedNode, Quad, Quad_Graph, Term } from '@rdfjs/types'
import { JellyError, LEN, ProtoReader, VARINT } from './wire.ts'

export { JellyError }

const RDF_LANG = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString'
const RDF_DIR_LANG = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#dirLangString'

/** The RDF/JS factory a reader makes terms with (a literal with a base direction: `{ language, direction }`). */
export interface JellyFactory {
  namedNode(value: string): NamedNode
  blankNode(value?: string): BlankNode
  literal(value: string, languageOrDatatype?: string | NamedNode | { language: string; direction?: 'ltr' | 'rtl' }): Literal
  defaultGraph(): Quad_Graph
  quad(subject: Term, predicate: Term, object: Term, graph?: Term): Quad
}

export const enum Physical {
  Triples = 1,
  Quads = 2,
  /** Jelly-RDF 1.0 and 1.1 only. */
  Graphs = 3,
}

export const enum StreamType {
  Flat = 0,
  Messages = 1,
}

export interface StreamOptions {
  name: string
  physical: number
  /** 1.2: FLAT (0) or MESSAGES (1). */
  streamType: number
  /** 1.2: 0 unspecified, 1 RDF 1.1, 2 RDF 1.2 basic, 3 RDF 1.2. */
  rdfVersion: number
  maxNames: number
  maxPrefixes: number
  maxDatatypes: number
  version: number
  /** 1.0 and 1.1 only. */
  generalized: boolean
  rdfStar: boolean
  logical: number
}

/** The largest lookups a reader allocates (the spec's recommended defaults). */
export interface JellyLimits {
  names: number
  prefixes: number
  datatypes: number
}

export const DEFAULT_LIMITS: JellyLimits = { names: 16384, prefixes: 4096, datatypes: 256 }

/** The newest version tag this reader knows. */
export const JELLY_VERSION = 3
const MAX_ROWS = 2 ** 27 - 1
/** Triple terms nest at most this deep. */
const MAX_DEPTH = 100

export interface JellySink {
  quad(q: Quad): void
  /** An RDF Message ended (stream type MESSAGES). */
  message?(): void
  /** A namespace declaration (cosmetic: a prefix and its IRI). */
  namespace?(name: string, iri: string): void
}

/** A run value of a column: a term, or one that holds blank nodes and so depends on the message it is in. */
type Value = Term | ((scope: number) => Term)

/**
 * Reads the frames of one stream in order. `blankNode(label, scope)` makes the node a label
 * stands for: scope 0 is the stream (FLAT, and every 1.0/1.1 stream), n the n-th RDF Message.
 */
export class JellyReader {
  options: StreamOptions | undefined
  private optionsBytes: Uint8Array | undefined
  private readonly names: (string | undefined)[] = []
  private readonly prefixes: (string | undefined)[] = []
  private readonly datatypes: (string | undefined)[] = []
  private lastEntry = [0, 0, 0]
  // Row layout: one IRI sequence for the stream, and the terms a statement repeats.
  private seqPrefix = 0
  private seqName = 0
  private last: (Term | undefined)[] = [undefined, undefined, undefined, undefined]
  private graph: Term | undefined
  private statements = 0
  // Messages: the current one's number and size.
  private scope = 0
  private inMessage = 0
  private readonly blanks = new Map<string, BlankNode>()
  private blankScope = -1

  constructor(
    private readonly f: JellyFactory,
    private readonly limits: JellyLimits = DEFAULT_LIMITS,
    private readonly target: Quad_Graph = f.defaultGraph(),
  ) {}

  /** The node a blank node label stands for in `scope`: one per label and scope. */
  blankNode(label: string, scope: number): BlankNode {
    if (scope !== this.blankScope) {
      this.blanks.clear()
      this.blankScope = scope
    }
    let b = this.blanks.get(label)
    if (!b) this.blanks.set(label, (b = this.f.blankNode()))
    return b
  }

  /** Read one frame (a bare `RdfStreamFrame`); returns the number of statements it had. */
  frame(bytes: Uint8Array, sink: JellySink): number {
    const r = new ProtoReader(bytes)
    const rows: [number, number][] = []
    let columns: [number, number] | undefined
    while (!r.done) {
      const [field, wire] = r.tag()
      if (field === 1 && wire === LEN) rows.push(r.len())
      else if (field === 2 && wire === LEN) columns = r.len()
      else r.skip(wire)
    }
    let n = 0
    // Jelly-RDF 1.2: at most one row, the stream options. A 1.0/1.1 stream's rows are read in
    // order once its options (its first row) say which it is.
    for (let i = 0; i < rows.length; i++) {
      const [s, e] = rows[i]!
      if (this.options && this.options.version < 3) {
        n += this.row(new ProtoReader(bytes, s, e), sink)
        continue
      }
      if (i > 0) throw new JellyError('a Jelly-RDF 1.2 frame has at most one row')
      const row = new ProtoReader(bytes, s, e)
      let opts: [number, number] | undefined
      while (!row.done) {
        const [field, wire] = row.tag()
        if (field === 1 && wire === LEN) opts = row.len()
        else throw new JellyError('a Jelly-RDF 1.2 row holds only the stream options')
      }
      if (!opts) throw new JellyError('an empty row')
      this.streamOptions(bytes.subarray(opts[0], opts[1]), sink)
    }
    if (columns && this.options?.version === 3) n += this.batch(new ProtoReader(bytes, columns[0], columns[1]), sink)
    else if (columns && !this.options) throw new JellyError('statements before the stream options')
    return n
  }

  /** The end of the stream: ends the RDF Message in progress, if it has statements. */
  end(sink: JellySink): void {
    if (this.inMessage) this.endMessage(sink)
  }

  private endMessage(sink: JellySink): void {
    sink.message?.()
    this.inMessage = 0
    this.scope++
  }

  private streamOptions(bytes: Uint8Array, sink: JellySink): void {
    const o: StreamOptions = { name: '', physical: 0, streamType: 0, rdfVersion: 0, maxNames: 0, maxPrefixes: 0, maxDatatypes: 0, version: 0, generalized: false, rdfStar: false, logical: 0 }
    const r = new ProtoReader(bytes)
    while (!r.done) {
      const [field, wire] = r.tag()
      if (field === 1 && wire === LEN) o.name = r.string()
      else if (field === 2) o.physical = r.uint(wire)
      else if (field === 3) o.generalized = r.uint(wire) !== 0
      else if (field === 4) o.rdfStar = r.uint(wire) !== 0
      else if (field === 5) o.streamType = r.uint(wire)
      else if (field === 6) o.rdfVersion = r.uint(wire)
      else if (field === 9) o.maxNames = r.uint(wire)
      else if (field === 10) o.maxPrefixes = r.uint(wire)
      else if (field === 11) o.maxDatatypes = r.uint(wire)
      else if (field === 14) o.logical = r.uint(wire)
      else if (field === 15) o.version = r.uint(wire)
      else r.skip(wire)
    }
    const prev = this.options
    if (o.version === 0) throw new JellyError('version tag 0')
    if (o.version > JELLY_VERSION) throw new JellyError(`version tag ${o.version} is newer than this reader (${JELLY_VERSION})`)
    if (prev && (prev.version < 3) !== (o.version < 3)) throw new JellyError('a stream mixes Jelly-RDF 1.2 with 1.0/1.1')
    if (o.maxNames > this.limits.names) throw new JellyError(`a name lookup of ${o.maxNames} is larger than the limit (${this.limits.names})`)
    if (o.maxPrefixes > this.limits.prefixes) throw new JellyError(`a prefix lookup of ${o.maxPrefixes} is larger than the limit (${this.limits.prefixes})`)
    if (o.maxDatatypes > this.limits.datatypes) throw new JellyError(`a datatype lookup of ${o.maxDatatypes} is larger than the limit (${this.limits.datatypes})`)
    if (o.version < 3) {
      if (prev) {
        if (!equalBytes(this.optionsBytes!, bytes)) throw new JellyError('the stream options differ from the first ones')
        return
      }
      if (o.physical < 1 || o.physical > 3) throw new JellyError(`physical stream type ${o.physical}`)
      if (o.maxNames < 8) throw new JellyError('a name lookup smaller than 8')
      this.options = o
      this.optionsBytes = bytes.slice()
      return
    }
    if (o.generalized || o.rdfStar || o.logical) throw new JellyError('a Jelly-RDF 1.0/1.1 stream option in a 1.2 stream')
    if (o.physical !== 1 && o.physical !== 2) throw new JellyError(`physical stream type ${o.physical}`)
    if (o.streamType > 1) throw new JellyError(`stream type ${o.streamType}`)
    if (o.rdfVersion > 3) throw new JellyError(`RDF version ${o.rdfVersion}`)
    if (o.maxNames < 128) throw new JellyError('a name lookup smaller than 128')
    if (prev) {
      if (prev.physical !== o.physical) throw new JellyError('the restated stream options change the physical type')
      if (prev.streamType !== o.streamType) throw new JellyError('the restated stream options change the stream type')
      // Restated: the lookups start again, and the message in progress ends.
      this.names.length = this.prefixes.length = this.datatypes.length = 0
      this.lastEntry = [0, 0, 0]
      if (o.streamType === StreamType.Messages && this.inMessage) this.endMessage(sink)
    }
    this.options = o
  }

  // ---- lookups ----

  private table(kind: number): [(string | undefined)[], number] {
    const o = this.options!
    return kind === 0 ? [this.names, o.maxNames] : kind === 1 ? [this.prefixes, o.maxPrefixes] : [this.datatypes, o.maxDatatypes]
  }

  /** Set entries `id`, `id + 1`, … of lookup `kind` (0 names, 1 prefixes, 2 datatypes); id 0 follows the last entry. */
  private entries(kind: number, id: number, values: string[]): void {
    const [table, max] = this.table(kind)
    if (id === 0) id = this.lastEntry[kind]! + 1
    if (max === 0) throw new JellyError(`a ${LOOKUP[kind]} entry, with that lookup disabled`)
    if (id + values.length - 1 > max) throw new JellyError(`${LOOKUP[kind]} entry ${id + values.length - 1} is outside the lookup (${max})`)
    for (const v of values) table[id++] = v
    this.lastEntry[kind] = id - 1
  }

  private lookup(kind: number, id: number): string {
    const [table, max] = this.table(kind)
    if (id < 1 || id > max) throw new JellyError(`${LOOKUP[kind]} ${id} is outside the lookup (${max})`)
    const v = table[id]
    if (v === undefined) throw new JellyError(`${LOOKUP[kind]} ${id} is not defined`)
    return v
  }

  private iri(prefix: number, name: number): NamedNode {
    return this.f.namedNode((prefix ? this.lookup(1, prefix) : '') + this.lookup(0, name))
  }

  private datatype(id: number): string {
    const dt = this.lookup(2, id)
    if (dt === RDF_LANG || dt === RDF_DIR_LANG) throw new JellyError(`datatype ${dt} without a language tag`)
    return dt
  }

  private langLiteral(lex: string, lang: string, dir: number): Literal {
    if (dir > 2) throw new JellyError(`base direction ${dir}`)
    return dir ? this.f.literal(lex, { language: lang, direction: dir === 1 ? 'ltr' : 'rtl' }) : this.f.literal(lex, lang)
  }

  /** An `RdfIri` of an IRI sequence held in `seq` ([prefix, name] of the previous IRI). */
  private rdfIri(r: ProtoReader, seq: number[]): NamedNode {
    let prefix = 0
    let name = 0
    while (!r.done) {
      const [field, wire] = r.tag()
      if (field === 1) prefix = r.uint(wire)
      else if (field === 2) name = r.uint(wire)
      else r.skip(wire)
    }
    if (prefix === 0) prefix = seq[0]!
    else seq[0] = prefix
    name = name === 0 ? seq[1]! + 1 : name
    seq[1] = name
    return this.iri(prefix, name)
  }

  /** An `RdfLiteral`. */
  private rdfLiteral(r: ProtoReader): Literal {
    let lex = ''
    let lang: string | undefined
    let datatype: number | undefined
    let dir = 0
    while (!r.done) {
      const [field, wire] = r.tag()
      if (field === 1 && wire === LEN) lex = r.string()
      else if (field === 2 && wire === LEN) (lang = r.string()), (datatype = undefined)
      else if (field === 3) (datatype = r.uint(wire)), (lang = undefined)
      else if (field === 4) dir = r.uint(wire)
      else r.skip(wire)
    }
    if (dir && lang === undefined) throw new JellyError('a base direction without a language tag')
    if (lang !== undefined) return this.langLiteral(lex, lang, this.options!.version < 3 ? 0 : dir)
    if (datatype === undefined) return this.f.literal(lex)
    if (datatype === 0) throw new JellyError('datatype 0')
    return this.f.literal(lex, this.f.namedNode(this.datatype(datatype)))
  }

  // ---- row layout (Jelly-RDF 1.0 and 1.1) ----

  private rowSeq = [0, 0]

  private row(r: ProtoReader, sink: JellySink): number {
    let n = 0
    let fields = 0
    while (!r.done) {
      const [field, wire] = r.tag()
      fields++
      if (wire !== LEN) throw new JellyError('a row field that is not a message')
      const m = r.sub()
      const o = this.options
      if (field === 1) {
        this.streamOptions(m.buf.subarray(m.pos, m.end), sink)
        continue
      }
      if (!o) throw new JellyError('a row before the stream options')
      switch (field) {
        case 2: {
          if (o.physical === Physical.Quads) throw new JellyError('a triple in a stream of quads')
          if (o.physical === Physical.Graphs && !this.graph) throw new JellyError('a triple outside a graph')
          const [s, p, ob] = this.statement(m, 3)
          sink.quad(this.f.quad(s, p, ob, o.physical === Physical.Graphs ? this.graph : this.target))
          n++
          break
        }
        case 3: {
          if (o.physical !== Physical.Quads) throw new JellyError('a quad in a stream that is not of quads')
          const [s, p, ob, g] = this.statement(m, 4)
          sink.quad(this.f.quad(s, p, ob, g))
          n++
          break
        }
        case 4: {
          if (o.physical !== Physical.Graphs) throw new JellyError('a graph start in a stream that is not of graphs')
          if (this.graph) throw new JellyError('a graph start inside a graph')
          let g: Term | undefined
          while (!m.done) {
            const [f, w] = m.tag()
            if (w !== LEN) m.skip(w)
            else if (f === 1) g = this.rdfIri(m.sub(), this.rowSeq)
            else if (f === 2) g = this.blankNode(m.string(), 0)
            else if (f === 3) m.len(), (g = this.target)
            else if (f === 4) throw new JellyError('a literal graph name (generalized RDF is not supported)')
            else m.skip(w)
          }
          if (!g) throw new JellyError('a graph start without a graph')
          this.graph = g
          break
        }
        case 5:
          if (o.physical !== Physical.Graphs) throw new JellyError('a graph end in a stream that is not of graphs')
          this.graph = undefined
          break
        case 6:
          this.namespace(m, this.rowSeq, sink)
          break
        case 9:
        case 10:
        case 11: {
          let id = 0
          let value = ''
          while (!m.done) {
            const [f, w] = m.tag()
            if (f === 1) id = m.uint(w)
            else if (f === 2 && w === LEN) value = m.string()
            else m.skip(w)
          }
          this.entries(field - 9, id, [value])
          break
        }
        default:
          throw new JellyError(`row field ${field}`)
      }
    }
    if (fields === 0) throw new JellyError('an empty row')
    return n
  }

  private namespace(m: ProtoReader, seq: number[], sink: JellySink): void {
    let name = ''
    let iri: NamedNode | undefined
    while (!m.done) {
      const [f, w] = m.tag()
      if (f === 1 && w === LEN) name = m.string()
      else if (f === 2 && w === LEN) iri = this.rdfIri(m.sub(), seq)
      else m.skip(w)
    }
    if (!iri) throw new JellyError('a namespace declaration without an IRI')
    sink.namespace?.(name, iri.value)
  }

  /** An `RdfTriple` or `RdfQuad` statement (`n` positions), repeating the previous statement's terms where one is not set. */
  private statement(m: ProtoReader, n: number): Term[] {
    const t = this.terms(m, n, 0)
    for (let i = 0; i < n; i++) {
      if (t[i] === undefined) {
        if (this.last[i] === undefined) throw new JellyError('a repeated term in the first statement')
        t[i] = this.last[i]
      } else this.last[i] = t[i]
    }
    this.statements++
    return t as Term[]
  }

  /** The terms of an `RdfTriple` / `RdfQuad`: fields 4k+1..4k+4 are an IRI, a blank node, a literal, a quoted triple (13..16 the graph). */
  private terms(m: ProtoReader, n: number, depth: number): (Term | undefined)[] {
    const t: (Term | undefined)[] = new Array(n).fill(undefined)
    while (!m.done) {
      const [field, wire] = m.tag()
      if (wire !== LEN || field > 4 * n) {
        m.skip(wire)
        continue
      }
      const pos = (field - 1) >> 2
      const kind = (field - 1) & 3
      if (pos === 3) {
        if (kind === 0) t[3] = this.rdfIri(m.sub(), this.rowSeq)
        else if (kind === 1) t[3] = this.blankNode(m.string(), 0)
        else if (kind === 2) m.len(), (t[3] = this.target)
        else throw new JellyError('a literal graph name (generalized RDF is not supported)')
        continue
      }
      if (kind === 0) t[pos] = this.rdfIri(m.sub(), this.rowSeq)
      else if (kind === 1) t[pos] = this.blankNode(m.string(), 0)
      else if (kind === 2) t[pos] = this.rdfLiteral(m.sub())
      else {
        if (depth >= MAX_DEPTH) throw new JellyError('quoted triples nest too deep')
        const q = this.terms(m.sub(), 3, depth + 1)
        if (q.some((x) => x === undefined)) throw new JellyError('a quoted triple with a repeated term')
        t[pos] = this.f.quad(q[0]!, q[1]!, q[2]!)
      }
      if (pos === 0 && kind === 2) throw new JellyError('a literal subject (generalized RDF is not supported)')
      if (pos === 1 && kind !== 0) throw new JellyError('a predicate that is not an IRI (generalized RDF is not supported)')
    }
    return t
  }

  // ---- column layout (Jelly-RDF 1.2) ----

  private batch(r: ProtoReader, sink: JellySink): number {
    const o = this.options!
    let rows = 0
    const entries: [number, ProtoReader][] = []
    const namespaces: ProtoReader[] = []
    const columns: (ProtoReader | undefined)[] = [undefined, undefined, undefined, undefined]
    const lengths: number[] = []
    while (!r.done) {
      const [field, wire] = r.tag()
      if (field === 1) rows = r.uint(wire)
      else if (field >= 2 && field <= 4 && wire === LEN) entries.push([field - 2, r.sub()])
      else if (field === 5 && wire === LEN) namespaces.push(r.sub())
      else if (field >= 6 && field <= 9 && wire === LEN) columns[field - 6] = r.sub()
      else if (field === 15) r.packed(wire, lengths)
      else r.skip(wire)
    }
    if (rows > MAX_ROWS) throw new JellyError(`row_count ${rows} is larger than 2^27 - 1`)
    if (columns[3] && o.physical === Physical.Triples) throw new JellyError('a graphs column in a stream of triples')
    if (lengths.length && o.streamType !== StreamType.Messages) throw new JellyError('message boundaries in a FLAT stream')
    let sum = 0
    for (const l of lengths) sum += l
    if (sum > rows) throw new JellyError('the message lengths add up to more than row_count')
    // 1. Lookup entries, in order.
    for (const [kind, e] of entries) {
      let id = 0
      const values: string[] = []
      while (!e.done) {
        const [f, w] = e.tag()
        if (f === 1) id = e.uint(w)
        else if (f === 2 && w === LEN) values.push(e.string())
        else e.skip(w)
      }
      this.entries(kind, id, values)
    }
    // 2. Namespace declarations: one IRI sequence.
    const seq = [0, 0]
    for (const m of namespaces) this.namespace(m, seq, sink)
    // 3. Statements: every column decoded to its cells, then read across.
    const cells = columns.map((c, i) => (c ? this.column(c, rows, i) : undefined))
    const [s, p, ob, g] = cells
    if (!s || !p || !ob) {
      if (rows) throw new JellyError(`the ${!s ? 'subjects' : !p ? 'predicates' : 'objects'} column has unbound cells`)
    }
    const at = (v: Value | undefined): Term | undefined => (typeof v === 'function' ? v(this.scope) : v)
    let boundary = this.messageZeros(lengths, 0, sink)
    let next = boundary < lengths.length ? lengths[boundary]! : -1
    for (let row = 0; row < rows; row++) {
      const graph = o.physical === Physical.Quads ? (at(g?.[row]) ?? this.f.defaultGraph()) : this.target
      sink.quad(this.f.quad(at(s![row])!, at(p![row])!, at(ob![row])!, graph))
      this.inMessage++
      if (next >= 0 && --next === 0) {
        this.endMessage(sink)
        boundary = this.messageZeros(lengths, boundary + 1, sink)
        next = boundary < lengths.length ? lengths[boundary]! : -1
      }
    }
    return rows
  }

  /** Message lengths of 0 from `i` on: each ends the current message; returns the next index. */
  private messageZeros(lengths: number[], i: number, sink: JellySink): number {
    while (i < lengths.length && lengths[i] === 0) {
      this.endMessage(sink)
      i++
    }
    return i
  }

  /** The cells of an `RdfColumn` (position 0 subjects, 1 predicates, 2 objects, 3 graphs); undefined is unbound. */
  private column(r: ProtoReader, rows: number, position: number): (Value | undefined)[] {
    let kinds: Uint8Array | undefined
    const layouts: number[] = []
    const nameIds: number[] = []
    const prefixIds: number[] = []
    const lex: string[] = []
    const literalKinds: number[] = []
    const langtags: string[] = []
    const directions: number[] = []
    const bnodes: string[] = []
    const tripleTerms: ProtoReader[] = []
    while (!r.done) {
      const [field, wire] = r.tag()
      if (field === 1 && wire === LEN) {
        const [s, e] = r.len()
        kinds = r.buf.subarray(s, e)
      } else if (field === 2) r.packed(wire, layouts)
      else if (field === 3) r.packed(wire, nameIds)
      else if (field === 4) r.packed(wire, prefixIds)
      else if (field === 5 && wire === LEN) lex.push(r.string())
      else if (field === 6) r.packed(wire, literalKinds)
      else if (field === 7 && wire === LEN) langtags.push(r.string())
      else if (field === 8) r.packed(wire, directions)
      else if (field === 9 && wire === LEN) bnodes.push(r.string())
      else if (field === 10 && wire === LEN) tripleTerms.push(r.sub())
      else r.skip(wire)
    }
    const counts = [nameIds.length, lex.length, bnodes.length, tripleTerms.length]
    const m = counts[0]! + counts[1]! + counts[2]! + counts[3]!
    // Term types of the run values.
    const types = new Uint8Array(m)
    if (!kinds || kinds.length === 0) {
      const lists = counts.filter((c) => c > 0).length
      if (lists > 1) throw new JellyError('a column of several term types without kinds')
      types.fill(Math.max(0, counts.findIndex((c) => c > 0)))
    } else {
      if (kinds.length !== Math.ceil(m / 4)) throw new JellyError(`kinds has ${kinds.length} bytes for ${m} values`)
      if (m % 4 && kinds[kinds.length - 1]! >> (2 * (m % 4))) throw new JellyError('unused bits of kinds are set')
      const seen = [0, 0, 0, 0]
      for (let i = 0; i < m; i++) {
        const t = (kinds[i >> 2]! >> (2 * (i & 3))) & 3
        if (++seen[t]! > counts[t]!) throw new JellyError('kinds refers to more values of a type than the column has')
        types[i] = t
      }
    }
    if (prefixIds.length > 1 && prefixIds.length !== nameIds.length) throw new JellyError(`prefix_ids has ${prefixIds.length} entries for ${nameIds.length} IRIs`)
    if (literalKinds.length > 1 && literalKinds.length !== lex.length) throw new JellyError(`literal_kinds has ${literalKinds.length} entries for ${lex.length} literals`)
    if (directions.length && directions.length !== langtags.length) throw new JellyError(`langtag_directions has ${directions.length} entries for ${langtags.length} language tags`)
    for (const d of directions) if (d > 2) throw new JellyError(`base direction ${d}`)
    const allowed = position === 1 ? 1 : position === 2 ? 15 : 5 // bits: IRI, literal, blank node, triple term
    // The run values.
    const values: Value[] = new Array(m)
    const next = [0, 0, 0, 0]
    let prevName = 0
    let prevPrefix = 0
    const ttSeq = [0, 0]
    for (let i = 0; i < m; i++) {
      const t = types[i]!
      if (!(allowed & (1 << t))) throw new JellyError(`${TERM[t]} in the ${COLUMN[position]} column`)
      const k = next[t]!++
      if (t === 0) {
        const name = nameIds[k] || prevName + 1
        prevName = name
        let prefix = prefixIds.length === 0 ? 0 : prefixIds.length === 1 ? prefixIds[0]! : prefixIds[k]!
        if (prefixIds.length > 1) prevPrefix = prefix = prefix || prevPrefix
        values[i] = this.iri(prefix, name)
      } else if (t === 1) {
        const v = literalKinds.length === 0 ? 0 : literalKinds.length === 1 ? literalKinds[0]! : literalKinds[k]!
        if (v === 0) values[i] = this.f.literal(lex[k]!)
        else if (v & 1) values[i] = this.f.literal(lex[k]!, this.f.namedNode(this.datatype((v + 1) / 2)))
        else {
          const j = v / 2 - 1
          if (j >= langtags.length) throw new JellyError(`literal kind ${v} refers to language tag ${j}, past the end of langtags`)
          values[i] = this.langLiteral(lex[k]!, langtags[j]!, directions.length ? directions[j]! : 0)
        }
      } else if (t === 2) {
        const label = bnodes[k]!
        values[i] = (scope) => this.blankNode(label, scope)
      } else values[i] = this.tripleTerm(tripleTerms[k]!, ttSeq, 0)
    }
    // The sequence layout.
    const cells: (Value | undefined)[] = new Array(rows)
    let i = 0
    let pos = 0
    for (let x = 0; x < layouts.length; x++) {
      const token = layouts[x]!
      const skip = Math.floor(token / 32)
      let len = token & 15
      if (len === 15) {
        if (++x >= layouts.length) throw new JellyError('a layout token without its extension varint')
        len += layouts[x]!
      }
      if (i + skip > m) throw new JellyError('a layout skips past the last run value')
      if (pos + skip > rows) throw new JellyError('a column longer than row_count')
      for (let k = 0; k < skip; k++) cells[pos++] = values[i++]
      if (token & 16) {
        if (pos + len + 1 > rows) throw new JellyError('a column longer than row_count')
        pos += len + 1
      } else {
        if (i >= m) throw new JellyError('a repeat run past the last run value')
        if (pos + len + 2 > rows) throw new JellyError('a column longer than row_count')
        const v = values[i++]
        for (let k = 0; k < len + 2; k++) cells[pos++] = v
      }
    }
    if (pos + (m - i) > rows) throw new JellyError('a column longer than row_count')
    while (i < m) cells[pos++] = values[i++]
    if (position < 3 && pos < rows) throw new JellyError(`the ${COLUMN[position]} column has unbound cells`)
    if (position < 3) for (let k = 0; k < rows; k++) if (cells[k] === undefined) throw new JellyError(`the ${COLUMN[position]} column has unbound cells`)
    return cells
  }

  /** An `RdfTripleTerm`, whose IRIs are in the column's triple-term sequence `seq`. */
  private tripleTerm(r: ProtoReader, seq: number[], depth: number): Value {
    if (depth >= MAX_DEPTH) throw new JellyError('triple terms nest too deep')
    const t: (Value | undefined)[] = [undefined, undefined, undefined]
    while (!r.done) {
      const [field, wire] = r.tag()
      if (wire !== LEN) {
        r.skip(wire)
        continue
      }
      if (field === 1) t[0] = this.rdfIri(r.sub(), seq)
      else if (field === 2) {
        const label = r.string()
        t[0] = (scope) => this.blankNode(label, scope)
      } else if (field === 5) t[1] = this.rdfIri(r.sub(), seq)
      else if (field === 9) t[2] = this.rdfIri(r.sub(), seq)
      else if (field === 10) {
        const label = r.string()
        t[2] = (scope) => this.blankNode(label, scope)
      } else if (field === 11) t[2] = this.rdfLiteral(r.sub())
      else if (field === 12) t[2] = this.tripleTerm(r.sub(), seq, depth + 1)
      else r.skip(wire)
    }
    if (!t[0]) throw new JellyError('a triple term without a subject')
    if (!t[1]) throw new JellyError('a triple term without a predicate')
    if (!t[2]) throw new JellyError('a triple term without an object')
    const [s, p, o] = t as Value[]
    if (typeof s !== 'function' && typeof o !== 'function') return this.f.quad(s as Term, p as Term, o as Term)
    return (scope) => this.f.quad(typeof s === 'function' ? s(scope) : s!, p as Term, typeof o === 'function' ? o(scope) : o!)
  }
}

const LOOKUP = ['name', 'prefix', 'datatype']
const TERM = ['an IRI', 'a literal', 'a blank node', 'a triple term']
const COLUMN = ['subjects', 'predicates', 'objects', 'graphs']

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ---- delimiting ----

/** Whether `bytes` is a single bare frame rather than delimited ones: a bare frame starts with its options row (0x0A, a length, 0x0A). */
export function isDelimited(bytes: Uint8Array): boolean {
  return !(bytes.length >= 3 && bytes[0] === 0x0a && bytes[2] === 0x0a)
}

/** The frames of a delimited stream (or of one bare frame). */
export function* frames(bytes: Uint8Array): Generator<Uint8Array> {
  if (!isDelimited(bytes)) {
    yield bytes
    return
  }
  const r = new ProtoReader(bytes)
  while (!r.done) {
    const [s, e] = r.len()
    yield bytes.subarray(s, e)
  }
}

/** Splits a delimited byte stream that arrives in chunks into its frames (holding at most one partial frame). */
export class FrameSplitter {
  private buf = new Uint8Array(0)

  push(chunk: Uint8Array): Uint8Array[] {
    const b = new Uint8Array(this.buf.length + chunk.length)
    b.set(this.buf)
    b.set(chunk, this.buf.length)
    const out: Uint8Array[] = []
    const r = new ProtoReader(b)
    let start = 0
    while (!r.done) {
      try {
        const [s, e] = r.len()
        out.push(b.slice(s, e))
        start = e
      } catch (e) {
        if (e instanceof JellyError) break
        throw e
      }
    }
    this.buf = b.slice(start)
    return out
  }

  /** The end of the stream: throws if a frame is cut off. */
  end(): void {
    if (this.buf.length) throw new JellyError('the stream ends inside a frame')
  }
}

/** Read a whole stream (delimited, or one bare frame) and return its statements in order. */
export function readJelly(bytes: Uint8Array, f: JellyFactory, target?: Quad_Graph, limits?: JellyLimits): Quad[] {
  const reader = new JellyReader(f, limits, target)
  const out: Quad[] = []
  const sink = { quad: (q: Quad) => void out.push(q) }
  for (const frame of frames(bytes)) reader.frame(frame, sink)
  reader.end(sink)
  return out
}
