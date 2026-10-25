import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { compileStyles } from '../src/style/compile.ts'

// The motion layer stills motion by re-valuing the motion tokens, so every transition and
// animation must be timed by them. These tests resolve the compiled declarations against the
// tokens as the browser would for an element under each preference.

const css = compileStyles(loadStore('n3'))

/** The declarations of every rule whose selector is exactly `selector`, merged in order. */
function block(selector: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of css.split('\n')) {
    if (!line.startsWith(`  ${selector} { `)) continue
    const body = line.slice(selector.length + 5, line.lastIndexOf(' }'))
    let depth = 0
    let start = 0
    for (let i = 0; i <= body.length; i++) {
      const ch = body[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if ((ch === ';' || i === body.length) && depth === 0) {
        const decl = body.slice(start, i).trim()
        start = i + 1
        if (!decl) continue
        const colon = decl.indexOf(':')
        out.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim())
      }
    }
  }
  if (!out.size) throw new Error(`no rule for ${selector}`)
  return out
}

/** The tokens an element sees under a motion preference (the root's, re-valued by the layer's). */
function tokens(pref: 'full' | 'reduced' | 'none'): Map<string, string> {
  const t = new Map(block(':root'))
  if (pref !== 'full') for (const [k, v] of block(`[data-sem-motion="${pref}"]`)) t.set(k, v)
  return t
}

/** A value with its var() references substituted and calc() of times evaluated, in ms. */
function resolve(value: string, t: Map<string, string>): string {
  let v = value
  for (let i = 0; i < 10 && v.includes('var('); i++) v = v.replace(/var\((--[\w-]+)(?:, ([^()]*))?\)/g, (_, name, fb) => t.get(name) ?? fb ?? '')
  for (let i = 0; i < 10 && v.includes('calc('); i++)
    v = v.replace(/calc\(([\d.]+)(ms|s) ([*/]) ([\d.]+)\)/g, (_, a, u, op, b) => {
      const ms = Number(a) * (u === 's' ? 1000 : 1)
      return `${op === '*' ? ms * Number(b) : ms / Number(b)}ms`
    })
  return v
}

const FACES = '[data-sem-c="flippable"] > .sem-faces'

describe('motion preference', () => {
  it('times the flippable turn, its face swap and its fade from the motion tokens', () => {
    const turn = block(FACES).get('transition')!
    const swap = block(`${FACES} > .sem-back`).get('transition')!
    const fadeBack = block(`[data-sem-c="flippable"][data-flipped=true] > .sem-faces > .sem-back`).get('animation')!
    const fadeFront = block(`[data-sem-c="flippable"]:not([data-flipped=true]) > .sem-faces > .sem-front`).get('animation')!
    expect(block(`${FACES} > .sem-front`).get('transition')).toBe(swap)

    const full = tokens('full')
    expect(resolve(turn, full)).toBe('transform 700ms cubic-bezier(0.3, 0.7, 0.1, 1)')
    expect(resolve(swap, full)).toBe('visibility 0s linear 350ms')
    expect(resolve(fadeBack, full)).toBe('none')

    // Reduced: no turn, the swap at once, the face coming into view fades in shortly.
    const reduced = tokens('reduced')
    expect(resolve(turn, reduced)).toBe('transform 0ms linear')
    expect(resolve(swap, reduced)).toBe('visibility 0s linear 0ms')
    expect(resolve(fadeBack, reduced)).toBe('sem-fade-in 80ms linear')
    expect(resolve(fadeFront, reduced)).toBe('sem-fade-in 80ms linear')

    // None: instant, nothing fades, no wrong face in between.
    const none = tokens('none')
    expect(resolve(turn, none)).toMatch(/^transform 0ms /)
    expect(resolve(swap, none)).toBe('visibility 0s linear 0ms')
    expect(resolve(fadeBack, none)).toBe('none')
  })

  it('slows the repeating animations when reduced and stills them when none', () => {
    const spin = block('[data-sem-c="spinner"] > .sem-ring').get('animation')!
    const ms = (pref: 'full' | 'reduced' | 'none') => Number(resolve(spin, tokens(pref)).match(/([\d.]+)ms/)![1])
    expect(ms('reduced')).toBeGreaterThan(ms('full'))
    expect(ms('none')).toBe(0)
  })

  it('re-values every duration token under reduced and none', () => {
    const durations = [...block(':root').keys()].filter((k) => k.startsWith('--sem-duration'))
    for (const pref of ['reduced', 'none'] as const) {
      const set = block(`[data-sem-motion="${pref}"]`)
      for (const k of durations) expect(set.has(k), `${pref} ${k}`).toBe(true)
    }
  })

  it('leaves no transition or animation in any theme or component timed outside the motion tokens', () => {
    const literalTime = /(?<![\w.-])(?!0+(?:ms|s)\b)\d*\.?\d+(?:ms|s)\b/
    const offenders: string[] = []
    for (const line of css.split('\n')) {
      for (const m of line.matchAll(/(?:\{ |; )((?:transition|animation)[\w-]*): ([^;]+)/g)) {
        if (literalTime.test(m[2]!)) offenders.push(`${line.trim().slice(0, 120)} … ${m[1]}: ${m[2]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
