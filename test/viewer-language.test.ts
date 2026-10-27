import { describe, expect, it } from 'vitest'
import type { GraphStore } from '../src/store/types.ts'
import { NS } from '../src/ns.ts'
import { mountShellPrepared } from './harness.ts'

// Every text a rendering shows is in the viewer's language (#36), on SPARQL and function rules
// alike. Each translatable text of the demo becomes a marker per language - the untagged
// "«xx:Name»" and "«uk:Name»"@uk, "«de:Name»"@de, … - and every gallery group is shown in each
// viewer language: what is shown carries only that language's markers, and both rule kinds render
// the same. (The parity tests render without a language set, where the untagged text is right
// for both, so a rule that read a text raw passed them.)

const UI = 'https://semblance.dev/demo#'
const LANGS = ['en', 'uk', 'de', 'ar']
const TEXTS = [
  NS.c + 'label', NS.rdfs + 'label', NS.sh + 'message', NS.sh + 'name', NS.sh + 'description', NS.ann + 'announces',
  ...['help', 'placeholder', 'title', 'note', 'badge', 'emptyText', 'caption', 'alt', 'attribution', 'trigger', 'unit', 'moreLabel', 'countLabel', 'pausedLabel', 'externalHint', 'splitLabel', 'subtitle'].map((p) => NS.c + p),
]
// Every group in a language that is not English and one written right to left; the groups densest
// in texts in the other two (the same code paths: a sweep takes minutes).
const SWEEP: Record<string, string[] | 'all'> = { uk: 'all', ar: 'all', en: ['GroupInputs', 'GroupFeedback', 'GroupData'], de: ['GroupInputs', 'GroupFeedback', 'GroupData'] }
// Views that show the graph's data as it is (every literal, in every language: an RDF editor's
// terms among them), and a Gantt chart's tasks, named by a query's rows (here, every marked
// variant of a label is a row).
const AS_DATA = ['triples-view', 'query-view', 'element-markup', 'result-table', 'result-turtle', 'rdf-term', 'gantt-task']

function markerize(store: GraphStore) {
  const f = store.factory
  for (const p of TEXTS) {
    const bySubject = new Map<string, ReturnType<typeof store.match>>()
    for (const q of store.match(null, f.namedNode(p), null)) {
      if (q.object.termType !== 'Literal' || q.subject.termType !== 'NamedNode') continue
      const k = q.subject.value + ' ' + q.graph.value
      bySubject.set(k, [...(bySubject.get(k) ?? []), q])
    }
    for (const qs of bySubject.values()) {
      const lang = (q: (typeof qs)[0]) => (q.object as { language?: string }).language ?? ''
      const base = (qs.find((q) => !lang(q)) ?? qs.find((q) => lang(q) === 'en') ?? qs[0]!).object.value
      if (!/[A-Za-z]/.test(base)) continue
      const { subject, predicate, graph } = qs[0]!
      for (const q of qs) store.delete(q)
      store.add(f.quad(subject, predicate, f.literal(`«xx:${base}»`), graph))
      for (const l of LANGS) store.add(f.quad(subject, predicate, f.literal(`«${l}:${base}»`, l), graph))
    }
  }
}

/** What is shown: the app without hidden subtrees and views of raw data. */
function shown(document: Document): string {
  const app = document.getElementById('app')!.cloneNode(true) as Element
  for (const el of [...app.querySelectorAll('[hidden]'), ...AS_DATA.flatMap((c) => [...app.querySelectorAll(`[data-sem-c="${c}"]`)])]) el.remove()
  return app.innerHTML
}

describe('texts in the viewer\'s language', () => {
  for (const viewer of LANGS) {
    const sweep = SWEEP[viewer]!
    it(`${sweep === 'all' ? 'every gallery group' : sweep.join(', ')} in ${viewer} shows only ${viewer}, SPARQL and functions alike`, () => {
      const shells = (['sparql', 'function'] as const).map((prefer) => mountShellPrepared(markerize, prefer))
      const f = shells[0]!.store.factory
      const groups = shells[0]!.store.match(null, f.namedNode(NS.rdf + 'type'), f.namedNode(UI + 'GalleryGroup')).map((q) => q.subject.value).filter((g) => sweep === 'all' || sweep.includes(g.replace(UI, ''))).sort()
      expect(groups.length).toBeGreaterThanOrEqual(sweep === 'all' ? 6 : sweep.length)
      for (const h of shells) h.showPage('Components'), h.screen.engine.reconfigure({ languages: [viewer] }), h.shell.flush()
      const leaks: string[] = []
      for (const group of groups) {
        const html = shells.map((h) => {
          const g = h.store.factory
          h.runtime.apply({ remove: h.store.match(g.namedNode(UI + 'app'), g.namedNode(UI + 'galleryGroup'), null), add: [g.quad(g.namedNode(UI + 'app'), g.namedNode(UI + 'galleryGroup'), g.namedNode(group))] })
          h.shell.flush()
          return shown(h.document)
        })
        html.forEach((text, i) => {
          for (const m of text.matchAll(/«(xx|en|uk|de|ar):([^»]{0,40})/g)) {
            if (m[1] === viewer) continue
            const at = text.lastIndexOf('data-sem-c="', m.index)
            leaks.push(`${i ? 'function' : 'sparql'} ${group.replace(UI, '')} ${text.slice(at + 12, text.indexOf('"', at + 12))}: «${m[1]}:${m[2]}»`)
          }
        })
        if (html[0] !== html[1]) {
          let i = 0
          while (html[0]![i] === html[1]![i]) i++
          expect(html[0]!.slice(Math.max(0, i - 300), i + 300), `${group}: SPARQL and function renderings differ`).toBe(html[1]!.slice(Math.max(0, i - 300), i + 300))
        }
      }
      expect([...new Set(leaks)]).toEqual([])
    }, 600_000)
  }
})
