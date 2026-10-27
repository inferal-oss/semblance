// An incremental linear constraint solver: Cassowary (Badros, Borning, Stuckey 2001) in the shape
// of kiwi (github.com/nucleic/kiwi). Constraints are `Σ coefficient·variable + constant OP 0` with
// a strength; required ones must hold, weaker ones are minimized in a weighted objective. Edit
// variables take suggested values and re-solve by dual simplex, so a change (a new viewport width,
// one label measured wider) costs the pivots it causes, not a solve from scratch.
//
// layout-solver/rust/src/solver.rs is the same algorithm, step for step: both iterate rows and cells
// in insertion order, so the twins pivot identically and their values agree (layout-solver.test.ts).

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
      this.rows.set(subject, row)
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
    if (!this.rows.delete(tag.marker)) {
      const leaving = this.markerLeavingRow(tag.marker)
      if (leaving === INVALID) throw new Error('failed to find leaving row')
      const row = this.rows.get(leaving)!
      this.rows.delete(leaving)
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
        for (const [s, row] of this.rows) {
          const c = row.coefficientFor(marker)
          if (c !== 0 && row.add(delta * c) < 0 && this.kinds[s] !== Kind.External) this.infeasible.push(s)
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
    this.rows.set(art, row.copy())
    this.artificial = row.copy()
    this.optimize(this.artificial)
    const success = nearZero(this.artificial.constant)
    this.artificial = null
    const r = this.rows.get(art)
    if (r) {
      this.rows.delete(art)
      if (r.cells.size === 0) return success
      const entering = this.anyPivotableSymbol(r)
      if (entering === INVALID) return false
      r.solveForPair(art, entering)
      this.substitute(entering, r)
      this.rows.set(entering, r)
    }
    for (const row of this.rows.values()) row.remove(art)
    this.objective.remove(art)
    return success
  }

  private substitute(sym: number, row: Row): void {
    for (const [s, r] of this.rows) {
      r.substitute(sym, row)
      if (this.kinds[s] !== Kind.External && r.constant < 0) this.infeasible.push(s)
    }
    this.objective.substitute(sym, row)
    this.artificial?.substitute(sym, row)
  }

  private optimize(objective: Row): void {
    for (;;) {
      const entering = this.enteringSymbol(objective)
      if (entering === INVALID) return
      const leaving = this.leavingRow(entering)
      if (leaving === INVALID) throw new Error('the objective is unbounded')
      const row = this.rows.get(leaving)!
      this.rows.delete(leaving)
      row.solveForPair(leaving, entering)
      this.substitute(entering, row)
      this.rows.set(entering, row)
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
      this.rows.delete(leaving)
      row.solveForPair(leaving, entering)
      this.substitute(entering, row)
      this.rows.set(entering, row)
      this.pivots++
    }
  }

  private enteringSymbol(objective: Row): number {
    for (const [s, c] of objective.cells) if (this.kinds[s] !== Kind.Dummy && c < 0) return s
    return INVALID
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

  private leavingRow(entering: number): number {
    let ratio = Number.MAX_VALUE
    let found = INVALID
    for (const [s, row] of this.rows) {
      if (this.kinds[s] === Kind.External) continue
      const c = row.coefficientFor(entering)
      if (c < 0) {
        const r = -row.constant / c
        if (r < ratio) {
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
    for (const [s, row] of this.rows) {
      const c = row.coefficientFor(marker)
      if (c === 0) continue
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
