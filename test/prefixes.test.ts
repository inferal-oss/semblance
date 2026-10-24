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

describe('declared prefixes', () => {
  it('name one namespace each across the framework and the site (queries are prefixed with all of them)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { Parser } = await import('n3')
    const { ONTOLOGY_FILES } = await import('../src/ontology.ts')
    const texts = [
      ...ONTOLOGY_FILES.map((f) => readFileSync(new URL(`../ontology/${f}`, import.meta.url), 'utf8')),
      readFileSync(new URL('../demo/app.ttl', import.meta.url), 'utf8'),
      ...readdirSync(new URL('../demo/gallery/', import.meta.url)).filter((f) => f.endsWith('.ttl')).map((f) => readFileSync(new URL(`../demo/gallery/${f}`, import.meta.url), 'utf8')),
    ]
    const SH = 'http://www.w3.org/ns/shacl#'
    const seen = new Map<string, Set<string>>()
    for (const text of texts) {
      const quads = new Parser().parse(text)
      for (const q of quads.filter((q) => q.predicate.value === SH + 'prefix')) {
        const ns = quads.find((n) => n.subject.equals(q.subject) && n.predicate.value === SH + 'namespace')?.object.value
        if (ns) seen.set(q.object.value, (seen.get(q.object.value) ?? new Set()).add(ns))
      }
    }
    expect([...seen].filter(([, ns]) => ns.size > 1).map(([p, ns]) => `${p}: ${[...ns].join(', ')}`)).toEqual([])
  })
})
