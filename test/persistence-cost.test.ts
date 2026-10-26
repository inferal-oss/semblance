// A persistence policy's CONSTRUCT as a maintained view (docs/IVM.md, phase 3): a write stores what
// changed since the last one, so writing costs the change, not the policy's size - the same over 200
// stored triples as over 2,000 - and a restore puts back exactly the current state, chunks and all.
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS } from '../src/ns.ts'
import { memoryBackend, Persistence } from '../src/persistence.ts'
import { Runtime } from '../src/runtime.ts'

const X = 'https://example.org/kept#'
const PER = NS.per

const turtle = (n: number) => `
@prefix x: <${X}> .
@prefix per: <${PER}> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
x:prefixes sh:declare [ sh:prefix "x" ; sh:namespace "${X}"^^xsd:anyURI ] .
x:remember a per:Policy ; per:scope per:Session ;
    per:construct """CONSTRUCT { ?i x:score ?s ; x:tag ?t } WHERE { x:list x:item ?i . { ?i x:score ?s } UNION { ?i x:tag ?t } }""" .
${Array.from({ length: n }, (_, i) => `x:list x:item x:i${i} . x:i${i} x:score ${i} .`).join('\n')}
`

async function kept(n: number) {
  const backend = memoryBackend()
  const backends = { [PER + 'Session']: backend, [PER + 'Device']: memoryBackend() }
  const store = loadStore('oxigraph', turtle(n))
  const persistence = new Persistence(store, backends, { delayMs: 60_000 })
  await persistence.restore()
  const runtime = new Runtime(store)
  runtime.project({ modality: MOD.Screen })
  persistence.attach(runtime)
  const f = store.factory
  const nn = (s: string) => f.namedNode(X + s)
  const int = (v: number) => f.literal(String(v), f.namedNode(NS.xsd + 'integer'))
  const setScore = (i: number, v: number) => runtime.apply({ remove: store.match(nn('i' + i), nn('score'), null), add: [f.quad(nn('i' + i), nn('score'), int(v))] })
  return { store, runtime, persistence, backends, f, nn, int, setScore }
}

describe('persistence policies as views', () => {
  it('writes the change, not the policy: the same over 200 stored triples as over 2,000', async () => {
    const cost = async (n: number) => {
      const k = await kept(n)
      // The first write stores everything (the base).
      k.setScore(0, 1000)
      await k.persistence.flush()
      const base = { ...k.persistence.writes }
      expect(base.triples).toBe(n)
      // Then each write stores only what changed.
      k.setScore(1, 2000)
      k.runtime.apply({ remove: [], add: [k.f.quad(k.nn('i2'), k.nn('tag'), k.f.literal('hot'))] })
      await k.persistence.flush()
      return { entries: k.persistence.writes.entries - base.entries, triples: k.persistence.writes.triples - base.triples }
    }
    const small = await cost(200)
    const large = await cost(2000)
    expect(large).toEqual(small)
    // One chunk (the score's -1 and +1, the tag's +1) and the head.
    expect(small).toEqual({ entries: 2, triples: 3 })
  })

  it('restores exactly the current state from the base and its chunks, and compacts them', async () => {
    const k = await kept(30)
    for (let step = 0; step < 50; step++) {
      k.setScore(step % 30, 500 + step)
      if (step % 7 === 0) k.runtime.apply({ remove: k.store.match(k.nn('i' + (step % 30)), k.nn('tag'), null), add: [k.f.quad(k.nn('i' + (step % 30)), k.nn('tag'), k.f.literal('t' + step))] })
      await k.persistence.flush()
    }
    // A fresh store restored from the same storage holds what the graph holds now.
    const now = (s: typeof k.store) =>
      s
        .construct(`CONSTRUCT { ?i <${X}score> ?s ; <${X}tag> ?t } WHERE { { ?i <${X}score> ?s } UNION { ?i <${X}tag> ?t } }`, [s.factory.defaultGraph()])
        .map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`)
        .sort()
    const fresh = loadStore('oxigraph', turtle(0).replace(/^x:list.*$/gm, ''))
    const p2 = new Persistence(fresh, k.backends, { delayMs: 60_000 })
    await p2.restore()
    expect(now(fresh)).toEqual(now(k.store))
    // Fifty writes, but the chunks were compacted into the base whenever they outgrew it.
    const head = JSON.parse((await k.backends[PER + 'Session']!.get('semblance:' + X + 'remember'))!)
    expect(head.chunks ?? 0).toBeLessThan(20)
  })
})
