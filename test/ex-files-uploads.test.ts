// The file explorer's own files (demo/gallery/_ex-files.ttl, #58): files picked into the folder shown
// or dropped on a folder in the tree, kept in the browser's file store (a memory stand-in here) up to
// a cap that is SHACL, image previews, opening, deleting, and a reload - through events, as a person
// would, with the DOM and the graph checked, and the SPARQL rules and their twins rendering the same.
import { describe, expect, it } from 'vitest'
import { type KeptFile, memoryFileStore } from '../src/file-store.ts'
import type { FileLike } from '../src/files.ts'
import { FILE, FILES_GRAPH, NS } from '../src/ns.ts'
import { memoryBackend } from '../src/persistence.ts'
import { mountSiteKeeping } from './harness.ts'
import { implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const FX = 'https://semblance.dev/demo/files#'
type Prefer = 'sparql' | 'function'

const file = (name: string, type: string, size: number): FileLike => ({ name, type, size, lastModified: Date.UTC(2026, 9, 24, 12) })

/** The site with its own database and file store (pass the same ones again: a reload), the explorer shown. */
async function explorer(prefer: Prefer = 'sparql', backends = { [NS.per + 'Database']: memoryBackend(), [NS.per + 'Session']: memoryBackend(), [NS.per + 'Device']: memoryBackend() }, kept = memoryFileStore()) {
  const h = await mountSiteKeeping(backends, kept, prefer)
  const f = h.store.factory
  const nn = (iri: string) => f.namedNode(iri)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  click([...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Examples' && visible(b))!)
  click([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === 'File explorer' && visible(b))!)
  const root = () => h.shell.nodeOf(UI + 'ex-files/~root') as HTMLElement
  const folder = (name: string) => [...root().querySelectorAll('[role=treeitem] .sem-label')].find((x) => x.textContent === name) as HTMLElement
  const zoneOf = (folderIri: string) => root().querySelector(`[data-sem-c=tree] [data-sem-drop-zone="${folderIri}"]`) as HTMLElement
  const gridRows = () => [...root().querySelectorAll('[data-sem-c=grid-row]')] as HTMLElement[]
  const rows = () => gridRows().map((r) => r.querySelectorAll('td')[1]!.textContent)
  const row = (name: string) => gridRows().find((r) => r.querySelectorAll('td')[1]!.textContent === name)!
  const contains = (folder: string) => h.store.match(nn(FX + folder), nn(FX + 'contains'), null, f.defaultGraph()).map((q) => q.object.value)
  const named = (name: string) => h.store.match(null, nn(FILE.name), f.literal(name), f.defaultGraph())[0]?.subject.value
  const about = (node: string, p: string, g: import('@rdfjs/types').Quad_Graph = f.defaultGraph()) => h.store.match(nn(node), nn(p), null, g).map((q) => q.object.value)
  const usage = () => ({
    bytes: Number(about(FX + 'store', FILE.usedBytes, nn(FILES_GRAPH))[0] ?? 0),
    files: Number(about(FX + 'store', FILE.usedFiles, nn(FILES_GRAPH))[0] ?? 0),
  })
  const toasts = () => [...h.document.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent).join(' | ')
  const addZone = () => root().querySelector('[data-sem-c=file-drop] .sem-zone') as HTMLButtonElement
  const added = () =>
    [...root().querySelectorAll('[data-sem-c=file-drop] .sem-files > li')].map((li) =>
      [li.getAttribute('data-sem-file-state'), li.querySelector('.sem-name')?.textContent, li.querySelector('.sem-reason')?.textContent ?? ''].join(' | ').replace(/ \| $/, ''),
    )
  /** Choose files through the "Add files" zone. */
  const pick = async (files: FileLike[]) => {
    h.picker.next = files
    click(addZone())
    await h.files.settled()
    h.shell.flush()
  }
  /** Files dragged from outside the page onto a folder's row in the tree, and dropped there: what the folder said, before the drop. */
  const dropOn = async (folderIri: string, files: FileLike[]) => {
    const zone = zoneOf(folderIri)
    const ev = (type: string) => {
      const e = new h.window.Event(type, { bubbles: true, cancelable: true })
      Object.assign(e, { dataTransfer: { types: ['Files'], items: files.map((x) => ({ kind: 'file', type: x.type })), files, dropEffect: 'none' } })
      zone.dispatchEvent(e)
      h.shell.flush()
    }
    ev('dragenter')
    ev('dragover')
    const said = zoneOf(folderIri).getAttribute('data-sem-drop-reason') ?? zoneOf(folderIri).getAttribute('data-sem-drop')
    ev('drop')
    await h.files.settled()
    h.shell.flush()
    return said
  }
  return { ...h, f, nn, root, click, folder, zoneOf, rows, row, contains, named, about, usage, toasts, addZone, added, pick, dropOn, kept }
}

describe("the file explorer's own files", () => {
  it.each(['sparql', 'function'] as const)('takes files into the folder shown, keeps them in the browser, and shows previews of images (%s)', async (prefer) => {
    const h = await explorer(prefer)
    expect(h.usage()).toEqual({ bytes: 0, files: 0 })
    await h.pick([file('Sunset.png', 'image/png', 120_000), file('Plan.md', 'text/markdown', 900)])
    // Into Documents, the folder shown, as members of it; listed by the drop as saved.
    const sunset = h.named('Sunset.png')!
    const plan = h.named('Plan.md')!
    expect(h.contains('documents')).toEqual(expect.arrayContaining([sunset, plan]))
    expect(h.rows()).toEqual(expect.arrayContaining(['Sunset.png', 'Plan.md']))
    expect(h.added()).toEqual(['saved | Sunset.png', 'saved | Plan.md'])
    // Kept: the store has their bytes (and a preview of the image), the graph only says where.
    expect(h.about(sunset, FILE.keptIn)).toEqual([FX + 'store'])
    expect([...h.kept.files.values()].map((k: KeptFile) => [k.name, k.size, k.store, !!k.preview])).toEqual([
      ['Sunset.png', 120_000, FX + 'store', true],
      ['Plan.md', 900, FX + 'store', false],
    ])
    expect(h.usage()).toEqual({ bytes: 120_900, files: 2 })
    // The image's preview is in the files graph, never in the default graph, and the grid shows it.
    const preview = h.about(sunset, FILE.preview, h.nn(FILES_GRAPH))[0]!
    expect(preview).toMatch(/^blob:test\//)
    expect(h.about(sunset, FILE.preview)).toEqual([])
    expect(h.row('Sunset.png').querySelector('img.sem-cell-image')!.getAttribute('src')).toBe(preview)
    expect(h.row('Plan.md').querySelector('img')).toBeNull()
    // Selected, the details show it too; "Open" shows the image itself (file:url) in a dialog.
    h.click(h.row('Sunset.png'))
    const thumb = h.shell.nodeOf(UI + 'fx-thumb/~root') as HTMLElement
    expect(thumb.querySelector('img')!.getAttribute('src')).toBe(preview)
    expect(thumb.querySelector('img')!.getAttribute('alt')).toBe('Sunset.png')
    h.click(h.shell.nodeOf(UI + 'fx-open/~root') as HTMLElement)
    const full = h.shell.nodeOf(UI + 'fx-full/~root') as HTMLElement
    expect(full.querySelector('img')!.getAttribute('src')).toBe(h.about(sunset, FILE.url, h.nn(FILES_GRAPH))[0])
    expect(full.closest('[hidden]')).toBeNull()
  })

  it.each(['sparql', 'function'] as const)("takes files dropped on a folder in the tree, by that folder's shapes (%s)", async (prefer) => {
    const h = await explorer(prefer)
    // Photos takes images only: said while they are over it (by their media types), and on the drop.
    expect(await h.dropOn(FX + 'photos', [file('Notes.txt', 'text/plain', 300)])).toBe('Photos takes images only.')
    expect(h.toasts()).toContain('Photos takes images only.')
    expect(h.contains('photos')).toHaveLength(2)
    expect(await h.dropOn(FX + 'photos', [file('Dune.jpg', 'image/jpeg', 50_000)])).toBe('accepts')
    const dune = h.named('Dune.jpg')!
    expect(h.contains('photos')).toContain(dune)
    expect(h.about(dune, FILE.state)).toEqual([FILE.Saved])
    expect(h.usage()).toEqual({ bytes: 50_000, files: 1 })
    // The archive's size limit decides once the file's size is known: refused on arrival, forgotten
    // (the tree lists nothing), announced.
    await h.dropOn(FX + 'archive', [file('Backup.zip', 'application/zip', 12_000_000)])
    expect(h.toasts()).toContain('The archive takes files up to 10 MB.')
    expect(h.named('Backup.zip')).toBeUndefined()
    expect(h.kept.files.size).toBe(1)
    // Shown in Photos.
    h.click(h.folder('Photos'))
    expect(h.rows()).toEqual(['Beach.jpg', 'Harbour at dusk.jpg', 'Dune.jpg'])
  })

  it.each(['sparql', 'function'] as const)("refuses what would take the store past its cap, with the cap's message, and keeps everything else (%s)", async (prefer) => {
    const h = await explorer(prefer)
    await h.pick([file('Film.mov', 'video/quicktime', 20_000_000), file('Talk.mov', 'video/quicktime', 6_000_000), file('Small.txt', 'text/plain', 100)])
    // The first fits; the second would pass 25 MB; the third still fits.
    expect(h.added()).toEqual(['saved | Film.mov', 'refused | Talk.mov | The explorer keeps up to 25 MB of files in this browser.', 'saved | Small.txt'])
    expect(h.toasts()).toContain('The explorer keeps up to 25 MB of files in this browser.')
    expect(h.usage()).toEqual({ bytes: 20_000_100, files: 2 })
    expect([...h.kept.files.values()].map((k) => k.name)).toEqual(['Film.mov', 'Small.txt'])
    // Nothing kept is thrown away: deleting one makes room.
    h.click(h.row('Film.mov'))
    h.click(h.shell.nodeOf(UI + 'fx-delete/~root') as HTMLElement)
    await h.files.settled()
    expect(h.usage()).toEqual({ bytes: 100, files: 1 })
    await h.pick([file('Talk.mov', 'video/quicktime', 6_000_000)])
    expect(h.added().at(-1)).toBe('saved | Talk.mov')
  })

  it.each(['sparql', 'function'] as const)('deleting a file frees its bytes and its addresses (%s)', async (prefer) => {
    const h = await explorer(prefer)
    await h.pick([file('Sunset.png', 'image/png', 120_000)])
    const sunset = h.named('Sunset.png')!
    const addresses = [...h.about(sunset, FILE.url, h.nn(FILES_GRAPH)), ...h.about(sunset, FILE.preview, h.nn(FILES_GRAPH))]
    expect(addresses).toHaveLength(2)
    h.click(h.row('Sunset.png'))
    h.click(h.shell.nodeOf(UI + 'fx-delete/~root') as HTMLElement)
    await h.files.settled()
    h.shell.flush()
    expect(h.rows()).not.toContain('Sunset.png')
    expect(h.store.match(h.nn(sunset), null, null).length).toBe(0)
    expect(h.store.match(null, null, h.nn(sunset)).length).toBe(0)
    expect(h.kept.files.size).toBe(0)
    expect(h.urls.revoked.sort()).toEqual(addresses.sort())
    expect(h.usage()).toEqual({ bytes: 0, files: 0 })
    expect(h.toasts()).toContain('Deleted')
  })

  it.each(['sparql', 'function'] as const)('the files are still there after a reload, with their previews (%s)', async (prefer) => {
    const backends = { [NS.per + 'Database']: memoryBackend(), [NS.per + 'Session']: memoryBackend(), [NS.per + 'Device']: memoryBackend() }
    const kept = memoryFileStore()
    const first = await explorer(prefer, backends, kept)
    await first.pick([file('Sunset.png', 'image/png', 120_000)])
    await first.dropOn(FX + 'photos', [file('Dune.jpg', 'image/jpeg', 50_000)])
    await first.persistence.flush()
    // A file kept, but never remembered (the page closed first): freed at the next load.
    await kept.put('stray', { store: FX + 'store', name: 'Stray.png', type: 'image/png', size: 10, contents: file('Stray.png', 'image/png', 10) })

    const h = await explorer(prefer, backends, kept)
    const sunset = h.named('Sunset.png')!
    expect(h.contains('documents')).toContain(sunset)
    expect(h.rows()).toContain('Sunset.png')
    expect(h.usage()).toEqual({ bytes: 170_000, files: 2 })
    expect([...kept.files.keys()]).not.toContain('stray')
    const preview = h.about(sunset, FILE.preview, h.nn(FILES_GRAPH))[0]!
    expect(h.row('Sunset.png').querySelector('img.sem-cell-image')!.getAttribute('src')).toBe(preview)
    // Its contents come back from the store.
    expect((await h.files.contentsOf(sunset))?.size).toBe(120_000)
    h.click(h.folder('Photos'))
    expect(h.rows()).toContain('Dune.jpg')
  })

  it('renders the same with SPARQL rules as with functions, and the files layer and the new views have both', async () => {
    expect(implementationGaps(['layers/files.ttl'])).toEqual({ noSparql: [], noFunction: [] })
    const html: string[][] = []
    for (const prefer of ['sparql', 'function'] as const) {
      const h = await explorer(prefer)
      const states = [h.root().outerHTML]
      await h.pick([file('Sunset.png', 'image/png', 120_000), file('Film.mov', 'video/quicktime', 30_000_000)])
      states.push(h.root().outerHTML)
      h.click(h.row('Sunset.png'))
      states.push(h.root().outerHTML)
      await h.dropOn(FX + 'photos', [file('Dune.jpg', 'image/jpeg', 50_000)])
      h.click(h.folder('Photos'))
      states.push(h.root().outerHTML)
      html.push(states)
    }
    html[0]!.forEach((x, i) => expect(x, `state ${i}`).toBe(html[1]![i]))
  })

  it('adding a file costs the same however many files the store keeps', async () => {
    const h = await explorer('sparql')
    const runs = async (name: string) => {
      const before = h.screen.engine.stats.ruleRuns
      await h.pick([file(name, 'text/plain', 10)])
      return h.screen.engine.stats.ruleRuns - before
    }
    await runs('warm.txt')
    const few = await runs('a.txt')
    // Twenty more kept, in another folder.
    h.click(h.folder('Archive'))
    for (let i = 0; i < 20; i++) await h.pick([file(`more-${i}.txt`, 'text/plain', 10)])
    h.click(h.folder('Documents'))
    await runs('warm2.txt')
    const many = await runs('b.txt')
    expect(h.usage().files).toBe(24)
    expect(many).toBe(few)
  })
})
