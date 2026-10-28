// The layout checker: invariants (lc:) evaluated over rendered boxes (rnd:). It answers "are the
// sizes aligned, does everything fit?" with findings, never by changing the layout.
//
// The invariants are data: ontology/layers/constraints.ttl declares them on classes (every
// lc:SingleLineControl in one lc:scope has one block size; a field row's controls share top and
// bottom edges; a nav item fits in its list), and the SPARQL there finds the same violations over
// the urn:semblance:rendered graph. This is the function twin and the oracle, and the input format
// of the WASM twin (layout-solver/rust/src/check.rs): boxes as a Float64Array of x, y, width,
// height (document px), invariants as a flat Int32Array program.

export const enum Rel {
  /** all members have the same block size (height) */
  SameBlockSize = 1,
  /** all members have the same inline size (width) */
  SameInlineSize = 2,
  /** all members share their top edge */
  SameTop = 3,
  /** all members share their bottom edge */
  SameBottom = 4,
  /** all members share their start (left) edge */
  SameStart = 5,
  /** each member lies within the first member (its container) on the inline axis */
  FitsInline = 6,
  /** each member lies within the first member on both axes */
  FitsWithin = 7,
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Invariant {
  rel: Rel
  /** box indices; for the Fits relations the first is the container */
  members: number[]
  /** px allowed before it counts (sub-pixel rounding, borders) */
  tolerance: number
}

export interface Finding {
  invariant: number
  /** the member that breaks it (for a group: the one farthest from the first) */
  member: number
  /** by how many px (for a group: its spread, max - min) */
  by: number
}

/** Boxes into the flat layout the checkers read: x, y, width, height per box. */
export function packBoxes(boxes: readonly Box[]): Float64Array {
  const out = new Float64Array(boxes.length * 4)
  boxes.forEach((b, i) => out.set([b.x, b.y, b.width, b.height], i * 4))
  return out
}

/** Invariants into the program: rel, tolerance in 1/100 px, member count, members… */
export function packInvariants(invariants: readonly Invariant[]): Int32Array {
  const out: number[] = []
  for (const inv of invariants) out.push(inv.rel, Math.round(inv.tolerance * 100), inv.members.length, ...inv.members)
  return Int32Array.from(out)
}

const top = (b: Float64Array, i: number) => b[i * 4 + 1]
const bottom = (b: Float64Array, i: number) => b[i * 4 + 1] + b[i * 4 + 3]
const start = (b: Float64Array, i: number) => b[i * 4]
const end = (b: Float64Array, i: number) => b[i * 4] + b[i * 4 + 2]
const width = (b: Float64Array, i: number) => b[i * 4 + 2]
const height = (b: Float64Array, i: number) => b[i * 4 + 3]

const MEASURE: Partial<Record<Rel, (b: Float64Array, i: number) => number>> = {
  [Rel.SameBlockSize]: height,
  [Rel.SameInlineSize]: width,
  [Rel.SameTop]: top,
  [Rel.SameBottom]: bottom,
  [Rel.SameStart]: start,
}

/** Check a packed program over packed boxes; findings as invariant, member, by (px) triples. */
export function checkPacked(boxes: Float64Array, program: Int32Array): Finding[] {
  const findings: Finding[] = []
  for (let pc = 0, inv = 0; pc < program.length; inv++) {
    const rel = program[pc] as Rel
    const tolerance = program[pc + 1] / 100
    const n = program[pc + 2]
    const m = pc + 3
    pc = m + n
    const measure = MEASURE[rel]
    if (measure) {
      // a group's spread (max - min); the member reported is the one farthest from the first
      const v0 = measure(boxes, program[m])
      let lo = v0
      let hi = v0
      let worst = program[m]
      let far = 0
      for (let k = 1; k < n; k++) {
        const v = measure(boxes, program[m + k])
        if (v < lo) lo = v
        if (v > hi) hi = v
        if (Math.abs(v - v0) > far) {
          far = Math.abs(v - v0)
          worst = program[m + k]
        }
      }
      if (hi - lo > tolerance) findings.push({ invariant: inv, member: worst, by: hi - lo })
      continue
    }
    const c = program[m]
    for (let k = 1; k < n; k++) {
      const i = program[m + k]
      let over = Math.max(start(boxes, c) - start(boxes, i), end(boxes, i) - end(boxes, c))
      if (rel === Rel.FitsWithin) over = Math.max(over, top(boxes, c) - top(boxes, i), bottom(boxes, i) - bottom(boxes, c))
      if (over > tolerance) findings.push({ invariant: inv, member: i, by: over })
    }
  }
  return findings
}

export function check(boxes: readonly Box[], invariants: readonly Invariant[]): Finding[] {
  return checkPacked(packBoxes(boxes), packInvariants(invariants))
}
