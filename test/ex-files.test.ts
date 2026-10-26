// The file explorer example (demo/gallery/_ex-files.ttl): a tree and a trail over folders, a grid of
// the folder's files that drags onto the tree, and folders that accept by SHACL - through events only.
import { describe, expect, it } from 'vitest'
import { fakeLayout } from './drag-layout.ts'
import { mountSite } from './harness.ts'
import { implementationGaps } from './implementations.ts'
import { sameHtml } from './same-html.ts'

const UI = 'https://semblance.dev/demo#'
const FX = 'https://semblance.dev/demo/files#'

function explorer(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountSite('oxigraph', prefer)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  click([...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Examples' && visible(b))!)
  click([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === 'File explorer' && visible(b))!)
  const root = () => h.shell.nodeOf(UI + 'ex-files/~root') as HTMLElement
  const folder = (name: string) => [...root().querySelectorAll('[role=treeitem] .sem-label')].find((x) => x.textContent === name) as HTMLElement
  // The name column (the first is the preview).
  const rows = () => [...root().querySelectorAll('[data-sem-c=grid-row]')].map((r) => r.querySelectorAll('td')[1]!.textContent)
  const crumbs = () => [...root().querySelectorAll('[data-sem-c=breadcrumbs] li')].map((li) => li.textContent!.replace(/\/$/, ''))
  const contains = (f: string) => h.store.match(h.store.factory.namedNode(FX + f), h.store.factory.namedNode(FX + 'contains'), null).map((q) => q.object.value.slice(FX.length)).sort()
  const toasts = () => [...h.document.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent).join(' | ')
  return { ...h, root, click, folder, rows, crumbs, contains, toasts }
}

function dragging(prefer: 'sparql' | 'function' = 'sparql') {
  const h = explorer(prefer)
  const { pointer } = fakeLayout(h, { width: 300, row: 60 })
  const zones = () => [...h.root().querySelectorAll('[data-sem-drop-zone]')] as HTMLElement[]
  const zone = (f: string) => zones().findIndex((z) => z.getAttribute('data-sem-drop-zone') === FX + f)
  /** Drag the row of `name` over folder `f`; what each folder says while it is there; then let go. */
  const drag = (name: string, f: string) => {
    const row = ([...h.root().querySelectorAll('[data-sem-drag]')] as HTMLElement[]).find((r) => r.textContent!.includes(name))!
    const z = zone(f)
    pointer(row, 'pointerdown', 20, 20)
    pointer(h.document, 'pointermove', 30, 30)
    pointer(h.document, 'pointermove', z * 300 + 140, 110)
    h.shell.flush()
    const said = Object.fromEntries(zones().map((x) => [x.getAttribute('data-sem-drop-zone')!.slice(FX.length), x.getAttribute('data-sem-drop-reason') ?? x.getAttribute('data-sem-drop')]))
    pointer(h.document, 'pointerup', z * 300 + 140, 110)
    h.shell.flush()
    return said
  }
  return { ...h, drag }
}

describe('the file explorer example', () => {
  it.each(['sparql', 'function'] as const)("shows a folder's files from the tree or the trail, sorted and filtered (%s)", (prefer) => {
    const h = explorer(prefer)
    expect([...h.root().querySelectorAll('[role=treeitem] .sem-label')].map((x) => x.textContent)).toEqual(['Home', 'Archive', 'Documents', 'Projects', 'Photos'])
    expect(h.crumbs()).toEqual(['Home', 'Documents'])
    expect(h.rows()).toEqual(['Quarterly report.pdf', 'Budget 2027.xlsx', 'Meeting notes.txt', 'Signed contract.jpg', 'Conference talk.mp4'])
    h.click(h.folder('Photos'))
    expect(h.rows()).toEqual(['Beach.jpg', 'Harbour at dusk.jpg'])
    expect(h.crumbs()).toEqual(['Home', 'Photos'])
    // Back through the trail.
    h.click(h.folder('Projects'))
    expect(h.crumbs()).toEqual(['Home', 'Documents', 'Projects'])
    h.click([...h.root().querySelectorAll('[data-sem-c=breadcrumbs] button, [data-sem-c=breadcrumbs] a')].find((b) => b.textContent === 'Documents')!)
    expect(h.rows()).toHaveLength(5)
    // Sorted by size (the header), filtered by name (the search field).
    h.click([...h.root().querySelectorAll('[data-sem-c=data-grid] th button')].find((b) => b.textContent!.startsWith('Size'))!)
    expect(h.rows()).toEqual(['Meeting notes.txt', 'Budget 2027.xlsx', 'Quarterly report.pdf', 'Signed contract.jpg', 'Conference talk.mp4'])
    const search = h.root().querySelector('[data-sem-c=search-field] input') as HTMLInputElement
    search.value = 'con'
    h.fire(search, 'input')
    h.shell.flush()
    expect(h.rows().sort()).toEqual(['Conference talk.mp4', 'Signed contract.jpg'])
  })

  it.each(['sparql', 'function'] as const)("shows the selected file's details (%s)", (prefer) => {
    const h = explorer(prefer)
    h.click([...h.root().querySelectorAll('[data-sem-c=grid-row]')].find((r) => r.textContent!.includes('Meeting notes'))!)
    const details = h.shell.nodeOf(UI + 'fx-summary/~root') as HTMLElement
    expect(details.textContent).toContain('Meeting notes.txt')
    expect(details.textContent).toContain('Ada')
    expect((h.shell.nodeOf(UI + 'fx-excerpt/~root') as HTMLElement).textContent).toContain('ship the walkthroughs first')
    // Nothing is kept of it in this browser: no picture.
    expect((h.shell.nodeOf(UI + 'fx-thumb/~root') as HTMLElement).hasAttribute('hidden')).toBe(true)
  })

  it.each(['sparql', 'function'] as const)('moves files by dragging rows onto folders, which accept by their shapes (%s)', (prefer) => {
    const h = dragging(prefer)
    // Rows are draggables carrying their files; the tree's folders are zones.
    expect(h.root().querySelectorAll('[data-sem-c=data-grid] [data-sem-drag]')).toHaveLength(5)
    // A video is too big for the archive, and not an image for Photos.
    const said = h.drag('Conference talk', 'archive')
    expect(said.archive).toBe('The archive takes files up to 10 MB.')
    expect(said.photos).toBe('Photos takes images only.')
    expect(said.projects).toBe('accepts')
    expect(h.contains('archive')).toEqual(['old'])
    expect(h.toasts()).toContain('The archive takes files up to 10 MB.')
    // An image goes to Photos.
    h.drag('Signed contract', 'photos')
    expect(h.contains('photos')).toEqual(['beach', 'harbour', 'scan'])
    expect(h.contains('documents')).not.toContain('scan')
    expect(h.rows()).not.toContain('Signed contract.jpg')
    // Projects holds four at most: a fourth fits, a fifth does not.
    h.drag('Meeting notes', 'projects')
    expect(h.contains('projects')).toHaveLength(4)
    expect(h.drag('Quarterly report', 'projects').projects).toBe('Projects holds four files at most.')
    expect(h.contains('projects')).toHaveLength(4)
  })

  it('renders the same with SPARQL rules as with functions, and the drop layer has both', () => {
    expect(implementationGaps(['layers/dragdrop.ttl'])).toEqual({ noSparql: [], noFunction: [] })
    const [a, b] = (['sparql', 'function'] as const).map((prefer) => {
      const h = dragging(prefer)
      const html = [h.root().outerHTML]
      h.drag('Signed contract', 'photos')
      h.click(h.folder('Photos'))
      html.push(h.root().outerHTML)
      return html
    })
    a!.forEach((html, i) => sameHtml(html, b![i]!, `state ${i}`))
  })
})
