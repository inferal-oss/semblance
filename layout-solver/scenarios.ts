// Realistic constraint sets for the solver twins: what Semblance would hand a solver that CSS can't
// (one label column across separate fieldsets, equal-width buttons across separate toolbars,
// vertical rhythm from tokens), driven by measured inputs as edit variables.
import { Op, Strength, type SolverLike, type Term } from '../src/layout/solver.ts'

export type { SolverLike }

const t = (variable: number, coefficient = 1): Term => ({ variable, coefficient })

/** A deterministic pseudo-random sequence (mulberry32), so both twins see the same inputs. */
export function random(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

export interface FormPage {
  viewport: number
  labels: number[]
  labelHeights: number[]
  controlHeight: number
  buttons: number[]
  column: number
  buttonWidth: number
  controls: number[]
  rowTops: number[]
  constraints: number
}

/**
 * A settings-like page: `fieldsets` separate fieldsets of `rows` rows each, one shared label column
 * (as wide as the widest label, never wider than 40% of the page: past that labels wrap), controls filling the rest down
 * to a minimum; rows stacked with a token gap, each as tall as its label or the control height;
 * `toolbars` separate toolbars of 3 buttons, all as wide as the widest button label.
 */
export function formPage(s: SolverLike, fieldsets: number, rows: number, toolbars: number, seed = 1): FormPage {
  const rnd = random(seed)
  const GAP = 12
  const PAD = 16
  let constraints = 0
  const add = (terms: Term[], c: number, op: Op, strength = Strength.required) => {
    constraints++
    return s.addConstraint(terms, c, op, strength)
  }
  const viewport = s.addVariable()
  s.addEditVariable(viewport, Strength.strong)
  s.suggestValue(viewport, 1280)
  const content = s.addVariable()
  add([t(content), t(viewport, -1)], 2 * PAD, Op.Eq) // content = viewport - 2·pad
  const column = s.addVariable()
  add([t(column)], 0, Op.Eq, Strength.weak) // as narrow as it may be
  add([t(column), t(content, -0.4)], 0, Op.Le) // at most 40% of the page
  const controlHeight = s.addVariable()
  s.addEditVariable(controlHeight, Strength.strong)
  s.suggestValue(controlHeight, 38)
  const labels: number[] = []
  const labelHeights: number[] = []
  const controls: number[] = []
  const rowTops: number[] = []
  for (let f = 0; f < fieldsets; f++) {
    let prevTop = -1
    let prevHeight = -1
    for (let r = 0; r < rows; r++) {
      const label = s.addVariable()
      s.addEditVariable(label, Strength.strong)
      s.suggestValue(label, 40 + Math.round(rnd() * 160))
      labels.push(label)
      const lh = s.addVariable()
      s.addEditVariable(lh, Strength.strong)
      s.suggestValue(lh, 20)
      labelHeights.push(lh)
      add([t(column), t(label, -1)], 0, Op.Ge, Strength.medium) // holds every label, or labels wrap (never bends the viewport)
      const control = s.addVariable()
      add([t(control), t(content, -1), t(column)], GAP, Op.Eq, Strength.strong) // fills the rest
      add([t(control)], -120, Op.Ge) // never narrower than 120
      controls.push(control)
      const top = s.addVariable()
      const height = s.addVariable()
      add([t(height), t(lh, -1)], 0, Op.Ge)
      add([t(height), t(controlHeight, -1)], 0, Op.Ge)
      add([t(height)], 0, Op.Eq, Strength.weak)
      if (prevTop < 0) add([t(top)], -f * 1000, Op.Eq)
      else add([t(top), t(prevTop, -1), t(prevHeight, -1)], -GAP, Op.Eq)
      rowTops.push(top)
      prevTop = top
      prevHeight = height
    }
  }
  const buttonWidth = s.addVariable()
  add([t(buttonWidth)], 0, Op.Eq, Strength.weak)
  const buttons: number[] = []
  for (let b = 0; b < toolbars * 3; b++) {
    const intrinsic = s.addVariable()
    s.addEditVariable(intrinsic, Strength.strong)
    s.suggestValue(intrinsic, 60 + Math.round(rnd() * 60))
    add([t(buttonWidth), t(intrinsic, -1)], 0, Op.Ge)
    buttons.push(intrinsic)
  }
  // three buttons and two gaps fit in the page
  add([t(buttonWidth, 3), t(content, -1)], 2 * 8, Op.Le, Strength.strong)
  return { viewport, labels, labelHeights, controlHeight, buttons, column, buttonWidth, controls, rowTops, constraints }
}

/** Random small systems for parity: chains of inequalities and weak preferences, then edits and removals. */
export function randomSystem(s: SolverLike, seed: number, n: number): number[] {
  const rnd = random(seed)
  const vars = Array.from({ length: n }, () => s.addVariable())
  const ids: number[] = []
  for (const v of vars) ids.push(s.addConstraint([t(v)], -Math.round(rnd() * 100), Op.Ge, Strength.required)) // v ≥ k
  for (let i = 0; i < n * 2; i++) {
    const a = vars[Math.floor(rnd() * n)]
    const b = vars[Math.floor(rnd() * n)]
    if (a === b) continue
    const strength = [Strength.weak, Strength.medium, Strength.strong][Math.floor(rnd() * 3)]
    const op = [Op.Le, Op.Ge, Op.Eq][Math.floor(rnd() * 3)]
    ids.push(s.addConstraint([t(a), t(b, -1)], Math.round(rnd() * 40 - 20), op, strength))
  }
  return ids
}
