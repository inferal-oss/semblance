// Jelly (#433): the TypeScript codec (src/jelly/) against the Jelly-RDF conformance suite, a round
// trip of real graphs, streaming in chunks, and a writer whose frames cost what they hold.
import { readFileSync } from 'node:fs'
import { DataFactory, Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { JELLY_MANIFESTS, loadJellyManifest, runJellyTest, tsJelly } from '../rdf-engine/conformance/jelly.ts'
import { FrameSplitter, frames, JellyReader, readJelly } from '../src/jelly/decode.ts'
import { delimit, JellyWriter, writeJelly } from '../src/jelly/encode.ts'

const read = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const key = (q: { subject: { value: string; termType: string }; predicate: { value: string }; object: { value: string; termType: string } }) =>
  `${q.subject.termType === 'BlankNode' ? '_' : q.subject.value} ${q.predicate.value} ${q.object.termType === 'BlankNode' ? '_' : q.object.value}`

describe('Jelly, the TypeScript codec', () => {
  it('passes the Jelly-RDF conformance suite (generalized RDF aside)', () => {
    const failing: string[] = []
    let skipped = 0
    for (const t of JELLY_MANIFESTS.flatMap(loadJellyManifest)) {
      const o = runJellyTest(tsJelly, t)
      if (o.status === 'fail') failing.push(`${t.id}: ${o.reason}`)
      if (o.status === 'skip') skipped++
    }
    expect(failing).toEqual([])
    expect(skipped).toBe(28)
  })

  it('reads back what it writes: the hello example and an ontology file, in order', () => {
    for (const ttl of [read('examples/hello/app.ttl'), read('ontology/core.ttl')]) {
      const quads = new Parser().parse(ttl)
      const back = readJelly(writeJelly(quads, { physical: 1, frameRows: 100 }), DataFactory)
      expect(back.map(key)).toEqual(quads.map(key))
    }
  })

  it('reads a stream that arrives in chunks of any size, frame by frame', () => {
    const quads = new Parser().parse(read('examples/hello/tally.ttl'))
    const bytes = writeJelly(quads, { physical: 1, frameRows: 7 })
    for (const size of [1, 3, 64, bytes.length]) {
      const split = new FrameSplitter()
      const reader = new JellyReader(DataFactory)
      const out: string[] = []
      for (let i = 0; i < bytes.length; i += size) for (const f of split.push(bytes.subarray(i, i + size))) reader.frame(f, { quad: (q) => void out.push(key(q)) })
      split.end()
      expect(out).toEqual(quads.map(key))
    }
    expect(() => new FrameSplitter().push(bytes.subarray(0, 5)) && undefined).not.toThrow()
  })

  it('carries RDF Messages, each its own blank node scope', () => {
    const f = DataFactory
    const w = new JellyWriter({ physical: 1, streamType: 1 })
    const p = f.namedNode('https://example.org/p')
    const parts: Uint8Array[] = []
    for (let m = 0; m < 3; m++) {
      for (const q of [f.quad(f.blankNode('x'), p, f.literal(String(m))), f.quad(f.blankNode('x'), p, f.blankNode('y'))]) parts.push(...w.add(q).map(delimit))
      w.endMessage()
    }
    parts.push(delimit(w.flush()!))
    const reader = new JellyReader(f)
    const messages: string[][] = [[]]
    const subjects: string[] = []
    const sink = { quad: (q: { subject: { value: string } }) => void (messages.at(-1)!.push((q as never as { object: { value: string } }).object.value), subjects.push(q.subject.value)), message: () => void messages.push([]) }
    for (const part of parts) for (const fr of frames(part)) reader.frame(fr, sink as never)
    reader.end(sink as never)
    expect(messages.slice(0, 3).map((m) => m[0])).toEqual(['0', '1', '2'])
    // The same label in three messages is three blank nodes.
    expect(new Set(subjects).size).toBe(3)
  })

  it('writes frames that cost what they hold: a frame of the same statements is the same size, late in a long stream', () => {
    const f = DataFactory
    const w = new JellyWriter({ physical: 1, frameRows: 50 })
    const sizes: number[] = []
    for (let i = 0; i < 20_000; i++) {
      // The same 50 subjects, over and over, with fresh values.
      for (const fr of w.add(f.quad(f.namedNode(`https://example.org/s${i % 50}`), f.namedNode('https://example.org/p'), f.literal(String(i % 1000).padStart(4, '0'))))) sizes.push(fr.length)
    }
    // The first frame has the options and the lookup entries; later ones only their statements.
    const late = sizes.slice(-50)
    expect(Math.max(...late) - Math.min(...late)).toBeLessThanOrEqual(2)
    expect(late[0]!).toBeLessThan(sizes[0]!)
  })
})
