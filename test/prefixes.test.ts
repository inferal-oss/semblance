import { describe, expect, it } from 'vitest'
import { NS } from '../src/ns.ts'
import { compactIri } from '../src/prefixes.ts'

describe('compactIri', () => {
  const prefixes = { ...NS, ui: 'https://semblance.dev/demo#', ch: 'https://semblance.dev/demo/chat#' }
  it('uses the longest namespace that fits', () => {
    expect(compactIri(NS.c + 'Button', prefixes)).toBe('c:Button')
    expect(compactIri('https://semblance.dev/demo/chat#Send', prefixes)).toBe('ch:Send')
  })
  it('falls back to the namespace’s own last segment', () => {
    expect(compactIri('https://semblance.dev/demo/kanban#MoveRight', prefixes)).toBe('kanban:MoveRight')
    expect(compactIri('urn:x', prefixes)).toBe('urn:x')
  })
})
