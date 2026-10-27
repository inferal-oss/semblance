// An incremental linear constraint solver: Cassowary (Badros, Borning, Stuckey 2001) in the shape
// of kiwi (github.com/nucleic/kiwi). Constraints are `Σ coefficient·variable + constant OP 0` with
// a strength; required ones must hold, weaker ones are minimized in a weighted objective. Edit
// variables take suggested values and re-solve by dual simplex, so a change (a new viewport width,
// one label measured wider) costs the pivots it causes, not a solve from scratch.
//
// Unlike kiwi, the symbol entering the basis is the one that improves the objective most (Dantzig's
// rule), not the first that improves it: with the first, adding the k-th of many constraints that
// share a variable re-pivots the k before it (pivots grow as n²). Dantzig's rule can cycle on a
// degenerate tableau, so after a run of pivots that make no progress the solve falls back to
// Bland's rule (the lowest symbol enters and leaves), which cannot.
//
// The tableau also keeps a column index (symbol → the rows that use it), so a pivot visits
// only the rows its entering symbol appears in, not every row: kiwi's full scan makes building n
// constraints grow about as n³, the index about as the fill-in. Rows touched together are taken in
// the order they became basic, which is the order kiwi's scan would meet them in.
//
// layout-solver/rust/src/solver.rs is the same algorithm, step for step: both order rows and cells
// the same way, so the twins pivot identically and their values agree (layout-solver.test.ts).

export const enum Op {
  Le = 0,
  Ge = 1,
  Eq = 2,
}

/** Strengths as in kiwi: three tiers (strong, medium, weak) each scaled by a weight, and required. */
export const Strength = {
  required: 1_001_001_000,
  strong: 1_000_000,
  medium: 1_000,
  weak: 1,
  create(strong: number, medium: number, weak: number, w = 1): number {
    const clip = (n: number) => Math.max(0, Math.min(1000, n * w))
    return clip(strong) * 1_000_000 + clip(medium) * 1_000 + clip(weak)
  },
  clip(s: number): number {
    return Math.max(0, Math.min(Strength.required, s))
  },
}

const EPS = 1.0e-8
/** degenerate pivots in a row before optimize falls back to Bland's rule */
const STALL = 64
const nearZero = (n: number) => (n < 0 ? -n < EPS : n < EPS)

const enum Kind {
  External = 0,
  Slack = 1,
  Error = 2,
  Dummy = 3,
}
const INVALID = -1

/** A row of the tableau: `constant + Σ cells` (symbol → coefficient), kept in insertion order. */
class Row {
  cells = new Map<number, number>()
  constructor(public constant = 0) {}
  copy(): Row {
    const r = new Row(this.constant)
    r.cells = new Map(this.cells)
    return r
  }
  add(value: number): number {
    return (this.constant += value)
  }
  insert(sym: number, coefficient = 1): void {
    const v = (this.cells.get(sym) ?? 0) + coefficient
    if (nearZero(v)) this.cells.delete(sym)
    else this.cells.set(sym, v)
  }
  insertRow(other: Row, coefficient = 1): void {
    this.constant += other.constant * coefficient
    for (const [s, c] of other.cells) this.insert(s, c * coefficient)
  }
  remove(sym: number): void {
    this.cells.delete(sym)
  }
  reverseSign(): void {
    this.constant = -this.constant
    for (const [s, c] of this.cells) this.cells.set(s, -c)
  }
  /** Solve `0 = this` for `sym`: the row becomes `sym = …`, without `sym`. */
  solveFor(sym: number): void {
    const coefficient = -1 / this.cells.get(sym)!
    this.cells.delete(sym)
    this.constant *= coefficient
    for (const [s, c] of this.cells) this.cells.set(s, c * coefficient)
  }
  /** Solve `lhs = this` for `rhs`. */
  solveForPair(lhs: number, rhs: number): void {
    this.insert(lhs, -1)
    this.solveFor(rhs)
  }
  coefficientFor(sym: number): number {
    return this.cells.get(sym) ?? 0
  }
  substitute(sym: number, row: Row): void {
    const c = this.cells.get(sym)
    if (c === undefined) return
    this.cells.delete(sym)
    this.insertRow(row, c)
  }
}

interface Tag {
  marker: number
  other: number
}
interface Edit {
  tag: Tag
  constraint: number
  constant: number
}
export interface Term {
  variable: number
  coefficient: number
}

export class UnsatisfiableError extends Error {}

export class Solver {
  private kinds: Kind[] = []
  /** variable index → its external symbol */
  private varSymbols: number[] = []
  private rows = new Map<number, Row>()
  /** symbol → the basic symbols whose rows use it (the column index) */
  private cols = new Map<number, Set<number>>()
  /** basic symbol → when it became basic: rows touched together are visited in this order */
  private seq = new Map<number, number>()
  private stamp = 0
  private constraints = new Map<number, { tag: Tag; strength: number }>()
  private edits = new Map<number, Edit>()
  private infeasible: number[] = []
  private objective = new Row()
  private artificial: Row | null = null
  private nextConstraint = 0
  /** pivots since construction: the cost of a change, counted (benchmarks and cost tests read it) */
  pivots = 0

  private symbol(kind: Kind): number {
    this.kinds.push(kind)
    return this.kinds.length - 1
  }

  addVariable(): number {
    this.varSymbols.push(this.symbol(Kind.External))
    return this.varSymbols.length - 1
  }

  /** Add `Σ terms + constant OP 0`; returns its id (for removeConstraint). */
  addConstraint(terms: readonly Term[], constant: number, op: Op, strength = Strength.required): number {
    strength = Strength.clip(strength)
    const tag: Tag = { marker: INVALID, other: INVALID }
    const row = this.createRow(terms, constant, op, strength, tag)
    let subject = this.chooseSubject(row, tag)
    if (subject === INVALID && this.allDummies(row)) {
      if (!nearZero(row.constant)) throw new UnsatisfiableError('unsatisfiable constraint')
      subject = tag.marker
    }
    if (subject === INVALID) {
      if (!this.addWithArtificialVariable(row)) throw new UnsatisfiableError('unsatisfiable constraint')
    } else {
      row.solveFor(subject)
      this.substitute(subject, row)
      this.attach(subject, row)
    }
    const id = this.nextConstraint++
    this.constraints.set(id, { tag, strength })
    this.optimize(this.objective)
    return id
  }

  removeConstraint(id: number): void {
    const c = this.constraints.get(id)
    if (!c) throw new Error('unknown constraint')
    this.constraints.delete(id)
    const { tag, strength } = c
    if (this.kinds[tag.marker] === Kind.Error) this.removeMarkerEffects(tag.marker, strength)
    if (tag.other !== INVALID && this.kinds[tag.other] === Kind.Error) this.removeMarkerEffects(tag.other, strength)
    if (!this.detach(tag.marker)) {
      const leaving = this.markerLeavingRow(tag.marker)
      if (leaving === INVALID) throw new Error('failed to find leaving row')
      const row = this.detach(leaving)!
      row.solveForPair(leaving, tag.marker)
      this.substitute(tag.marker, row)
    }
    this.optimize(this.objective)
  }

  addEditVariable(variable: number, strength: number): void {
    if (this.edits.has(variable)) throw new Error('duplicate edit variable')
    strength = Strength.clip(strength)
    if (strength === Strength.required) throw new Error('bad required strength')
    const constraint = this.addConstraint([{ variable, coefficient: 1 }], 0, Op.Eq, strength)
    this.edits.set(variable, { tag: this.constraints.get(constraint)!.tag, constraint, constant: 0 })
  }

  removeEditVariable(variable: number): void {
    const e = this.edits.get(variable)
    if (!e) throw new Error('unknown edit variable')
    this.removeConstraint(e.constraint)
    this.edits.delete(variable)
  }

  suggestValue(variable: number, value: number): void {
    const info = this.edits.get(variable)
    if (!info) throw new Error('unknown edit variable')
    const delta = value - info.constant
    info.constant = value
    const { marker, other } = info.tag
    const mrow = this.rows.get(marker)
    if (mrow) {
      if (mrow.add(-delta) < 0) this.infeasible.push(marker)
    } else {
      const orow = this.rows.get(other)
      if (orow) {
        if (orow.add(delta) < 0) this.infeasible.push(other)
      } else {
        for (const s of this.users(marker)) {
          const row = this.rows.get(s)!
          if (row.add(delta * row.coefficientFor(marker)) < 0 && this.kinds[s] !== Kind.External) this.infeasible.push(s)
        }
      }
    }
    this.dualOptimize()
  }

  /** The current value of a variable. */
  value(variable: number): number {
    const row = this.rows.get(this.varSymbols[variable])
    return row ? row.constant : 0
  }

  /** Every variable's value, by index. */
  values(out: Float64Array = new Float64Array(this.varSymbols.length)): Float64Array {
    for (let i = 0; i < this.varSymbols.length; i++) out[i] = this.value(i)
    return out
  }

  private createRow(terms: readonly Term[], constant: number, op: Op, strength: number, tag: Tag): Row {
    const row = new Row(constant)
    for (const { variable, coefficient } of terms) {
      if (nearZero(coefficient)) continue
      const sym = this.varSymbols[variable]
      const r = this.rows.get(sym)
      if (r) row.insertRow(r, coefficient)
      else row.insert(sym, coefficient)
    }
    if (op === Op.Le || op === Op.Ge) {
      const coeff = op === Op.Le ? 1 : -1
      const slack = this.symbol(Kind.Slack)
      tag.marker = slack
      row.insert(slack, coeff)
      if (strength < Strength.required) {
        const error = this.symbol(Kind.Error)
        tag.other = error
        row.insert(error, -coeff)
        this.objective.insert(error, strength)
      }
    } else if (strength < Strength.required) {
      const plus = this.symbol(Kind.Error)
      const minus = this.symbol(Kind.Error)
      tag.marker = plus
      tag.other = minus
      row.insert(plus, -1)
      row.insert(minus, 1)
      this.objective.insert(plus, strength)
      this.objective.insert(minus, strength)
    } else {
      const dummy = this.symbol(Kind.Dummy)
      tag.marker = dummy
      row.insert(dummy)
    }
    if (row.constant < 0) row.reverseSign()
    return row
  }

  private chooseSubject(row: Row, tag: Tag): number {
    for (const s of row.cells.keys()) if (this.kinds[s] === Kind.External) return s
    const pivotable = (s: number) => s !== INVALID && (this.kinds[s] === Kind.Slack || this.kinds[s] === Kind.Error)
    if (pivotable(tag.marker) && row.coefficientFor(tag.marker) < 0) return tag.marker
    if (pivotable(tag.other) && row.coefficientFor(tag.other) < 0) return tag.other
    return INVALID
  }

  private allDummies(row: Row): boolean {
    for (const s of row.cells.keys()) if (this.kinds[s] !== Kind.Dummy) return false
    return true
  }

  private addWithArtificialVariable(row: Row): boolean {
    const art = this.symbol(Kind.Slack)
    this.attach(art, row.copy())
    this.artificial = row.copy()
    this.optimize(this.artificial)
    const success = nearZero(this.artificial.constant)
    this.artificial = null
    const r = this.detach(art)
    if (r) {
      if (r.cells.size === 0) return success
      const entering = this.anyPivotableSymbol(r)
      if (entering === INVALID) return false
      r.solveForPair(art, entering)
      this.substitute(entering, r)
      this.attach(entering, r)
    }
    for (const s of this.users(art)) this.rows.get(s)!.remove(art)
    this.cols.delete(art)
    this.objective.remove(art)
    return success
  }

  /** A row becomes basic for `sym`: index its cells. */
  private attach(sym: number, row: Row): void {
    this.rows.set(sym, row)
    this.seq.set(sym, this.stamp++)
    for (const s of row.cells.keys()) this.link(s, sym)
  }

  /** `sym` stops being basic: its row, unindexed (undefined if it was not basic). */
  private detach(sym: number): Row | undefined {
    const row = this.rows.get(sym)
    if (!row) return undefined
    this.rows.delete(sym)
    this.seq.delete(sym)
    for (const s of row.cells.keys()) this.cols.get(s)!.delete(sym)
    return row
  }

  private link(sym: number, basic: number): void {
    const c = this.cols.get(sym)
    if (c) c.add(basic)
    else this.cols.set(sym, new Set([basic]))
  }

  /** The basic symbols whose rows use `sym`, in the order they became basic. */
  private users(sym: number): number[] {
    const c = this.cols.get(sym)
    if (!c || c.size === 0) return []
    const seq = this.seq
    return [...c].sort((a, b) => seq.get(a)! - seq.get(b)!)
  }

  /** Replace `sym` by `row` in the rows that use it (and the objectives), keeping the index. */
  private substitute(sym: number, row: Row): void {
    const users = this.users(sym)
    this.cols.delete(sym)
    for (const s of users) {
      const r = this.rows.get(s)!
      const c = r.cells.get(sym)!
      r.cells.delete(sym)
      r.constant += row.constant * c
      for (const [t, d] of row.cells) {
        r.insert(t, d * c)
        if (r.cells.has(t)) this.link(t, s)
        else this.cols.get(t)?.delete(s)
      }
      if (this.kinds[s] !== Kind.External && r.constant < 0) this.infeasible.push(s)
    }
    this.objective.substitute(sym, row)
    this.artificial?.substitute(sym, row)
  }

  private optimize(objective: Row): void {
    let stalled = 0
    for (;;) {
      const bland = stalled > STALL
      const entering = this.enteringSymbol(objective, bland)
      if (entering === INVALID) return
      const leaving = this.leavingRow(entering, bland)
      if (leaving === INVALID) throw new Error('the objective is unbounded')
      const row = this.detach(leaving)!
      stalled = nearZero(row.constant) ? stalled + 1 : 0
      row.solveForPair(leaving, entering)
      this.substitute(entering, row)
      this.attach(entering, row)
      this.pivots++
    }
  }

  private dualOptimize(): void {
    while (this.infeasible.length) {
      const leaving = this.infeasible.pop()!
      const row = this.rows.get(leaving)
      if (!row || row.constant >= 0) continue
      const entering = this.dualEnteringSymbol(row)
      if (entering === INVALID) throw new Error('dual optimize failed')
      this.detach(leaving)
      row.solveForPair(leaving, entering)
      this.substitute(entering, row)
      this.attach(entering, row)
      this.pivots++
    }
  }

  /** The symbol with the most negative objective coefficient (Bland: the lowest negative one). */
  private enteringSymbol(objective: Row, bland: boolean): number {
    let entering = INVALID
    let most = 0
    for (const [s, c] of objective.cells) {
      if (c >= 0 || this.kinds[s] === Kind.Dummy) continue
      if (bland ? entering === INVALID || s < entering : c < most) {
        most = c
        entering = s
      }
    }
    return entering
  }

  private dualEnteringSymbol(row: Row): number {
    let entering = INVALID
    let ratio = Number.MAX_VALUE
    for (const [s, c] of row.cells) {
      if (c > 0 && this.kinds[s] !== Kind.Dummy) {
        const r = this.objective.coefficientFor(s) / c
        if (r < ratio) {
          ratio = r
          entering = s
        }
      }
    }
    return entering
  }

  private anyPivotableSymbol(row: Row): number {
    for (const s of row.cells.keys()) if (this.kinds[s] === Kind.Slack || this.kinds[s] === Kind.Error) return s
    return INVALID
  }

  /** The row the entering symbol replaces: the lowest ratio, ties to the first (Bland: lowest) row. */
  private leavingRow(entering: number, bland: boolean): number {
    let ratio = Number.MAX_VALUE
    let found = INVALID
    for (const s of this.users(entering)) {
      if (this.kinds[s] === Kind.External) continue
      const row = this.rows.get(s)!
      const c = row.coefficientFor(entering)
      if (c < 0) {
        const r = -row.constant / c
        if (r < ratio || (bland && r === ratio && s < found)) {
          ratio = r
          found = s
        }
      }
    }
    return found
  }

  private markerLeavingRow(marker: number): number {
    let r1 = Number.MAX_VALUE
    let r2 = Number.MAX_VALUE
    let first = INVALID
    let second = INVALID
    let third = INVALID
    for (const s of this.users(marker)) {
      const row = this.rows.get(s)!
      const c = row.coefficientFor(marker)
      if (this.kinds[s] === Kind.External) third = s
      else if (c < 0) {
        const r = -row.constant / c
        if (r < r1) {
          r1 = r
          first = s
        }
      } else {
        const r = row.constant / c
        if (r < r2) {
          r2 = r
          second = s
        }
      }
    }
    return first !== INVALID ? first : second !== INVALID ? second : third
  }

  private removeMarkerEffects(marker: number, strength: number): void {
    const row = this.rows.get(marker)
    if (row) this.objective.insertRow(row, -strength)
    else this.objective.insert(marker, -strength)
  }
}
