// The JavaScript side of the WASM twins (layout-solver/build/{rust,wat}.wasm): the same surface as
// src/layout/solver.ts (Solver) and src/layout/check.ts (checkPacked). A module instance holds one
// solver; each WasmLayout is its own instance.
import type { Finding } from './check.ts'
import type { Op, SolverLike, Term } from './solver.ts'

interface Exports {
  memory: WebAssembly.Memory
  buf(n: number): number
  prog(n: number): number
  out(): number
  reset(): void
  add_variable(): number
  add_constraint(n: number, constant: number, op: number, strength: number): number
  remove_constraint(id: number): number
  add_edit_variable(v: number, strength: number): number
  remove_edit_variable(v: number): number
  suggest(n: number): number
  values(): number
  pivots(): number
  check(): number
}

export class WasmLayout implements SolverLike {
  private constructor(private x: Exports) {}

  static async load(bytes: BufferSource): Promise<WasmLayout> {
    return WasmLayout.instantiate(await WebAssembly.compile(bytes))
  }

  /** A new solver: a new instance of a compiled twin. */
  static async instantiate(module: WebAssembly.Module): Promise<WasmLayout> {
    const instance = await WebAssembly.instantiate(module, {})
    return new WasmLayout(instance.exports as unknown as Exports)
  }

  private f64(ptr: number, n: number): Float64Array {
    return new Float64Array(this.x.memory.buffer, ptr, n)
  }
  private ok(r: number, what: string): void {
    if (r < 0) throw new Error(what + ' failed')
  }

  reset(): void {
    this.x.reset()
  }
  addVariable(): number {
    return this.x.add_variable()
  }
  addConstraint(terms: readonly Term[], constant: number, op: Op, strength: number): number {
    const b = this.f64(this.x.buf(terms.length * 2), terms.length * 2)
    terms.forEach((t, i) => {
      b[i * 2] = t.variable
      b[i * 2 + 1] = t.coefficient
    })
    const id = this.x.add_constraint(terms.length, constant, op, strength)
    this.ok(id, 'addConstraint')
    return id
  }
  removeConstraint(id: number): void {
    this.ok(this.x.remove_constraint(id), 'removeConstraint')
  }
  addEditVariable(v: number, strength: number): void {
    this.ok(this.x.add_edit_variable(v, strength), 'addEditVariable')
  }
  removeEditVariable(v: number): void {
    this.ok(this.x.remove_edit_variable(v), 'removeEditVariable')
  }
  suggestValue(v: number, value: number): void {
    this.suggest([[v, value]])
  }
  /** Several suggestions in one call across the boundary. */
  suggest(pairs: readonly (readonly [number, number])[]): void {
    const b = this.f64(this.x.buf(pairs.length * 2), pairs.length * 2)
    pairs.forEach(([v, x], i) => {
      b[i * 2] = v
      b[i * 2 + 1] = x
    })
    this.ok(this.x.suggest(pairs.length), 'suggest')
  }
  value(v: number): number {
    return this.f64(this.x.out(), this.x.values())[v]
  }
  values(): Float64Array {
    const n = this.x.values()
    return this.f64(this.x.out(), n).slice()
  }
  get pivots(): number {
    return this.x.pivots()
  }

  /** The checker over packed boxes and a packed program (src/layout/check.ts's formats). */
  check(boxes: Float64Array, program: Int32Array): Finding[] {
    this.f64(this.x.buf(boxes.length), boxes.length).set(boxes)
    new Int32Array(this.x.memory.buffer, this.x.prog(program.length), program.length).set(program)
    const n = this.x.check()
    const o = this.f64(this.x.out(), n * 3)
    const findings: Finding[] = []
    for (let i = 0; i < n; i++) findings.push({ invariant: o[i * 3], member: o[i * 3 + 1], by: o[i * 3 + 2] })
    return findings
  }
}
