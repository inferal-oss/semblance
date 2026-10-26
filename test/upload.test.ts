// The file drop (ontology/components/upload.ttl) and the files effect (src/files.ts): the Inputs
// gallery page's drops, driven through DOM events as a person would - the zone clicked, files
// picked (a stand-in picker), dragged over the page and dropped (DataTransfer stand-ins), uploads
// reported by a stand-in handler - with the DOM and the graph checked, and the SPARQL rules and their
// function twins rendering the same HTML after every step.
import { describe, expect, it } from 'vitest'
import type { FileLike } from '../src/files.ts'
import { DND, FILE, MOD, NS } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
type Kind = 'oxigraph' | 'wat'

function inputs(kind: Kind = 'oxigraph', prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountShell(5, kind, prefer)
  h.showPage('Components')
  const { store, runtime } = h
  const f = store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  runtime.apply({ remove: store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupInputs'))] })
  h.shell.flush()
  const root = (id: string) => h.shell.nodeOf(`${UI}${id}/~root`) as HTMLElement
  const zone = (id: string) => root(id).querySelector('.sem-zone') as HTMLButtonElement
  const rows = (id: string) =>
    [...root(id).querySelectorAll('.sem-files > li')].map((li) => [li.getAttribute('data-sem-file-state'), li.querySelector('.sem-name')?.textContent, li.querySelector('.sem-meta')?.textContent].join(' | '))
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const values = (p: string) => store.match(f.namedNode(UI + 'inputsDemo'), f.namedNode(UI + p), null).map((q) => q.object.value)
  const state = (file: string) => store.match(f.namedNode(file), f.namedNode(FILE.state), null)[0]?.object.value.replace(NS.file, 'file:')
  const toasts = () => [...h.document.querySelectorAll('[data-sem-c=toast]')].map((t) => t.textContent)
  const html = (id: string) => root(id).outerHTML
  return { ...h, root, zone, rows, click, values, state, toasts, html }
}

const file = (name: string, type: string, size: number): FileLike => ({ name, type, size, lastModified: Date.UTC(2026, 9, 1) })
type H = ReturnType<typeof inputs>

/** Pick files through a drop's zone: the click asks for the picker, which hands them over. */
async function pick(h: H, id: string, files: FileLike[] | null) {
  h.picker.next = files
  h.click(h.zone(id))
  await h.files.settled()
  h.shell.flush()
}

/** The upload the stand-in handler holds for a drop's file, by its name. */
function upload(h: H, name: string) {
  const u = [...h.uploads.values()].find((x) => x.file.name === name)
  if (!u) throw new Error(`no upload of ${name}`)
  return u
}

/** A drag event with a DataTransfer stand-in carrying files of these media types. */
function dragEvent(h: H, type: string, types: string[], files: FileLike[] = []) {
  const e = new h.window.Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, { dataTransfer: { types: ['Files'], items: types.map((t) => ({ kind: 'file', type: t })), files, dropEffect: 'none' } })
  return e as unknown as DragEvent
}
function drag(h: H, el: Element, type: string, types: string[], files: FileLike[] = []) {
  const e = dragEvent(h, type, types, files)
  el.dispatchEvent(e)
  h.shell.flush()
  return e
}

describe('a file drop', () => {
  it('renders a zone that is a button, described by its help, above an empty list', () => {
    const h = inputs()
    const zone = h.zone('inp-files-attach')
    expect(zone.tagName).toBe('BUTTON')
    expect(zone.getAttribute('type')).toBe('button')
    expect(zone.textContent).toBe('⤒AttachmentsDrop files here, or choose them')
    const help = h.root('inp-files-attach').querySelector('.sem-help')!
    expect(help.textContent).toBe('Images or PDFs, up to 2 MB each; at most three.')
    expect(zone.getAttribute('aria-describedby')).toBe(help.id)
    const list = h.root('inp-files-attach').querySelector('.sem-files')!
    expect(list.getAttribute('aria-label')).toBe('Attachments')
    expect(list.getAttribute('aria-live')).toBe('polite')
    expect(list.children).toHaveLength(0)
    // A drop target of the dnd: layer: its zone receives into the controlled node.
    expect(zone.getAttribute('data-sem-drop-zone')).toBe(UI + 'inputsDemo')
    expect(h.zone('inp-files-picture').textContent).toBe('◐Profile pictureDrop a file here, or choose one')
    expect(h.zone('inp-files-off').disabled).toBe(true)
  })

  for (const kind of ['oxigraph', 'wat'] as const) {
    it(`picks files: each is offered to the zone, added or refused by the shape, and uploaded with progress (${kind})`, async () => {
      const h = inputs(kind)
      await pick(h, 'inp-files-attach', [file('report.pdf', 'application/pdf', 120_000), file('movie.mov', 'video/quicktime', 900_000), file('big.png', 'image/png', 3_000_000)])
      // The picker was asked for what the drop takes, several at once.
      expect(h.picker.asked).toEqual([{ accept: 'image/*,application/pdf', multiple: true }])
      expect(h.rows('inp-files-attach')).toEqual([
        'uploading | report.pdf | 120 kBUploading',
        'refused | movie.mov | 900 kBNot acceptedOnly images and PDFs.',
        'refused | big.png | 3 MBNot acceptedAt most 2 MB per file.',
      ])
      // Only the accepted one is a value of the property; the request was answered.
      const [report] = h.values('inp-attachment')
      expect(h.values('inp-attachment')).toHaveLength(1)
      expect(h.state(report!)).toBe('file:Uploading')
      expect(h.store.match(null, h.store.factory.namedNode(FILE.requestedBy), null)).toEqual([])
      // Refusals are announced with the shape's message.
      expect(h.toasts().filter(Boolean)).toEqual(['!Only images and PDFs.✕', '!At most 2 MB per file.✕'])
      // The contents stay with the effect, under the file's handle.
      expect(h.files.fileOf(report!)?.name).toBe('report.pdf')
      expect(h.store.match(h.store.factory.namedNode(report!), h.store.factory.namedNode(FILE.size), null)[0]?.object.value).toBe('120000')

      // Progress: the bar and its value.
      upload(h, 'report.pdf').ctx.onProgress(30_000)
      h.shell.flush()
      const bar = h.root('inp-files-attach').querySelector('[role=progressbar]')!
      expect(bar.getAttribute('aria-valuenow')).toBe('30000')
      expect(bar.getAttribute('aria-valuemax')).toBe('120000')
      expect(bar.getAttribute('aria-valuetext')).toBe('25%')
      // Done: uploaded, where the server said, announced; no bar.
      upload(h, 'report.pdf').resolve({ location: 'https://files.example.org/report.pdf' })
      await h.files.settled()
      h.shell.flush()
      expect(h.state(report!)).toBe('file:Uploaded')
      expect(h.store.match(h.store.factory.namedNode(report!), h.store.factory.namedNode(FILE.location), null)[0]?.object.value).toBe('https://files.example.org/report.pdf')
      expect(h.rows('inp-files-attach')[0]).toBe('uploaded | report.pdf | 120 kBUploaded')
      expect(h.root('inp-files-attach').querySelector('[role=progressbar]')).toBeNull()
      expect(h.toasts()).toContain('✓File uploaded✕')
    })
  }

  it('fails an upload, and uploads it again; removing an upload cancels it', async () => {
    const h = inputs()
    await pick(h, 'inp-files-attach', [file('a.png', 'image/png', 1000), file('b.pdf', 'application/pdf', 2000)])
    upload(h, 'a.png').reject(new Error('The connection was lost.'))
    await h.files.settled()
    h.shell.flush()
    expect(h.rows('inp-files-attach')[0]).toBe('failed | a.png | 1 kBUpload failedThe connection was lost.')
    expect(h.toasts()).toContain('✕The connection was lost.✕')
    // Try again: a new upload starts.
    h.uploads.clear()
    const retry = h.root('inp-files-attach').querySelector('[aria-label="Upload a.png again"]')!
    h.click(retry)
    await h.files.settled()
    expect(h.rows('inp-files-attach')[0]).toBe('uploading | a.png | 1 kBUploading')
    expect([...h.uploads.values()].map((u) => u.file.name)).toEqual(['a.png'])
    // Cancel b.pdf's upload: the file goes, and the handler is told to stop.
    const b = h.values('inp-attachment').find((f) => h.files.fileOf(f)?.name === 'b.pdf')!
    const cancel = h.root('inp-files-attach').querySelector('[aria-label="Cancel the upload of b.pdf"]')!
    h.click(cancel)
    expect(h.values('inp-attachment')).not.toContain(b)
    expect(h.store.match(h.store.factory.namedNode(b), null, null)).toEqual([])
    expect(h.rows('inp-files-attach').map((r) => r.split(' | ')[1])).toEqual(['a.png'])
    expect(h.toasts().some((t) => t.includes('Upload cancelled'))).toBe(true)
    // Remove a.png's (finished) upload.
    upload(h, 'a.png').resolve()
    await h.files.settled()
    h.shell.flush()
    h.click(h.root('inp-files-attach').querySelector('[aria-label="Remove a.png"]')!)
    expect(h.values('inp-attachment')).toEqual([])
    expect(h.rows('inp-files-attach')).toEqual([])
    expect(h.toasts().some((t) => t.includes('File removed'))).toBe(true)
  })

  it('aborts an upload whose file is removed', async () => {
    const h = inputs()
    await pick(h, 'inp-files-attach', [file('c.pdf', 'application/pdf', 5000)])
    const u = upload(h, 'c.pdf')
    expect(u.ctx.signal.aborted).toBe(false)
    h.click(h.root('inp-files-attach').querySelector('[aria-label="Cancel the upload of c.pdf"]')!)
    expect(u.ctx.signal.aborted).toBe(true)
    // What the handler says afterwards is not heard.
    u.resolve()
    await h.files.settled()
    expect(h.rows('inp-files-attach')).toEqual([])
  })

  it('takes no more than the shape allows: the rest are refused, and a full drop asks for nothing', async () => {
    const h = inputs()
    await pick(h, 'inp-files-attach', ['1', '2', '3', '4'].map((n) => file(`${n}.png`, 'image/png', 100)))
    expect(h.rows('inp-files-attach').map((r) => r.split(' | ')[0] + ' ' + r.split(' | ')[1])).toEqual(['uploading 1.png', 'uploading 2.png', 'uploading 3.png', 'refused 4.png'])
    expect(h.rows('inp-files-attach')[3]).toContain('At most three files.')
    // Full: the zone says so and is aria-disabled; activating it opens no picker.
    const zone = h.zone('inp-files-attach')
    expect(zone.getAttribute('aria-disabled')).toBe('true')
    expect(zone.querySelector('.sem-prompt')!.textContent).toBe('At most three files.')
    h.picker.asked.length = 0
    await pick(h, 'inp-files-attach', [file('5.png', 'image/png', 100)])
    expect(h.picker.asked).toEqual([])
    // The locked drop over the same property lists them, without buttons, and opens nothing.
    expect(h.rows('inp-files-off')).toHaveLength(3)
    expect(h.root('inp-files-off').querySelectorAll('button[data-sem-c=icon-button]')).toHaveLength(0)
    await pick(h, 'inp-files-off', [file('6.png', 'image/png', 100)])
    expect(h.picker.asked).toEqual([])
  })

  it('takes one picture: the picker offers the media types the shape lists, one at a time', async () => {
    const h = inputs()
    await pick(h, 'inp-files-picture', [file('cat.gif', 'image/gif', 100)])
    // (The order of the media types is the store's; the picker does not mind.)
    expect(h.picker.asked.map((a) => ({ ...a, accept: a.accept?.split(',').sort().join(',') }))).toEqual([{ accept: 'image/jpeg,image/png', multiple: false }])
    expect(h.rows('inp-files-picture')).toEqual(['refused | cat.gif | 100 bytesNot acceptedA PNG or JPEG picture.'])
    await pick(h, 'inp-files-picture', [file('cat.jpg', 'image/jpeg', 2_500_000)])
    // Kept in the page (no upload): ready.
    expect(h.rows('inp-files-picture')[1]).toBe('ready | cat.jpg | 2.5 MBReady')
    expect(h.values('inp-picture')).toHaveLength(1)
    // A picker closed without a choice changes nothing, and answers the request.
    await pick(h, 'inp-files-attach', null)
    expect(h.store.match(null, h.store.factory.namedNode(FILE.requestedBy), null)).toEqual([])
    expect(h.rows('inp-files-attach')).toEqual([])
  })

  it('shows its reception of files dragged over the page, and takes those dropped on it', async () => {
    const h = inputs()
    const attach = h.zone('inp-files-attach')
    const picture = h.zone('inp-files-picture')
    // Two images come over the page: every drop is offered them, and says whether it takes them.
    drag(h, h.document.body, 'dragenter', ['image/png', 'image/png'])
    expect(attach.getAttribute('data-sem-drop')).toBe('accepts')
    // The picture takes one: two are too many.
    expect(picture.getAttribute('data-sem-drop')).toBe('refuses')
    expect(picture.getAttribute('data-sem-drop-reason')).toBe('One picture.')
    // A disabled drop is not offered them.
    expect(h.zone('inp-files-off').hasAttribute('data-sem-drop')).toBe(false)
    const over = drag(h, attach.querySelector('.sem-title')!, 'dragover', ['image/png', 'image/png'])
    expect(over.defaultPrevented).toBe(true)
    expect(over.dataTransfer!.dropEffect).toBe('copy')
    expect(attach.hasAttribute('data-sem-drop-over')).toBe(true)
    // Dropped on the picture: refused, announced, nothing added.
    drag(h, picture, 'dragover', ['image/png', 'image/png'])
    drag(h, picture, 'drop', ['image/png', 'image/png'], [file('x.png', 'image/png', 10), file('y.png', 'image/png', 10)])
    expect(h.values('inp-picture')).toEqual([])
    expect(h.toasts()).toContain('!One picture.✕')
    expect(picture.hasAttribute('data-sem-drop')).toBe(false)
    expect(h.store.match(h.store.factory.namedNode(DND.Current), h.store.factory.namedNode(DND.carrying), null)).toEqual([])

    // A text file is not what the attachments take.
    drag(h, h.document.body, 'dragenter', ['text/plain'])
    expect(attach.getAttribute('data-sem-drop')).toBe('refuses')
    expect(attach.getAttribute('data-sem-drop-reason')).toBe('Only images and PDFs.')
    drag(h, h.document.body, 'dragleave', ['text/plain'])
    expect(attach.hasAttribute('data-sem-drop')).toBe(false)

    // Images dropped on the attachments arrive, each checked with its size known.
    drag(h, h.document.body, 'dragenter', ['image/png', 'image/jpeg'])
    drag(h, attach, 'dragover', ['image/png', 'image/jpeg'])
    drag(h, attach, 'drop', ['image/png', 'image/jpeg'], [file('small.png', 'image/png', 10), file('huge.jpg', 'image/jpeg', 9_000_000)])
    await h.files.settled()
    h.shell.flush()
    expect(h.rows('inp-files-attach')).toEqual(['uploading | small.png | 10 bytesUploading', 'refused | huge.jpg | 9 MBNot acceptedAt most 2 MB per file.'])
    expect(attach.hasAttribute('data-sem-drop')).toBe(false)
  })

  it('keeps cards from a board out: only files go in', () => {
    const h = inputs()
    const f = h.store.factory
    // Something of the page itself is carried (not a file).
    h.runtime.apply({ add: [f.quad(f.namedNode(DND.Current), f.namedNode(DND.carrying), f.namedNode(UI + 'inputsDemo')), f.quad(f.namedNode(UI + 'inp-files-attach'), f.namedNode(DND.offered), f.namedNode(DND.Current))], remove: [] })
    h.shell.flush()
    expect(h.zone('inp-files-attach').getAttribute('data-sem-drop')).toBe('refuses')
    expect(h.zone('inp-files-attach').getAttribute('data-sem-drop-reason')).toBe('Only files can go here.')
  })

  it('renders the same HTML with SPARQL rules and their function twins, after every step', async () => {
    const [a, b] = [inputs('oxigraph', 'sparql'), inputs('oxigraph', 'function')]
    const same = () => {
      for (const id of ['inp-files-attach', 'inp-files-picture', 'inp-files-off']) expect(b.html(id), id).toBe(a.html(id))
    }
    same()
    for (const h of [a, b]) await pick(h, 'inp-files-attach', [file('report.pdf', 'application/pdf', 120_000), file('movie.mov', 'video/quicktime', 900_000), file('noext', '', 5)])
    same()
    for (const h of [a, b]) upload(h, 'report.pdf').ctx.onProgress(60_000), h.shell.flush()
    same()
    for (const h of [a, b]) upload(h, 'noext').reject(new Error('Nope.'))
    for (const h of [a, b]) await h.files.settled(), h.shell.flush()
    same()
    for (const h of [a, b]) await pick(h, 'inp-files-attach', [file('3.png', 'image/png', 1), file('4.png', 'image/png', 1)])
    same()
    for (const h of [a, b]) h.click(h.root('inp-files-attach').querySelector('[aria-label="Remove movie.mov"]')!)
    same()
    for (const h of [a, b]) await pick(h, 'inp-files-picture', [file('me.png', 'image/png', 4096)])
    same()
    for (const h of [a, b]) drag(h, h.document.body, 'dragenter', ['image/png'])
    same()
    for (const h of [a, b]) drag(h, h.zone('inp-files-picture'), 'dragover', ['image/png'])
    same()
  })

  it('says it in the viewer\'s language, sizes in its locale', async () => {
    const h = inputs()
    h.screen.engine.reconfigure({ languages: ['de'] })
    h.shell.flush()
    await pick(h, 'inp-files-attach', [file('bericht.pdf', 'application/pdf', 1_250_000)])
    const zone = h.zone('inp-files-attach')
    expect(zone.textContent).toBe('⤒AnhängeDateien hier ablegen oder auswählen')
    expect(h.rows('inp-files-attach')).toEqual(['uploading | bericht.pdf | 1,3 MBWird hochgeladen'])
    expect(h.root('inp-files-attach').querySelector('[aria-label="Hochladen von bericht.pdf abbrechen"]')).not.toBeNull()
  })

  for (const [kind, prefer] of [['oxigraph', 'sparql'], ['wat', 'sparql'], ['oxigraph', 'function']] as const) {
    it(`refuses in the viewer's language: the reception, the toast and each file's reason (${kind}, ${prefer})`, async () => {
      const h = inputs(kind, prefer)
      h.screen.engine.reconfigure({ languages: ['ar'] })
      h.shell.flush()
      const attach = h.zone('inp-files-attach')
      const picture = h.zone('inp-files-picture')
      // Two images over the page: the picture takes one (its capacity's message), a text file is not an attachment.
      drag(h, h.document.body, 'dragenter', ['image/png', 'image/png'])
      expect(picture.getAttribute('data-sem-drop-reason')).toBe('صورة واحدة.')
      expect(h.store.match(null, h.store.factory.namedNode(DND.reason), null).map((q) => q.object.value)).toEqual(['صورة واحدة.'])
      drag(h, h.document.body, 'dragleave', ['image/png', 'image/png'])
      drag(h, h.document.body, 'dragenter', ['text/plain'])
      expect(attach.getAttribute('data-sem-drop-reason')).toBe('الصور وملفات PDF فقط.')
      drag(h, h.document.body, 'dragleave', ['text/plain'])
      // A picture too large, dropped on the attachments: listed as refused, with the shape's Arabic message, and announced.
      drag(h, h.document.body, 'dragenter', ['image/png'])
      drag(h, attach, 'dragover', ['image/png'])
      drag(h, attach, 'drop', ['image/png'], [file('big.png', 'image/png', 3_000_000)])
      await h.files.settled()
      h.shell.flush()
      expect(h.rows('inp-files-attach')[0]).toMatch(/2 ميغابايت على الأكثر لكل ملف\.$/)
      expect(h.toasts().filter(Boolean)).toEqual(['!2 ميغابايت على الأكثر لكل ملف.✕'])
      // Back in English, the next refusal is in English.
      h.screen.engine.reconfigure({ languages: ['en'] })
      h.shell.flush()
      drag(h, h.document.body, 'dragenter', ['text/plain'])
      expect(attach.getAttribute('data-sem-drop-reason')).toBe('Only images and PDFs.')
    })
  }

  it('refuses with the same HTML from SPARQL rules and their function twins in another language, after every step', async () => {
    const [a, b] = [inputs('oxigraph', 'sparql'), inputs('oxigraph', 'function')]
    const same = () => {
      for (const id of ['inp-files-attach', 'inp-files-picture']) expect(b.html(id), id).toBe(a.html(id))
    }
    for (const h of [a, b]) h.screen.engine.reconfigure({ languages: ['uk'] }), h.shell.flush()
    same()
    for (const h of [a, b]) drag(h, h.document.body, 'dragenter', ['image/png', 'image/png'])
    same()
    expect(a.zone('inp-files-picture').getAttribute('data-sem-drop-reason')).toBe('Одне зображення.')
    for (const h of [a, b]) drag(h, h.document.body, 'dragleave', ['image/png', 'image/png']), drag(h, h.document.body, 'dragenter', ['text/plain'])
    same()
    expect(a.zone('inp-files-attach').getAttribute('data-sem-drop-reason')).toBe('Лише зображення та PDF.')
    for (const h of [a, b]) drag(h, h.document.body, 'dragleave', ['text/plain'])
    for (const h of [a, b]) await pick(h, 'inp-files-attach', [file('movie.mov', 'video/quicktime', 900_000), file('big.png', 'image/png', 3_000_000)])
    same()
    expect(a.rows('inp-files-attach').map((r) => r.split(' | ')[0])).toEqual(['refused', 'refused'])
    expect(a.html('inp-files-attach')).toContain('Не більше 2 МБ на файл.')
  })

  it('reads as text', async () => {
    const h = inputs()
    await pick(h, 'inp-files-attach', [file('report.pdf', 'application/pdf', 120_000), file('movie.mov', 'video/quicktime', 900_000)])
    const text = h.runtime.project({ modality: MOD.Text, name: 'text', roots: [UI + 'inp-files-col'] })
    expect(toText(text.index, UI + 'inp-files-attach')).toBe(
      ['[Attachments: Drop files here, or choose them] Images or PDFs, up to 2 MB each; at most three.', '  - report.pdf (120 kB) Uploading 0%', '  - movie.mov (900 kB) Not accepted: Only images and PDFs.'].join('\n'),
    )
  })

  it('is well formed: no shape violations for the drops and their items', async () => {
    const h = inputs()
    await pick(h, 'inp-files-attach', [file('report.pdf', 'application/pdf', 120_000), file('movie.mov', 'video/quicktime', 900_000)])
    const f = h.store.factory
    const offenders = h.store
      .match(null, f.namedNode(NS.sh + 'focusNode'), null)
      .map((q) => q.object.value)
      .filter((v) => v.includes('inp-files'))
    expect(offenders).toEqual([])
  })
})
