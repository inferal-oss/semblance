// The layout solver twins (src/layout/solver.ts, layout-solver/rust) and checker twins
// (src/layout/check.ts, layout-solver/rust/src/check.rs): known answers, then parity: the same
// systems, edits and removals give the same values and the same pivot counts.
import { existsSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { checkPacked, packBoxes, packInvariants, Rel } from '../src/layout/check.ts'
import { Op, Solver, Strength } from '../src/layout/solver.ts'
import { WasmLayout } from '../src/layout/wasm.ts'
import { checkerKind, createLayoutSolver, LAYOUT_PREFERENCE, provideLayoutModule } from '../src/layout/engine.ts'
import { initLayout } from '../src/node/load.ts'
import { formPage, random, randomSystem } from '../layout-solver/scenarios.ts'

// every WASM twin that is built (layout-solver/build.ts): rust, wat
const BUILDS = ['rust', 'wat'].filter((k) => existsSync(new URL(`../layout-solver/build/${k}.wasm`, import.meta.url)))
const builds: Record<string, WasmLayout> = {}
beforeAll(async () => {
  for (const k of BUILDS) builds[k] = await WasmLayout.load(readFileSync(new URL(`../layout-solver/build/${k}.wasm`, import.meta.url)))
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
    // a phone: the column keeps to 40% of the page (its labels wrap), the controls take the rest
    s.suggestValue(p.viewport, 320)
    expect(s.value(p.column)).toBeCloseTo(0.4 * (320 - 32))
    for (const c of p.controls) expect(s.value(c)).toBeCloseTo(320 - 32 - 0.4 * (320 - 32) - 12)
    // rows stack by the token gap and the taller of label and control
    s.suggestValue(p.controlHeight, 44)
    expect(s.value(p.rowTops[1]) - s.value(p.rowTops[0])).toBeCloseTo(44 + 12)
  })

  it('pivots about once per constraint, however many share a variable', () => {
    // every row's height ≥ the shared control height: with the first improving symbol entering
    // (kiwi's rule), the k-th of them re-pivoted the k before it (10,195 pivots for 100 fields)
    for (const [f, r, t] of [[10, 10, 10], [25, 20, 30]]) {
      const s = new Solver()
      const p = formPage(s, f, r, t)
      expect(s.pivots).toBeLessThan(1.5 * p.constraints)
    }
  })
})

it('has a WASM build', () => expect(BUILDS).toContain('rust'))

describe.each(BUILDS)('solver parity (TypeScript and %s)', (kind) => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('random system %i', (seed) => {
    const wasm = builds[kind]
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
        expect(() => wasm.removeConstraint(id)).toThrow()
        continue
      }
      wasm.removeConstraint(id)
    }
    expect(Array.from(wasm.values())).toEqual(Array.from(ts.values()))
    expect(wasm.pivots).toBe(ts.pivots)
  })

  it('a form page, resized and relabelled', () => {
    const wasm = builds[kind]
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

describe.each(BUILDS)('checker parity (TypeScript and %s)', (kind) => {
  it('finds the same findings over the same boxes', () => {
    const wasm = builds[kind]
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

describe('the layout engine: WASM by default, TypeScript as the backup', () => {
  // runs in file order: before initLayout, after it, then with a build that cannot instantiate
  it('solves and checks in TypeScript before any build is offered', async () => {
    const { kind, solver } = await createLayoutSolver()
    expect([kind, solver instanceof Solver, checkerKind()]).toEqual(['ts', true, 'ts'])
  })

  it('prefers a WASM build once one is loaded, and gives the same answers', async () => {
    const kinds = await initLayout()
    expect(kinds[0]).toBe(LAYOUT_PREFERENCE.find((k) => k === 'ts' || BUILDS.includes(k)))
    expect(kinds.at(-1)).toBe('ts')
    const { kind, solver } = await createLayoutSolver()
    expect(kind).toBe(kinds[0])
    expect(checkerKind()).toBe(kinds[0])
    const ts = new Solver()
    formPage(solver, 2, 4, 1)
    formPage(ts, 2, 4, 1)
    expect(Array.from(solver.values())).toEqual(Array.from(ts.values()))
    expect((await createLayoutSolver('ts')).kind).toBe('ts')
  })

  it('falls back when a build does not instantiate', async () => {
    // a module that imports env.f, which the engine never provides
    const broken = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 9, 1, 3, 101, 110, 118, 1, 102, 0, 0]))
    for (const k of ['rust', 'wat'] as const) await provideLayoutModule(k, broken)
    const { kind, solver } = await createLayoutSolver()
    expect([kind, solver instanceof Solver]).toEqual(['ts', true])
  })
})
