import { describe, expect, it } from 'vitest'
import { linearize, OrderingError } from '../src/render/ordering.ts'

const edges = (...pairs: [string, string][]) => {
  const m = new Map<string, Set<string>>()
  for (const [a, b] of pairs) m.set(a, new Set([...(m.get(a) ?? []), b]))
  return m
}
const none = new Map<string, Set<string>>()

describe('linearize', () => {
  it('follows an immediate chain', () => {
    expect(linearize('p', new Set(['c', 'a', 'b']), edges(['a', 'b'], ['b', 'c']), none)).toEqual(['a', 'b', 'c'])
  })

  it('orders optional parts with strict precedence', () => {
    // label < input < help < error, where help may be absent
    const strict = edges(['label', 'input'], ['input', 'help'], ['input', 'error'], ['help', 'error'])
    expect(linearize('p', new Set(['error', 'input', 'label', 'help']), none, strict)).toEqual(['label', 'input', 'help', 'error'])
    expect(linearize('p', new Set(['error', 'input', 'label']), none, strict)).toEqual(['label', 'input', 'error'])
  })

  it('combines immediate chains with strict edges between them', () => {
    const imm = edges(['a', 'b'], ['x', 'y'])
    expect(linearize('p', new Set(['x', 'y', 'a', 'b']), imm, edges(['b', 'x']))).toEqual(['a', 'b', 'x', 'y'])
  })

  it('rejects ambiguity instead of guessing', () => {
    expect(() => linearize('p', new Set(['a', 'b', 'c']), edges(['a', 'b']), none)).toThrow(OrderingError)
  })

  it('rejects cycles and contradictions', () => {
    expect(() => linearize('p', new Set(['a', 'b']), edges(['a', 'b'], ['b', 'a']), none)).toThrow(/cycle/)
    expect(() => linearize('p', new Set(['a', 'b']), none, edges(['a', 'b'], ['b', 'a']))).toThrow(/cycle/)
    expect(() => linearize('p', new Set(['a', 'b']), edges(['a', 'b']), edges(['b', 'a']))).toThrow(/contradicts/)
    expect(() => linearize('p', new Set(['a', 'b', 'c']), edges(['a', 'b'], ['a', 'c']), none)).toThrow(/conflicting/)
  })
})
