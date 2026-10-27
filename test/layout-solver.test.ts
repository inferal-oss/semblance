// The layout solver twins (src/layout/solver.ts, layout-solver/rust) and checker twins
// (src/layout/check.ts, layout-solver/rust/src/check.rs): known answers, then parity: the same
// systems, edits and removals give the same values and the same pivot counts.
import { existsSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { checkPacked, packBoxes, packInvariants, Rel } from '../src/layout/check.ts'
import { Op, Solver, Strength } from '../src/layout/solver.ts'
import { WasmLayout } from '../layout-solver/host.ts'
import { formPage, random, randomSystem } from '../layout-solver/scenarios.ts'

const WASM = new URL('../layout-solver/build/solver.wasm', import.meta.url)
let wasm: WasmLayout | undefined
beforeAll(async () => {
  if (existsSync(WASM)) wasm = await WasmLayout.load(readFileSync(WASM))
})

const t = (variable: number, coefficient = 1) => ({ variable, coefficient })

describe('solver', () => {
  it('meets required constraints and minimizes weak ones', () => {
    const s = new Solver()
    const x = s.addVariable()
    s.addConstraint([t(x)], -10, Op.Ge) // x ≥ 10
    s.addConstraint([t(x)], -50, Op.Eq, Strength.weak) // x = 50, weakly
    expect(s.value(x)).toBeCloseTo(50)
    const c = s.addConstraint([t(x)], -30, Op.Le) // x ≤ 30
    expect(s.value(x)).toBeCloseTo(30)
    s.removeConstraint(c)
    expect(s.value(x)).toBeCloseTo(50)
  })

  it('aligns one label column across separate fieldsets, and follows edits', () => {
    const s = new Solver()
    const p = formPage(s, 3, 4, 2)
    const v = s.values()
    const widest = Math.max(...p.labels.map((l) => v[l]))
    expect(v[p.column]).toBeCloseTo(widest)
    for (const c of p.controls) expect(v[c]).toBeCloseTo(1280 - 32 - widest - 12)
    expect(v[p.buttonWidth]).toBeCloseTo(Math.max(...p.buttons.map((b) => v[b])))
    // a longer label (a language switch) widens the column everywhere
    s.suggestValue(p.labels[5], 260)
    expect(s.value(p.column)).toBeCloseTo(260)
    // a phone: the column gives way to the 40% cap (strong) before a control shrinks below 120
    s.suggestValue(p.viewport, 320)
    expect(s.value(p.column)).toBeCloseTo(0.4 * (320 - 32))
    for (const c of p.controls) expect(s.value(c)).toBeGreaterThanOrEqual(120 - 1e-6)
    // rows stack by the token gap and the taller of label and control
    s.suggestValue(p.controlHeight, 44)
    expect(s.value(p.rowTops[1]) - s.value(p.rowTops[0])).toBeCloseTo(44 + 12)
  })
})

describe('solver parity (TypeScript and WASM)', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('random system %i', (seed) => {
    if (!wasm) return expect.fail('layout-solver/build/solver.wasm is missing: npx tsx layout-solver/build.ts')
    wasm.reset()
    const ts = new Solver()
    const a = randomSystem(ts, seed, 30)
    const b = randomSystem(wasm, seed, 30)
    expect(b).toEqual(a)
    expect(Array.from(wasm.values())).toEqual(Array.from(ts.values()))
    const rnd = random(seed * 7)
    for (let i = 0; i < 10; i++) {
      const id = a[Math.floor(rnd() * a.length)]
      if (id < 30) continue // keep the lower bounds
      try {
        ts.removeConstraint(id)
      } catch {
        expect(() => wasm!.removeConstraint(id)).toThrow()
        continue
      }
      wasm.removeConstraint(id)
    }
    expect(Array.from(wasm.values())).toEqual(Array.from(ts.values()))
    expect(wasm.pivots).toBe(ts.pivots)
  })

  it('a form page, resized and relabelled', () => {
    if (!wasm) return expect.fail('layout-solver/build/solver.wasm is missing')
    wasm.reset()
    const ts = new Solver()
    const p = formPage(ts, 4, 6, 3)
    formPage(wasm, 4, 6, 3)
    for (const w of [320, 375, 768, 1280, 641]) {
      ts.suggestValue(p.viewport, w)
      wasm.suggestValue(p.viewport, w)
      expect(Array.from(wasm.values())).toEqual(Array.from(ts.values()))
    }
    const rnd = random(9)
    for (const l of p.labels) {
      const w = 40 + Math.round(rnd() * 200)
      ts.suggestValue(l, w)
      wasm.suggestValue(l, w)
    }
    expect(Array.from(wasm.values())).toEqual(Array.from(ts.values()))
    expect(wasm.pivots).toBe(ts.pivots)
  })
})

describe('checker parity (TypeScript and WASM)', () => {
  it('finds the same findings over the same boxes', () => {
    if (!wasm) return expect.fail('layout-solver/build/solver.wasm is missing')
    const rnd = random(3)
    const boxes = Array.from({ length: 400 }, () => ({ x: Math.round(rnd() * 300), y: Math.round(rnd() * 900), width: Math.round(rnd() * 100), height: 36 + Math.round(rnd() * 4) }))
    const invariants = Array.from({ length: 120 }, (_, i) => ({
      rel: ((i % 7) + 1) as Rel,
      members: Array.from({ length: 2 + (i % 5) }, () => Math.floor(rnd() * 400)),
      tolerance: 0.5,
    }))
    const b = packBoxes(boxes)
    const p = packInvariants(invariants)
    const findings = checkPacked(b, p)
    expect(findings.length).toBeGreaterThan(10)
    expect(wasm.check(b, p)).toEqual(findings)
  })
})
