// The image components (ontology/components/gallery.ttl): a gallery in its three layouts, switched
// by a segmented control, and the lightbox, driven through events on the Data and Overlays pages as a
// person would, with the DOM and the graph checked after each step, and the SPARQL rules and
// their function twins compared after each step.
import { describe, expect, it } from 'vitest'
import { MOD, NS } from '../src/ns.ts'
import { toText } from '../src/render/serialize.ts'
import { ManualClock } from '../src/behaviour/clock.ts'
import { mountShell } from './harness.ts'
import { implementationGaps } from './implementations.ts'

const UI = 'https://semblance.dev/demo#'
const C = NS.c

/** The shell on a Components page group, with helpers to reach the gallery's parts. */
function photos(group: 'GroupData' | 'GroupOverlays' = 'GroupData', prefer: 'sparql' | 'function' = 'sparql') {
  // A clock of the test's own: the change log's times are the same in both projections.
  const h = mountShell(5, 'oxigraph', prefer, new ManualClock())
  const f = h.store.factory
  const show = (key: string) => {
    const app = f.namedNode(UI + 'app')
    const p = f.namedNode(UI + 'galleryGroup')
    h.runtime.apply({ remove: h.store.match(app, p, null), add: [f.quad(app, p, f.namedNode(UI + key))] })
    h.shell.flush()
  }
  h.showPage('Components')
  show(group)
  const node = (iri: string) => h.shell.nodeOf(iri) as HTMLElement | undefined
  const root = (id: string) => node(`${UI}${id}/~root`)!
  const part = (id: string, local: string) => node(`${UI}${id}/~${local}`)!
  const fact = (s: string, p: string) => h.store.match(f.namedNode(UI + s), f.namedNode(C + p), null).map((q) => q.object.value.replace(UI, ''))
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  const key = (k: string, at: Element = h.document.body) => {
    const e = new h.window.Event('keydown', { bubbles: true, cancelable: true })
    Object.assign(e, { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
    at.dispatchEvent(e)
    h.shell.flush()
  }
  /** Pick a layout as a person does: press its segment. */
  const layout = (name: 'carousel' | 'grid' | 'pile', picker = 'dt-layout') => {
    const label = name[0]!.toUpperCase() + name.slice(1)
    click([...root(picker).querySelectorAll('button')].find((b) => b.textContent!.includes(label))!)
  }
  const html = () => h.document.getElementById('app')!.innerHTML
  return { ...h, show, node, root, part, fact, click, key, layout, html }
}

const ALTS = ['A pier with lamps', 'Snow-capped mountains', 'A red and white lighthouse', 'Rolling sand dunes', 'A sandy path', 'City towers']

describe('gallery and lightbox', () => {
  it('has SPARQL and function implementations', () => {
    expect(implementationGaps(['components/gallery.ttl'])).toEqual({ noSparql: [], noFunction: [] })
  })

  it('switches the layout live: a picker over c:galleryLayout offers the layouts the ontology lists', () => {
    const s = photos()
    expect([...s.root('dt-layout').querySelectorAll('button')].map((b) => b.lastElementChild!.textContent)).toEqual(['Carousel', 'Grid', 'Pile'])
    expect(s.root('dt-photos').getAttribute('data-layout')).toBe('pile')
    s.layout('grid')
    expect(s.fact('dt-photos', 'galleryLayout')).toEqual([C + 'GridLayout'])
    expect(s.root('dt-photos').getAttribute('data-layout')).toBe('grid')
    expect(s.root('dt-photos').querySelectorAll('.sem-cell')).toHaveLength(6)
    expect(s.root('dt-photos').querySelector('.sem-photo')).toBeNull()
  })

  it('lays a pile out like prints on a table: each image a button named by its alt text, tilted the same way every time', () => {
    const s = photos()
    const prints = [...s.root('dt-photos').querySelectorAll('.sem-pile > .sem-photo')] as HTMLElement[]
    expect(prints).toHaveLength(6)
    prints.forEach((p, k) => {
      expect(p.tagName).toBe('BUTTON')
      expect(p.querySelector('img')!.getAttribute('alt')).toContain(ALTS[k]!)
      expect(p.getAttribute('style')).toMatch(new RegExp(`^--i: ${k + 1}; --tilt: -?\\d; --dx: -?\\d; --dy: -?\\d$`))
    })
    // The lie of a print comes from its image, not from the render or its place.
    const lie = (p: HTMLElement) => p.getAttribute('style')!.replace(/^--i: \d+; /, '')
    const before = prints.map(lie)
    s.layout('grid')
    s.layout('pile')
    expect(([...s.root('dt-photos').querySelectorAll('.sem-photo')] as HTMLElement[]).map(lie)).toEqual(before)
    expect(s.root('dt-photos').getAttribute('data-sem-nav-items')).toBe('[data-sem-item]')
  })

  it('moves a carousel with its arrows and dots: slides as groups, the current dot marked, ends that stop', () => {
    const s = photos()
    s.layout('carousel')
    const g = s.root('dt-photos')
    expect([g.getAttribute('role'), g.getAttribute('aria-roledescription'), g.getAttribute('aria-label')]).toEqual(['region', 'carousel', 'Places'])
    const slides = [...g.querySelectorAll('.sem-slide')]
    expect(slides.map((x) => [x.getAttribute('role'), x.getAttribute('aria-roledescription'), x.getAttribute('aria-label')])).toEqual(
      [1, 2, 3, 4, 5, 6].map((i) => ['group', 'slide', `${i} of 6`]),
    )
    expect(s.part('dt-photos', 'track').hasAttribute('data-sem-snap')).toBe(true)
    const prev = s.part('dt-photos', 'prev')
    const next = s.part('dt-photos', 'next')
    expect(prev.getAttribute('aria-controls')).toBe(`${UI}dt-photos/~track`)
    // A dot per image, named by its place; the current one is marked.
    const dots = () => [...s.part('dt-photos', 'dots').querySelectorAll('.sem-dot')]
    expect(dots().map((d) => d.getAttribute('aria-label'))).toEqual([1, 2, 3, 4, 5, 6].map((i) => `${i} of 6`))
    const counter = () => `${dots().findIndex((d) => d.getAttribute('aria-current') === 'true') + 1}`
    expect(counter()).toBe('1')
    // Each slide holds its image as a button named by its alt text, which opens the lightbox.
    const item = s.part('dt-photos', 'slide-1-item')
    expect([item.tagName, item.querySelector('img')!.getAttribute('alt')]).toEqual(['BUTTON', expect.stringContaining(ALTS[0]!)])
    expect(s.part('dt-photos', 'live').textContent).toBe('Image 1 of 6')
    expect(prev.hasAttribute('disabled')).toBe(true)
    expect(s.part('dt-photos', 'slide-1').hasAttribute('data-sem-current')).toBe(true)
    s.click(next)
    expect(s.fact('dt-photos', 'current')).toEqual(['photo-lake'])
    expect(counter()).toBe('2')
    expect(prev.hasAttribute('disabled')).toBe(false)
    expect(s.part('dt-photos', 'slide-1').hasAttribute('data-sem-current')).toBe(false)
    expect(s.part('dt-photos', 'slide-2').hasAttribute('data-sem-current')).toBe(true)
    for (let k = 0; k < 6; k++) s.click(next)
    expect(s.fact('dt-photos', 'current')).toEqual(['photo-city'])
    expect(next.hasAttribute('disabled')).toBe(true)
    expect(s.part('dt-photos', 'live').textContent).toBe('Image 6 of 6')
    s.click(prev)
    expect(counter()).toBe('5')
    // A dot goes to its image, in place.
    s.click(dots()[1]!)
    expect(s.fact('dt-photos', 'current')).toEqual(['photo-lake'])
    expect(s.fact('dt-lightbox', 'open')).toEqual([])
  })

  it('follows a swipe: where the track comes to rest is the current image, and that is not history', () => {
    const s = photos()
    s.layout('carousel')
    const logged = s.bus.recent(100).length
    s.fire(s.part('dt-photos', 'slide-4'), 'sem-snap')
    s.shell.flush()
    expect(s.fact('dt-photos', 'current')).toEqual(['photo-dunes'])
    expect(s.part('dt-photos', 'dot-4').getAttribute('aria-current')).toBe('true')
    expect(s.bus.recent(100).length).toBe(logged)
  })

  it('opens the lightbox at the image activated, a modal dialog with its place, caption and spoken description', () => {
    const s = photos()
    s.layout('grid')
    expect(s.root('dt-lightbox').hasAttribute('hidden')).toBe(true)
    s.click(s.part('dt-photos', 'cell-3'))
    expect(s.fact('dt-photos', 'current')).toEqual(['photo-lighthouse'])
    expect(s.fact('dt-lightbox', 'open')).toEqual(['true'])
    const lb = s.root('dt-lightbox')
    expect(lb.hasAttribute('hidden')).toBe(false)
    expect(s.document.querySelector('[data-sem-c=desktop]')!.contains(lb)).toBe(true)
    const panel = s.part('dt-lightbox', 'panel')
    expect([panel.getAttribute('role'), panel.getAttribute('aria-modal')]).toEqual(['dialog', 'true'])
    expect(s.document.getElementById(panel.getAttribute('aria-labelledby')!)!.textContent).toBe('Places')
    expect(s.part('dt-lightbox', 'counter').textContent).toBe('3 / 6')
    expect(s.part('dt-lightbox', 'caption').textContent).toBe('Lighthouse')
    expect(s.part('dt-lightbox', 'live').textContent).toBe('Image 3 of 6: A red and white lighthouse on dark rocks above breaking waves')
    // The current image and its neighbours, in order; the current one is marked for the snap effect.
    const frames = [...s.part('dt-lightbox', 'frames').children] as HTMLElement[]
    expect(frames.map((x) => x.querySelector('img')!.getAttribute('src'))).toEqual(['photos/lake.jpg', 'photos/lighthouse.jpg', 'photos/dunes.webp'])
    expect(frames.map((x) => x.hasAttribute('data-sem-current'))).toEqual([false, true, false])
    expect(s.part('dt-lightbox', 'frames').hasAttribute('data-sem-snap')).toBe(true)
    // Each image names where it is in the gallery: the lightbox grows from there and returns there.
    const origin = frames[1]!.querySelector('img')!.getAttribute('data-sem-origin')!
    expect(s.document.getElementById(origin)).toBe(s.part('dt-photos', 'cell-3').querySelector('img'))
  })

  it('keeps the focus inside the open lightbox: Tab goes round', () => {
    const s = photos()
    s.layout('grid')
    s.click(s.part('dt-photos', 'cell-2'))
    const panel = s.part('dt-lightbox', 'panel')
    const parts = [...panel.querySelectorAll('button:not([disabled]), a[href]')] as HTMLElement[]
    // linkedom has no focus: a minimal one (focus() moves it, activeElement reads it).
    let active: Element | null = null
    Object.defineProperty(s.document, 'activeElement', { configurable: true, get: () => active ?? s.document.body })
    for (const el of s.document.querySelectorAll('button, a, input')) (el as HTMLElement).focus = () => void (active = el)
    parts.at(-1)!.focus()
    const tab = (shift: boolean) => {
      const e = new s.window.Event('keydown', { bubbles: true, cancelable: true })
      Object.assign(e, { key: 'Tab', shiftKey: shift, ctrlKey: false, metaKey: false, altKey: false })
      s.document.activeElement!.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(tab(false)).toBe(true)
    expect(s.document.activeElement).toBe(parts[0])
    expect(tab(true)).toBe(true)
    expect(s.document.activeElement).toBe(parts.at(-1))
    // A focus left outside is brought in.
    s.part('dt-photos', 'cell-1').focus()
    expect(tab(false)).toBe(true)
    expect(panel.contains(s.document.activeElement)).toBe(true)
  })

  it('moves through the images by arrow keys, mirrored in a right-to-left page, and closes with Escape', () => {
    const s = photos()
    s.click(s.part('dt-photos', 'photo-2'))
    s.key('ArrowRight')
    expect(s.fact('dt-photos', 'current')).toEqual(['photo-lighthouse'])
    s.key('ArrowLeft')
    s.key('ArrowLeft')
    expect(s.fact('dt-photos', 'current')).toEqual(['photo-harbour'])
    // At the start the previous arrow is disabled (it does not loop).
    expect(s.part('dt-lightbox', 'prev').hasAttribute('disabled')).toBe(true)
    s.document.documentElement.setAttribute('dir', 'rtl')
    s.key('ArrowLeft')
    expect(s.fact('dt-photos', 'current')).toEqual(['photo-lake'])
    s.key('ArrowRight')
    expect(s.fact('dt-photos', 'current')).toEqual(['photo-harbour'])
    s.document.documentElement.removeAttribute('dir')
    s.key('Escape')
    expect(s.fact('dt-lightbox', 'open')).toEqual(['false'])
    expect(s.root('dt-lightbox').children).toHaveLength(0)
    // Closed, the arrows are not there to take the keys.
    s.key('ArrowRight')
    expect(s.fact('dt-photos', 'current')).toEqual(['photo-harbour'])
  })

  it('zooms by the button or a double-click, and fits the next image again', () => {
    const s = photos()
    s.click(s.part('dt-photos', 'photo-4'))
    const zoom = s.part('dt-lightbox', 'zoom')
    expect(zoom.getAttribute('aria-pressed')).toBe('false')
    s.click(zoom)
    expect(s.fact('dt-lightbox', 'zoomed')).toEqual(['true'])
    expect(s.part('dt-lightbox', 'zoom').getAttribute('aria-pressed')).toBe('true')
    expect(s.part('dt-lightbox', 'stage').hasAttribute('data-zoomed')).toBe(true)
    expect(s.part('dt-lightbox', 'frames').children).toHaveLength(1)
    s.fire(s.part('dt-lightbox', 'frame-4-img'), 'dblclick')
    s.shell.flush()
    expect(s.fact('dt-lightbox', 'zoomed')).toEqual(['false'])
    s.fire(s.part('dt-lightbox', 'frame-4-img'), 'dblclick')
    s.shell.flush()
    expect(s.fact('dt-lightbox', 'zoomed')).toEqual(['true'])
    s.click(s.part('dt-lightbox', 'next'))
    expect(s.fact('dt-lightbox', 'zoomed')).toEqual([])
    expect(s.fact('dt-photos', 'current')).toEqual(['photo-forest'])
    expect(s.part('dt-lightbox', 'frames').children).toHaveLength(3)
  })

  it('fills the window, or the screen, with its panel by its own toggles (fs:)', () => {
    const s = photos()
    s.click(s.part('dt-photos', 'photo-3'))
    const toggle = s.part('dt-lightbox', 'viewport-toggle')
    expect([toggle.getAttribute('aria-label'), toggle.getAttribute('aria-pressed')]).toEqual(['Fill the window', 'false'])
    s.click(toggle)
    expect(s.store.match(s.store.factory.namedNode(UI + 'dt-lightbox'), s.store.factory.namedNode(NS.fs + 'fullViewport'), null).map((q) => q.object.value)).toEqual(['true'])
    expect(s.part('dt-lightbox', 'panel').hasAttribute('data-sem-fullscreen')).toBe(true)
    expect(s.part('dt-lightbox', 'viewport-toggle').getAttribute('aria-pressed')).toBe('true')
    // Full screen asks the host for the panel.
    s.click(s.part('dt-lightbox', 'fullscreen-toggle'))
    expect(s.fullscreen.requests.at(-1)).toBe(s.part('dt-lightbox', 'panel'))
  })

  it('loops, shows thumbnails and links to the original when the lightbox says so', () => {
    const s = photos('GroupOverlays')
    const cells = [...s.root('ov-photos').querySelectorAll('.sem-cell')]
    expect(cells).toHaveLength(4)
    s.click(cells[3]!)
    expect(s.fact('ov-photos', 'current')).toEqual(['photo-harbour'])
    expect(s.part('ov-lightbox', 'next').hasAttribute('disabled')).toBe(false)
    // Its neighbours wrap around: the last image's next is the first.
    const frames = () => ([...s.part('ov-lightbox', 'frames').children] as HTMLElement[]).map((x) => x.querySelector('img')!.getAttribute('src'))
    expect(frames()).toEqual(['photos/city.jpg', 'photos/harbour.jpg', 'photos/lake.jpg'])
    s.click(s.part('ov-lightbox', 'next'))
    expect(s.fact('ov-photos', 'current')).toEqual(['photo-lake'])
    const strip = s.part('ov-lightbox', 'strip')
    expect([strip.getAttribute('role'), strip.getAttribute('aria-label')]).toEqual(['group', 'Thumbnails'])
    const thumbs = [...strip.querySelectorAll('.sem-thumb')]
    expect(thumbs.map((t) => t.getAttribute('aria-current'))).toEqual(['true', null, null, null])
    s.click(thumbs[2]!)
    expect(s.fact('ov-photos', 'current')).toEqual(['photo-city'])
    expect([...s.part('ov-lightbox', 'strip').querySelectorAll('.sem-thumb')].map((t) => t.getAttribute('aria-current'))).toEqual([null, null, 'true', null])
    const original = s.part('ov-lightbox', 'original')
    expect([original.getAttribute('href'), original.getAttribute('target'), original.getAttribute('rel')]).toEqual(['photos/city.jpg', '_blank', 'noopener'])
    // The opener (a c:Button that c:opens it) says it opens a dialog.
    s.click(s.part('ov-lightbox', 'scrim'))
    expect(s.fact('ov-lightbox', 'open')).toEqual(['false'])
  })

  it('renders the same HTML from the SPARQL rules and their function twins, after every step', () => {
    const shells = (['sparql', 'function'] as const).map((prefer) => photos('GroupData', prefer))
    const same = (step: string) => {
      const [a, b] = shells.map((s) => s.html())
      if (a === b) return
      let i = 0
      while (i < a!.length && a![i] === b![i]) i++
      expect(a!.slice(Math.max(0, i - 300), i + 300), `after ${step}`).toBe(b!.slice(Math.max(0, i - 300), i + 300))
    }
    const steps: [string, (s: ReturnType<typeof photos>) => void][] = [
      ['loading', () => {}],
      ['opening a print', (s) => s.click(s.part('dt-photos', 'photo-5'))],
      ['the next image', (s) => s.click(s.part('dt-lightbox', 'next'))],
      ['zooming', (s) => s.click(s.part('dt-lightbox', 'zoom'))],
      ['closing', (s) => s.click(s.part('dt-lightbox', 'close'))],
      ['the carousel', (s) => s.layout('carousel')],
      ['its next slide', (s) => s.click(s.part('dt-photos', 'next'))],
      ['a swipe', (s) => (s.fire(s.part('dt-photos', 'slide-5'), 'sem-snap'), s.shell.flush())],
      ['a slide', (s) => s.click(s.part('dt-photos', 'slide-5-item'))],
      ['a dot', (s) => s.click(s.part('dt-photos', 'dot-3'))],
      ['the grid', (s) => s.layout('grid')],
      ['the Overlays page', (s) => s.show('GroupOverlays')],
      ['a cell', (s) => s.click(s.part('ov-photos', 'cell-2'))],
      ['a thumbnail', (s) => s.click(s.part('ov-lightbox', 'thumb-4'))],
      ['looping past the end', (s) => s.click(s.part('ov-lightbox', 'next'))],
    ]
    for (const [name, act] of steps) {
      for (const s of shells) act(s)
      same(name)
    }
  })

  it('sketches the images in text: the gallery lists them with their alt text, the open lightbox says where it is', () => {
    const s = photos()
    s.click(s.part('dt-photos', 'photo-2'))
    for (const prefer of ['sparql', 'function'] as const) {
      const text = s.runtime.project({ modality: MOD.Text, prefer, name: `text-images-${prefer}`, roots: [UI + 'gallery-data', UI + 'dt-lightbox'] })
      expect(toText(text.index, UI + 'dt-photos').split('\n')).toEqual([
        '▦ Places (pile, 6)',
        '1. A pier with lamps runs into a calm harbour at dusk, sailboats in silhouette',
        '2. Snow-capped mountains and a pine forest reflected in a still lake',
        '3. A red and white lighthouse on dark rocks above breaking waves',
        '4. Rolling sand dunes in warm afternoon light, three walkers on a crest',
        '5. A sandy path leads into layers of pine forest in morning haze',
        '6. City towers with lit windows under a starry sky and a crescent moon',
      ])
      expect(toText(text.index, UI + 'dt-lightbox')).toBe('╔ Places ╗ Image 2 of 6: Snow-capped mountains and a pine forest reflected in a still lake — Mountain lake')
    }
  })

  // Moving through the images costs what it changes: the same work in a gallery of 6 and of 60.
  for (const prefer of ['sparql', 'function'] as const) {
    it(`moves to the next image at a cost independent of the number of images (${prefer})`, () => {
      const cost = (count: number) => {
        const s = photos('GroupData', prefer)
        const f = s.store.factory
        const nn = (iri: string) => f.namedNode(iri)
        const counters = { read: 0, sparqlRows: 0 }
        const { match, select, construct } = s.store
        s.store.match = (...args) => {
          const quads = match.apply(s.store, args)
          counters.read += quads.length
          return quads
        }
        s.store.select = (...args) => {
          const rows = select.apply(s.store, args)
          counters.sparqlRows += rows.length
          return rows
        }
        s.store.construct = (...args) => {
          const quads = construct.apply(s.store, args)
          counters.sparqlRows += quads.length
          return quads
        }
        // A gallery of `count` pictures of its own.
        const g = nn(UI + 'dt-photos')
        const RDF = NS.rdf
        const pictures = Array.from({ length: count }, (_, k) => nn(`${UI}many-${k}`))
        const cells = pictures.map((_, k) => nn(`${UI}many-list-${k}`))
        const add = pictures.flatMap((p, k) => [
          f.quad(p, nn(RDF + 'type'), nn(C + 'Picture')),
          f.quad(p, nn(C + 'image'), f.literal(`photos/${k}.jpg`)),
          f.quad(p, nn(C + 'alt'), f.literal(`Picture ${k}`)),
          f.quad(cells[k]!, nn(RDF + 'first'), p),
          f.quad(cells[k]!, nn(RDF + 'rest'), k + 1 < count ? cells[k + 1]! : nn(RDF + 'nil')),
        ])
        s.runtime.apply({ remove: s.store.match(g, nn(C + 'images'), null), add: [...add, f.quad(g, nn(C + 'images'), cells[0]!), f.quad(g, nn(C + 'current'), pictures[1]!)] })
        s.shell.flush()
        s.layout('carousel')
        const snapshot = () => ({
          ruleRuns: s.screen.engine.stats.ruleRuns,
          written: s.screen.engine.stats.derivedAdded + s.screen.engine.stats.derivedRemoved,
          read: counters.read,
          sparqlRows: counters.sparqlRows,
          domOps: s.shell.ops,
        })
        const measure = (act: () => void) => {
          const a = snapshot()
          act()
          const b = snapshot()
          return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v - a[k as keyof typeof a]]))
        }
        // The carousel's arrow, then the lightbox's (each once to warm up, then measured).
        s.click(s.part('dt-photos', 'next'))
        const carousel = measure(() => s.click(s.part('dt-photos', 'next')))
        s.click(s.part('dt-photos', 'slide-2-item'))
        s.click(s.part('dt-lightbox', 'next'))
        const lightbox = measure(() => s.click(s.part('dt-lightbox', 'next')))
        expect(s.fact('dt-photos', 'current')).toEqual(['many-3'])
        return { carousel, lightbox }
      }
      const small = cost(6)
      const large = cost(60)
      expect(small.carousel.ruleRuns).toBeGreaterThan(0)
      expect(large).toEqual(small)
    })
  }
})
