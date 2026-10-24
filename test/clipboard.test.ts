// Copying to the clipboard (ontology/layers/clipboard.ttl, src/clipboard.ts), and the result
// table's Markdown (c:ResultTableMarkdown in workbench.ttl) that the Query tool copies.
import { describe, expect, it } from 'vitest'
import { ManualClock } from '../src/behaviour/clock.ts'
import type { StoreKind } from '../src/node/load.ts'
import { CLIP, NS, RDF_TYPE } from '../src/ns.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const C = NS.c
type Shell = ReturnType<typeof mountShell>

/** The Playground's Query tab, on a clock the test moves. */
function workbench(kind: StoreKind = 'oxigraph', prefer: 'sparql' | 'function' = 'sparql') {
  const clock = new ManualClock()
  const h = mountShell(5, kind, prefer, clock)
  h.fire(
    [...h.document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Query')!,
    'click',
  )
  return { ...h, clock }
}

const nn = (h: Shell, iri: string) => h.store.factory.namedNode(iri)
const objects = (h: Shell, s: string, p: string) => h.store.match(nn(h, s), nn(h, p), null).map((q) => q.object)
const markdown = (h: Shell) => objects(h, UI + 'queryTable/~root', C + 'markdown')[0]?.value
const copier = (h: Shell) => h.document.querySelector('[data-sem-c=result-table] .sem-result-bar .sem-actions button') as HTMLElement
const toasts = (h: Shell) => [...h.document.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent).join(' | ')

/** Type a query into the editor and run it. */
function runQuery(h: Shell, query: string) {
  const ta = h.document.querySelector('[data-sem-c=query-editor] textarea') as HTMLTextAreaElement
  ta.value = query
  h.fire(ta, 'input')
  h.fire(h.document.querySelector('[data-sem-c=query-workbench] .sem-toolbar button')!, 'click')
}

// IRIs with and without a declared prefix, a literal with a pipe and line breaks, language tags,
// an empty literal, a number and an unbound column.
const QUERY = `SELECT ?x ?label ?n ?missing WHERE {
  VALUES (?x ?label ?n) { (c:Button "a|b\\nc\\r\\nd"@en 3) (<https://example.org/x/y#1z> "plain" 2.5) (ui:queryTable "Таблиця"@uk 1) (sem:x-y "" 0) }
  OPTIONAL { ?x c:nope ?missing }
} ORDER BY ?n`
const EXPECTED = [
  '| ?x | ?label | ?n | ?missing |',
  '| --- | --- | --- | --- |',
  '| `sem:x-y` |  | 0 |  |',
  '| `ui:queryTable` | Таблиця@uk | 1 |  |',
  '| `<https://example.org/x/y#1z>` | plain | 2.5 |  |',
  '| `c:Button` | a&#124;b<br>c<br>d@en | 3 |  |',
].join('\n')

describe('a result table as Markdown (c:markdown)', () => {
  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`header, separator, escaped cells and prefixed names, SPARQL and function alike (${kind})`, () => {
      const [sparql, fn] = (['sparql', 'function'] as const).map((prefer) => {
        const h = workbench(kind, prefer)
        // The first sample, as it opened: one line per row shown.
        const first = markdown(h)!.split('\n')
        expect(first.slice(0, 2)).toEqual(['| ?component | ?renderings | ?rules |', '| --- | --- | --- |'])
        expect(first.length).toBe(2 + h.document.querySelectorAll('[data-sem-c=result-table] tbody tr').length)
        expect(first[2]).toMatch(/^\| `c:\w+` \| \d+ \| \d+ \|$/)
        runQuery(h, QUERY)
        return { h, first: first.join('\n'), md: markdown(h) }
      })
      expect(sparql!.md).toBe(EXPECTED)
      expect(fn!.md).toBe(sparql!.md)
      expect(fn!.first).toBe(sparql!.first)
      // The HTML is the same too (the marks' data is not markup).
      expect(fn!.h.document.querySelector('[data-sem-c=result-table]')!.outerHTML).toBe(sparql!.h.document.querySelector('[data-sem-c=result-table]')!.outerHTML)
    })
  }

  it('a blank node is shown by its label, as the table shows it', () => {
    const h = workbench()
    runQuery(h, 'SELECT ?d WHERE { <https://semblance.dev/ns/core> sh:declare ?d } LIMIT 2')
    const labels = [...h.document.querySelectorAll('[data-sem-c=result-table] tbody td code')].map((c) => c.textContent)
    expect(labels).toHaveLength(2)
    expect(markdown(h)!.split('\n').slice(2)).toEqual(labels.map((l) => `| \`${l}\` |`))
  })
})

describe('copying (clip:Copier, the clipboard effect)', () => {
  for (const [kind, prefer] of [
    ['oxigraph', 'sparql'],
    ['oxigraph', 'function'],
    ['wat', 'sparql'],
  ] as const)
    it(`a click records a request with the text; the effect writes it, and the copier and a toast say so (${kind}, ${prefer})`, async () => {
      const h = workbench(kind, prefer)
      const button = copier(h)
      expect(button.getAttribute('aria-label')).toBe('Copy as Markdown')
      expect(button.textContent).toBe('⧉')
      const text = markdown(h)!
      h.fire(button, 'click')
      // The request is graph state: its text, who asked, what to say.
      const request = h.store.match(null, nn(h, RDF_TYPE), nn(h, CLIP.Request))[0]!.subject.value
      expect(request).toMatch(new RegExp(`^${UI}queryTableCopy/~copy-\\d+$`))
      expect(objects(h, request, CLIP.text)[0]!.value).toBe(text)
      expect(objects(h, request, CLIP.requestedBy)[0]!.value).toBe(UI + 'queryTableCopy')
      expect(objects(h, request, CLIP.says).map((t) => t.value)).toContain('Copied as Markdown')
      // The write started in the click's task (browsers require the person's activation).
      expect(h.clipboard.text).toBe(text)
      await h.copies.settled()
      // The outcome came back as an event: the request is gone, the copier shows ✓, a toast says it.
      expect(h.store.match(nn(h, request), null, null)).toHaveLength(0)
      expect(objects(h, UI + 'queryTableCopy', CLIP.outcome)[0]!.value).toBe(CLIP.Success)
      expect(copier(h).textContent).toBe('✓')
      expect(toasts(h)).toContain('Copied as Markdown')
      // A moment later it shows its own glyph again.
      h.clock.advance(1600)
      expect(objects(h, UI + 'queryTableCopy', CLIP.outcome)).toHaveLength(0)
      expect(copier(h).textContent).toBe('⧉')
    })

  it('without a clipboard the copy fails, and says so', async () => {
    const h = workbench()
    h.clipboard.available = false
    h.fire(copier(h), 'click')
    await h.copies.settled()
    expect(h.clipboard.text).toBeUndefined()
    expect(objects(h, UI + 'queryTableCopy', CLIP.outcome)[0]!.value).toBe(CLIP.Failure)
    expect(copier(h).textContent).toBe('✕')
    expect(toasts(h)).toContain('Could not copy to the clipboard')
    expect(h.store.match(null, nn(h, RDF_TYPE), nn(h, CLIP.Request))).toHaveLength(0)
  })

  it('copies the query, by keyboard too, with its label in every language', async () => {
    const h = workbench('oxigraph', 'function')
    const query = h.document.querySelector('[data-sem-c=query-workbench] .sem-toolbar [aria-label="Copy the query"]') as HTMLElement
    expect(query.tagName).toBe('BUTTON')
    // A key:shortcut on the copier presses it, as any button's does.
    const f = h.store.factory
    h.runtime.apply({
      remove: [],
      add: [f.quad(nn(h, UI + 'queryCopy'), nn(h, NS.key + 'shortcut'), f.literal('mod+shift+y'))],
    })
    h.shell.flush()
    const e = new h.window.Event('keydown', {
      bubbles: true,
      cancelable: true,
    }) as unknown as KeyboardEvent
    Object.assign(e, {
      key: 'Y',
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
      altKey: false,
    })
    h.document.body.dispatchEvent(e)
    await h.copies.settled()
    expect(h.clipboard.text).toBe(objects(h, UI + 'queryEditor', C + 'value')[0]!.value)
    expect(toasts(h)).toContain('Copied the query')
    for (const lang of ['uk', 'de', 'ar']) expect(objects(h, UI + 'queryCopy', C + 'label').some((l) => l.termType === 'Literal' && l.language === lang)).toBe(true)
  })

  it('a disabled copier copies nothing', () => {
    const h = workbench()
    const f = h.store.factory
    h.runtime.apply({
      remove: [],
      add: [f.quad(nn(h, UI + 'queryTableCopy'), nn(h, C + 'disabled'), f.literal('true', f.namedNode(NS.xsd + 'boolean')))],
    })
    h.shell.flush()
    h.fire(copier(h), 'click')
    expect(h.store.match(null, nn(h, RDF_TYPE), nn(h, CLIP.Request))).toHaveLength(0)
    expect(h.clipboard.text).toBeUndefined()
  })
})
