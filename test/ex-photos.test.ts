// The photo post example (demo/gallery/_ex-photos.ttl): a headline, a layout picked by a segmented control,
// switches for the viewer's options, and a live preview that opens the viewer - through events only.
import { describe, expect, it } from 'vitest'
import { mountSite } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const C = 'https://semblance.dev/ns/component#'

function post(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountSite('oxigraph', prefer)
  const visible = (el: Element | null | undefined) => !!el && !el.closest('[hidden]')
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  click([...h.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Examples' && visible(b))!)
  click([...h.document.querySelectorAll('[data-sem-c=nav-list] button')].find((b) => b.textContent!.trim() === 'Photo post' && visible(b))!)
  const root = (id: string) => h.shell.nodeOf(`${UI}${id}/~root`) as HTMLElement
  const part = (id: string, local: string) => h.shell.nodeOf(`${UI}${id}/~${local}`) as HTMLElement
  const fact = (s: string, p: string) => h.store.match(h.store.factory.namedNode(UI + s), h.store.factory.namedNode(C + p), null).map((q) => q.object.value)
  return { ...h, root, part, click, fact }
}

describe('the photo post example', () => {
  for (const prefer of ['sparql', 'function'] as const) {
    it(`titles the post as you type, switches the layout live and opens the viewer (${prefer})`, () => {
      const s = post(prefer)
      const gallery = () => s.root('ph-gallery')
      expect(gallery().getAttribute('data-layout')).toBe('carousel')
      expect(s.part('ph-gallery', 'dot-1').getAttribute('aria-current')).toBe('true')
      // The headline titles the preview and the gallery (the viewer's title).
      const field = s.root('ph-headline').querySelector('input')!
      field.value = 'Sea, sand and pines'
      s.fire(field, 'input')
      s.shell.flush()
      expect(s.root('ph-title').textContent).toBe('Sea, sand and pines')
      expect(gallery().getAttribute('aria-label')).toBe('Sea, sand and pines')
      // The picker: the layouts as the ontology lists them; picking one is one triple.
      const segments = [...s.root('ph-layout').querySelectorAll('button')]
      expect(segments).toHaveLength(3)
      s.click(segments[2]!)
      expect(s.fact('ph-gallery', 'galleryLayout')).toEqual([C + 'PileLayout'])
      expect(gallery().querySelectorAll('.sem-photo')).toHaveLength(4)
      // A print opens the viewer at its photo, with its thumbnails.
      s.click(s.part('ph-gallery', 'photo-3'))
      expect(s.fact('ph-viewer', 'open')).toEqual(['true'])
      expect(s.document.getElementById(s.part('ph-viewer', 'panel').getAttribute('aria-labelledby')!)!.textContent).toBe('Sea, sand and pines')
      expect(s.part('ph-viewer', 'caption').textContent).toBe('Walking the dunes')
      expect(s.part('ph-viewer', 'strip').querySelectorAll('.sem-thumb')).toHaveLength(4)
      // The loop switch is the gallery's: past the last photo is the first, in the viewer too.
      s.click(s.part('ph-viewer', 'close'))
      s.click(s.root('ph-loop').querySelector('[role=switch]')!)
      expect(s.fact('ph-gallery', 'loops')).toEqual(['true'])
      s.click(s.part('ph-gallery', 'photo-4'))
      s.click(s.part('ph-viewer', 'next'))
      expect(s.fact('ph-gallery', 'current')).toEqual([UI.replace('#', '/photos#') + 'harbour'])
      s.click(s.part('ph-viewer', 'close'))
    })

    it(`reorders the photos by dragging them in the order list: the gallery follows (${prefer})`, () => {
      const s = post(prefer)
      const key = (el: Element, k: string) => {
        const e = new s.window.Event('keydown', { bubbles: true, cancelable: true })
        Object.assign(e, { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
        el.dispatchEvent(e)
        s.shell.flush()
      }
      const order = () => [...s.root('ph-order').querySelectorAll('[data-sem-drag]')].map((d) => d.textContent!.trim())
      const alts = () => [...s.root('ph-gallery').querySelectorAll('.sem-slide img')].map((i) => i.getAttribute('src'))
      expect(order()).toEqual(['The harbour at dusk', 'The lighthouse on the point', 'Walking the dunes', 'Back through the forest'])
      // Space lifts the lighthouse, the arrows carry it past the last photo, Enter drops it.
      const lighthouse = () => [...s.root('ph-order').querySelectorAll('[data-sem-drag]')].find((d) => d.textContent!.includes('lighthouse'))!
      key(lighthouse(), ' ')
      key(lighthouse(), 'ArrowDown')
      key(lighthouse(), 'ArrowDown')
      key(lighthouse(), 'Enter')
      expect(order()).toEqual(['The harbour at dusk', 'Walking the dunes', 'Back through the forest', 'The lighthouse on the point'])
      expect(alts()).toEqual(['photos/harbour.jpg', 'photos/dunes.webp', 'photos/forest.jpg', 'photos/lighthouse.jpg'])
      expect(s.part('ph-gallery', 'slide-4').getAttribute('aria-label')).toBe('4 of 4')
    })
  }
})
