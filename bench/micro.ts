// Per-operation costs of the primitives the engine is built on.
import { QueryEngine } from '@comunica/query-sparql-rdfjs'
import { Store as N3Store, DataFactory as D } from 'n3'
import * as ox from 'oxigraph'

export interface MicroRow {
  op: string
  us: number
}

function time(op: string, n: number, fn: (i: number) => void): MicroRow {
  for (let i = 0; i < Math.min(n, 200); i++) fn(i)
  const t = performance.now()
  for (let i = 0; i < n; i++) fn(i)
  return { op, us: ((performance.now() - t) / n) * 1000 }
}

async function timeAsync(op: string, n: number, fn: (i: number) => Promise<void>): Promise<MicroRow> {
  for (let i = 0; i < 20; i++) await fn(i)
  const t = performance.now()
  for (let i = 0; i < n; i++) await fn(i)
  return { op, us: ((performance.now() - t) / n) * 1000 }
}

export async function runMicro(): Promise<MicroRow[]> {
  const N = 2_000
  const oxs = new ox.Store()
  const n3 = new N3Store()
  for (let i = 0; i < N; i++) {
    const s = `urn:s${i}`
    oxs.add(ox.quad(ox.namedNode(s), ox.namedNode('urn:p'), ox.literal(`v${i}`)))
    oxs.add(ox.quad(ox.namedNode(s), ox.namedNode('urn:q'), ox.namedNode(`urn:s${(i + 1) % N}`)))
    n3.addQuad(D.quad(D.namedNode(s), D.namedNode('urn:p'), D.literal(`v${i}`)))
    n3.addQuad(D.quad(D.namedNode(s), D.namedNode('urn:q'), D.namedNode(`urn:s${(i + 1) % N}`)))
  }
  const q = (i: number) => `CONSTRUCT { ?x <urn:r> ?v } WHERE { <urn:s${i % N}> <urn:q> ?n . ?n <urn:p> ?v . BIND(IRI(CONCAT(STR(?n), "/~x")) AS ?x) }`
  const comunica = new QueryEngine()
  const p = ox.namedNode('urn:p')
  const p3 = D.namedNode('urn:p')
  const g = ox.namedNode('urn:g')
  return [
    time('oxigraph: CONSTRUCT, 2-pattern join, focus bound', 5_000, (i) => void oxs.query(q(i))),
    time('oxigraph: CONSTRUCT, same, all 2k foci (per focus)', 20, () => void oxs.query(q(0).replace('<urn:s0>', '?s'))),
    time('oxigraph: match(s, p, ?)', 50_000, (i) => void oxs.match(ox.namedNode(`urn:s${i % N}`), p, null)),
    time('oxigraph: add + delete quad', 50_000, (i) => {
      const quad = ox.quad(ox.namedNode(`urn:t${i}`), p, ox.literal('x'), g)
      oxs.add(quad)
      oxs.delete(quad)
    }),
    time('oxigraph: read term .value (s, p, o)', 50_000, () => {
      const [quad] = oxs.match(ox.namedNode('urn:s1'), p, null)
      void (quad!.subject.value + quad!.predicate.value + quad!.object.value)
    }),
    time('n3: getQuads(s, p, ?)', 200_000, (i) => void n3.getQuads(D.namedNode(`urn:s${i % N}`), p3, null, null)),
    time('n3: add + remove quad', 200_000, (i) => {
      const quad = D.quad(D.namedNode(`urn:t${i}`), p3, D.literal('x'), D.namedNode('urn:g'))
      n3.addQuad(quad)
      n3.removeQuad(quad)
    }),
    await timeAsync('comunica over n3: CONSTRUCT, focus bound', 200, async (i) => {
      await (await comunica.queryQuads(q(i), { sources: [n3] })).toArray()
    }),
  ]
}
