// The one host adapter for every engine build (see ../ABI.md): strings in and
// out of linear memory, errors to exceptions, results copied out as ids.

export const ABI_VERSION = 1

export enum Kind {
  Free = 0,
  Iri = 1,
  BlankNode = 2,
  Literal = 3,
  Triple = 4,
  DefaultGraph = 5,
}

export enum Format {
  NTriples = 1,
  NQuads = 2,
  Turtle = 3,
  TriG = 4,
}

export enum Form {
  Select = 1,
  Construct = 2,
  Ask = 3,
  Describe = 4,
}

export const DEFAULT_GRAPH = 1
export type Direction = 0 | 1 | 2

interface Exports {
  memory: WebAssembly.Memory
  abi_version(): number
  input(len: number): number
  result_ptr(): number
  error_ptr(): number
  error_len(): number
  intern_iri(len: number): number
  intern_bnode(len: number): number
  fresh_bnode(): number
  intern_literal(len: number, datatype: number): number
  intern_lang_literal(len: number, langLen: number, dir: number): number
  intern_triple(s: number, p: number, o: number): number
  lookup_iri(len: number): number
  lookup_bnode(len: number): number
  lookup_literal(len: number, datatype: number): number
  lookup_lang_literal(len: number, langLen: number, dir: number): number
  lookup_triple(s: number, p: number, o: number): number
  term_kind(id: number): number
  term_value_ptr(id: number): number
  term_value_len(id: number): number
  term_datatype(id: number): number
  term_lang_ptr(id: number): number
  term_lang_len(id: number): number
  term_direction(id: number): number
  triple_subject(id: number): number
  triple_predicate(id: number): number
  triple_object(id: number): number
  term_count(): number
  add(s: number, p: number, o: number, g: number): number
  remove(s: number, p: number, o: number, g: number): number
  has(s: number, p: number, o: number, g: number): number
  match(s: number, p: number, o: number, g: number): number
  apply(removes: number, adds: number): number
  quad_count(): number
  load(format: number, textLen: number, baseLen: number, graph: number): number
  collect(): number
  prepare(textLen: number, baseLen: number): number
  query_form(h: number): number
  query_var_count(h: number): number
  query_var_ptr(h: number, i: number): number
  query_var_len(h: number, i: number): number
  bind(h: number, nameLen: number, id: number): number
  bind_values(h: number, count: number, nameLen: number): number
  run(h: number, graphs: number): number
  release(h: number): number
  parse_update(textLen: number, baseLen: number): number
  update(textLen: number, baseLen: number): number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const imports = {
  env: {
    now: () => Date.now(),
    random: () => Math.random(),
  },
}

/** Compile an engine build once; each `Engine` is a fresh instance (a fresh store). */
export async function compile(bytes: BufferSource): Promise<WebAssembly.Module> {
  return WebAssembly.compile(bytes)
}

export class EngineError extends Error {}

export class Engine {
  private x: Exports

  constructor(module: WebAssembly.Module) {
    this.x = new WebAssembly.Instance(module, imports).exports as unknown as Exports
    const v = this.x.abi_version()
    if (v !== ABI_VERSION) throw new Error(`engine ABI ${v}, host expects ${ABI_VERSION}`)
  }

  /** Drop the instance, so its memory can be collected while this object is still referenced; the engine must not be used afterwards. */
  dispose(): void {
    this.x = undefined as unknown as Exports
  }

  // --- memory ---------------------------------------------------------------

  /** Write strings back to back into the input buffer; returns their byte lengths. */
  private put(...strings: string[]): number[] {
    let max = 0
    for (const s of strings) max += s.length * 3
    let at = this.x.input(max)
    const mem = new Uint8Array(this.x.memory.buffer)
    return strings.map((s) => {
      const n = encoder.encodeInto(s, mem.subarray(at)).written
      at += n
      return n
    })
  }

  private putIds(ids: ArrayLike<number>): void {
    const at = this.x.input(ids.length * 4)
    new Uint32Array(this.x.memory.buffer, at, ids.length).set(ids)
  }

  private str(ptr: number, len: number): string {
    return len ? decoder.decode(new Uint8Array(this.x.memory.buffer, ptr, len)) : ''
  }

  /** A copy of `n` result ids. */
  private results(n: number): Uint32Array {
    return new Uint32Array(this.x.memory.buffer, this.x.result_ptr(), n).slice()
  }

  private check(r: number): number {
    if (r < 0) throw new EngineError(this.str(this.x.error_ptr(), this.x.error_len()) || `engine error ${r}`)
    return r
  }

  // --- terms ----------------------------------------------------------------

  iri(value: string): number {
    return this.check(this.x.intern_iri(this.put(value)[0]!))
  }
  bnode(label?: string): number {
    return this.check(label === undefined ? this.x.fresh_bnode() : this.x.intern_bnode(this.put(label)[0]!))
  }
  literal(value: string, datatype = 0): number {
    return this.check(this.x.intern_literal(this.put(value)[0]!, datatype))
  }
  langLiteral(value: string, lang: string, dir: Direction = 0): number {
    const [v, l] = this.put(value, lang)
    return this.check(this.x.intern_lang_literal(v!, l!, dir))
  }
  triple(s: number, p: number, o: number): number {
    return this.check(this.x.intern_triple(s, p, o))
  }
  lookupIri(value: string): number {
    return this.x.lookup_iri(this.put(value)[0]!)
  }

  kind(id: number): Kind {
    return this.x.term_kind(id)
  }
  value(id: number): string {
    return this.str(this.x.term_value_ptr(id), this.x.term_value_len(id))
  }
  datatype(id: number): number {
    return this.x.term_datatype(id)
  }
  lang(id: number): string {
    return this.str(this.x.term_lang_ptr(id), this.x.term_lang_len(id))
  }
  direction(id: number): Direction {
    return this.x.term_direction(id) as Direction
  }
  tripleParts(id: number): [number, number, number] {
    return [this.x.triple_subject(id), this.x.triple_predicate(id), this.x.triple_object(id)]
  }
  termCount(): number {
    return this.x.term_count()
  }

  // --- store ----------------------------------------------------------------

  add(s: number, p: number, o: number, g = DEFAULT_GRAPH): boolean {
    return this.check(this.x.add(s, p, o, g)) === 1
  }
  remove(s: number, p: number, o: number, g = DEFAULT_GRAPH): boolean {
    return this.check(this.x.remove(s, p, o, g)) === 1
  }
  has(s: number, p: number, o: number, g = DEFAULT_GRAPH): boolean {
    return this.x.has(s, p, o, g) === 1
  }
  /** Matching quads, 4 ids each. `g = 0`: all graphs. */
  match(s = 0, p = 0, o = 0, g = 0): Uint32Array {
    return this.results(this.check(this.x.match(s, p, o, g)) * 4)
  }
  apply(removes: ArrayLike<number>, adds: ArrayLike<number>): void {
    const all = new Uint32Array(removes.length + adds.length)
    all.set(removes)
    all.set(adds, removes.length)
    this.putIds(all)
    this.check(this.x.apply(removes.length / 4, adds.length / 4))
  }
  quadCount(): number {
    return this.x.quad_count()
  }
  load(format: Format, text: string, base = '', graph = DEFAULT_GRAPH): number {
    const [t, b] = this.put(text, base)
    return this.check(this.x.load(format, t!, b!, graph))
  }
  /** Free unused terms; returns the freed ids. */
  collect(): Uint32Array {
    return this.results(this.check(this.x.collect()))
  }

  // --- queries --------------------------------------------------------------

  prepare(text: string, base = ''): Query {
    const [t, b] = this.put(text, base)
    const h = this.check(this.x.prepare(t!, b!))
    const vars: string[] = []
    for (let i = 0, n = this.x.query_var_count(h); i < n; i++) vars.push(this.str(this.x.query_var_ptr(h, i), this.x.query_var_len(h, i)))
    return new Query(this, h, this.x.query_form(h) as Form, vars)
  }
  /** @internal */
  bindVar(h: number, name: string, id: number): void {
    this.check(this.x.bind(h, this.put(name)[0]!, id))
  }
  /** @internal */
  bindValues(h: number, name: string, ids: ArrayLike<number>): void {
    const at = this.x.input(ids.length * 4 + name.length * 3)
    new Uint32Array(this.x.memory.buffer, at, ids.length).set(ids)
    const n = encoder.encodeInto(name, new Uint8Array(this.x.memory.buffer, at + ids.length * 4)).written
    this.check(this.x.bind_values(h, ids.length, n))
  }
  /** @internal */
  runQuery(h: number, graphs: ArrayLike<number>): number {
    this.putIds(graphs)
    return this.check(this.x.run(h, graphs.length))
  }
  /** @internal */
  resultIds(n: number): Uint32Array {
    return this.results(n)
  }
  /** @internal */
  releaseQuery(h: number): void {
    this.x.release(h)
  }
  parseUpdate(text: string, base = ''): void {
    const [t, b] = this.put(text, base)
    this.check(this.x.parse_update(t!, b!))
  }
  update(text: string, base = ''): void {
    const [t, b] = this.put(text, base)
    this.check(this.x.update(t!, b!))
  }
}

export type Solutions =
  | { form: Form.Select; vars: string[]; count: number; rows: Uint32Array }
  | { form: Form.Construct | Form.Describe; triples: Uint32Array }
  | { form: Form.Ask; value: boolean }

export class Query {
  constructor(
    private readonly engine: Engine,
    private readonly handle: number,
    readonly form: Form,
    readonly vars: string[],
  ) {}

  bind(name: string, id: number): this {
    this.engine.bindVar(this.handle, name, id)
    return this
  }

  /** Bind a variable to several terms: the results of running once with each. */
  bindValues(name: string, ids: ArrayLike<number>): this {
    this.engine.bindValues(this.handle, name, ids)
    return this
  }

  run(graphs: ArrayLike<number> = []): Solutions {
    const n = this.engine.runQuery(this.handle, graphs)
    if (this.form === Form.Ask) return { form: Form.Ask, value: n === 1 }
    if (this.form === Form.Select) return { form: Form.Select, vars: this.vars, count: n, rows: this.engine.resultIds(n * this.vars.length) }
    return { form: this.form, triples: this.engine.resultIds(n * 3) }
  }

  release(): void {
    this.engine.releaseQuery(this.handle)
  }
}
