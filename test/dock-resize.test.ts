import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { MOD, NS, RDF_TYPE, SEM, VAL } from '../src/ns.ts'
import { DomRenderer } from '../src/render/dom.ts'
import { Runtime } from '../src/runtime.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const c = NS.c
const SH = 'http://www.w3.org/ns/shacl#'

/** The Windows gallery group, in one shell per implementation; every step runs in both and they must agree. */
function bothShells(kind: 'oxigraph' | 'wat' = 'oxigraph') {
  const shells = (['sparql', 'function'] as const).map((prefer) => {
    const h = mountShell(5, kind, prefer)
    const f = h.store.factory
    h.showPage('Components')
    const app = f.namedNode(UI + 'app')
    const group = f.namedNode(UI + 'galleryGroup')
    h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupWindows'))] })
    h.shell.flush()
    const node = (iri: string) => ([...h.document.querySelectorAll('*')].find((el) => h.shell.keyOf(el) === iri) ?? null) as HTMLElement | null
    const root = (local: string) => node(`${UI}${local}/~root`)!
    const handle = (local: string) => root(local)?.querySelector(':scope > .sem-dock-handle') as HTMLElement | null
    const fact = (local: string, p: string) => h.store.match(f.namedNode(UI + local), f.namedNode(c + p), null)[0]?.object.value
    const put = (local: string, p: string, o: string) => {
      const s = f.namedNode(UI + local)
      const pn = f.namedNode(p)
      h.runtime.apply({ remove: h.store.match(s, pn, null), add: [f.quad(s, pn, f.namedNode(o))] })
      h.shell.flush()
    }
    const size = (el: Element, detail: { size: number; extent: number }) => {
      el.dispatchEvent(new h.window.CustomEvent('sem-size', { bubbles: true, detail }))
      h.shell.flush()
    }
    const key = (el: Element, k: string) => {
      const e = new h.window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string }
      Object.defineProperty(e, 'key', { value: k })
      el.dispatchEvent(e)
      h.shell.flush()
    }
    /** A measured box (linkedom does no layout) and what the browser would compute for it. */
    const box = (el: Element, width: number, height: number) => {
      ;(el as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height })
    }
    const styled = (style: Record<string, string> | undefined) => {
      if (style) (h.window as unknown as { getComputedStyle: () => object }).getComputedStyle = () => style
      else delete (h.window as unknown as { getComputedStyle?: () => object }).getComputedStyle
    }
    const open = (button: string) => {
      h.fire(root(button), 'click')
      h.shell.flush()
    }
    return { ...h, node, root, handle, fact, put, size, key, box, styled, open }
  })
  const html = () => shells.map((h) => h.document.getElementById('app')!.innerHTML)
  /** Do it in both, then assert in both and that they render byte-identical HTML. */
  const step = (act: (h: (typeof shells)[number]) => void, check: (h: (typeof shells)[number]) => void = () => {}) => {
    for (const h of shells) act(h)
    for (const h of shells) check(h)
    const [a, b] = html()
    if (a !== b) {
      let i = 0
      while (i < a!.length && a![i] === b![i]) i++
      expect(a!.slice(Math.max(0, i - 300), i + 300)).toBe(b!.slice(Math.max(0, i - 300), i + 300))
    }
  }
  return { shells, step }
}

const attrs = (el: Element) => Object.fromEntries(['role', 'aria-orientation', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'data-sem-axis', 'data-sem-sign'].map((n) => [n, el.getAttribute(n)]))

for (const kind of ['oxigraph', 'wat'] as const) {
  describe(`a docked frame's free edge (${kind})`, () => {
    it('is off by default: a docked window that does not ask keeps the size the graph says', () => {
      const { step } = bothShells(kind)
      step((h) => h.open('wn-open-checklist'))
      step(
        (h) => h.put('win-checklist', c + 'attachedTo', c + 'EndEdge'),
        (h) => {
          expect(h.root('win-checklist').getAttribute('data-sem-edge')).toBe('end')
          expect(h.handle('win-checklist')).toBeNull()
          expect(h.root('win-checklist').querySelector('.sem-window-body')!.hasAttribute('id')).toBe(false)
          expect(h.root('win-checklist').getAttribute('style')).toContain('width: 380px')
        },
      )
    })

    it('says what it is on every side: the opposite edge, along the free axis', () => {
      const { step } = bothShells(kind)
      step(
        (h) => h.open('wn-open-side'),
        (h) => {
          expect(h.root('win-side').getAttribute('data-sem-edge')).toBe('end')
          expect(attrs(h.handle('win-side')!)).toEqual({ role: 'separator', 'aria-orientation': 'vertical', 'aria-valuenow': '360', 'aria-valuemin': '240', 'aria-valuemax': '720', 'data-sem-axis': 'x', 'data-sem-sign': '-1' })
          expect(h.handle('win-side')!.getAttribute('aria-label')).toBe('Resize: Side panel')
          expect(h.handle('win-side')!.getAttribute('tabindex')).toBe('0')
          expect(h.handle('win-side')!.getAttribute('aria-controls')).toBe(h.root('win-side').querySelector('.sem-window-body')!.id)
          expect(h.root('win-side').querySelector('.sem-window-grip')).toBeNull()
        },
      )
      for (const [edge, value, axis, sign, orientation] of [
        ['StartEdge', '360', 'x', '1', 'vertical'],
        ['TopEdge', '300', 'y', '1', 'horizontal'],
        ['BottomEdge', '300', 'y', '-1', 'horizontal'],
        ['EndEdge', '360', 'x', '-1', 'vertical'],
      ] as const) {
        step(
          (h) => h.put('win-side', c + 'attachedTo', c + edge),
          (h) => {
            const a = attrs(h.handle('win-side')!)
            expect([a['aria-valuenow'], a['data-sem-axis'], a['data-sem-sign'], a['aria-orientation']]).toEqual([value, axis, sign, orientation])
          },
        )
      }
    })

    it('sets c:width or c:height, within c:minSize, c:maxSize and the room there is', () => {
      const { step } = bothShells(kind)
      step((h) => h.open('wn-open-side'))
      const size = (n: number, extent: number) => (h: { size: (el: Element, d: { size: number; extent: number }) => void; handle: (l: string) => HTMLElement | null }) => h.size(h.handle('win-side')!, { size: n, extent })
      step(size(500, 1400), (h) => {
        expect(h.fact('win-side', 'width')).toBe('500')
        expect(h.fact('win-side', 'height')).toBe('300')
        expect(h.root('win-side').getAttribute('style')).toContain('width: 500px')
        expect(h.handle('win-side')!.getAttribute('aria-valuenow')).toBe('500')
      })
      step(size(100, 1400), (h) => expect(h.fact('win-side', 'width')).toBe('240'))
      step(size(900, 1400), (h) => expect(h.fact('win-side', 'width')).toBe('720'))
      step(size(700, 600), (h) => expect(h.fact('win-side', 'width')).toBe('600'))
      step((h) => h.put('win-side', c + 'attachedTo', c + 'BottomEdge'))
      step(size(420, 900), (h) => {
        expect(h.fact('win-side', 'height')).toBe('420')
        expect(h.fact('win-side', 'width')).toBe('600')
        expect(h.root('win-side').getAttribute('style')).toContain('height: 420px')
        expect(h.handle('win-side')!.getAttribute('aria-valuenow')).toBe('420')
      })
    })

    it('follows the pointer: one beh:Size event on release, and only the view changes before it', () => {
      const { step } = bothShells(kind)
      step((h) => h.open('wn-open-side'))
      step(
        (h) => {
          h.box(h.root('win-side'), 360, 600)
          const grip = h.handle('win-side')!
          const pointer = (type: string, clientX: number) => grip.dispatchEvent(Object.assign(new h.window.Event(type, { bubbles: true, cancelable: true }), { clientX, clientY: 300, button: 0, pointerId: 1 }))
          pointer('pointerdown', 900)
          // Docked at the end, dragging toward the start grows it.
          pointer('pointermove', 840)
          expect(h.root('win-side').style.width).toBe('420px')
          expect(h.fact('win-side', 'width')).toBe('360')
          pointer('pointerup', 840)
          h.shell.flush()
        },
        (h) => {
          expect(h.fact('win-side', 'width')).toBe('420')
          expect(h.root('win-side').getAttribute('style')).toContain('width: 420px')
        },
      )
    })

    it('takes the arrow keys, Home and End, and turns around where the text runs right to left', () => {
      const { step } = bothShells(kind)
      step((h) => h.open('wn-open-side'))
      const at = (width: number, k: string) => (h: { box: (e: Element, w: number, x: number) => void; root: (l: string) => HTMLElement; key: (e: Element, k: string) => void; handle: (l: string) => HTMLElement | null }) => {
        h.box(h.root('win-side'), width, 600)
        h.key(h.handle('win-side')!, k)
      }
      step(at(360, 'ArrowLeft'), (h) => expect(h.fact('win-side', 'width')).toBe('376'))
      step(at(376, 'ArrowRight'), (h) => expect(h.fact('win-side', 'width')).toBe('360'))
      step(at(360, 'Home'), (h) => expect(h.fact('win-side', 'width')).toBe('240'))
      step(at(240, 'End'), (h) => expect(h.fact('win-side', 'width')).toBe('720'))
      // At the end in Arabic the frame stands on the left and its right edge is free: right grows it.
      step((h) => h.styled({ direction: 'rtl', position: 'fixed' }))
      step(at(720, 'ArrowLeft'), (h) => expect(h.fact('win-side', 'width')).toBe('704'))
      step(at(704, 'ArrowRight'), (h) => expect(h.fact('win-side', 'width')).toBe('720'))
      step((h) => h.put('win-side', c + 'attachedTo', c + 'BottomEdge'))
      step((h) => {
        h.box(h.root('win-side'), 720, 300)
        h.key(h.handle('win-side')!, 'ArrowUp')
      }, (h) => expect(h.fact('win-side', 'height')).toBe('316'))
      step((h) => h.styled(undefined))
    })

    it('stops where the theme stops it, and a fixed frame has the viewport for room', () => {
      const { step } = bothShells(kind)
      step((h) => h.open('wn-open-side'))
      step(
        (h) => {
          h.styled({ direction: 'ltr', position: 'fixed', maxWidth: '500px' })
          h.box(h.root('win-side'), 360, 600)
          h.key(h.handle('win-side')!, 'End')
        },
        (h) => expect(h.fact('win-side', 'width')).toBe('500'),
      )
      step((h) => h.styled(undefined))
    })

    it('is its own: a size event from a handle inside the frame leaves the frame alone', () => {
      const { step } = bothShells(kind)
      step((h) => h.open('wn-open-side'))
      step(
        (h) => h.size(h.root('win-side').querySelector('.sem-window-body')!, { size: 500, extent: 1400 }),
        (h) => expect(h.fact('win-side', 'width')).toBe('360'),
      )
    })

    it('is there only while docked: floating keeps the size, maximized and back it returns', () => {
      const { step } = bothShells(kind)
      step((h) => h.open('wn-open-side'))
      step((h) => h.size(h.handle('win-side')!, { size: 500, extent: 1400 }))
      step(
        (h) => {
          h.fire(h.root('win-side').querySelector('[data-sem-control=maximize]')!, 'click')
          h.shell.flush()
        },
        (h) => {
          expect(h.fact('win-side', 'windowState')).toBe(c + 'Maximized')
          expect(h.handle('win-side')).toBeNull()
        },
      )
      step(
        (h) => {
          h.fire(h.root('win-side').querySelector('[data-sem-control=restore]')!, 'click')
          h.shell.flush()
        },
        (h) => expect(h.handle('win-side')).not.toBeNull(),
      )
      step(
        (h) => {
          h.fire(h.root('win-side').querySelector('[data-sem-control=undock]')!, 'click')
          h.shell.flush()
        },
        (h) => {
          expect(h.handle('win-side')).toBeNull()
          expect(h.root('win-side').querySelector('.sem-window-grip')).not.toBeNull()
          expect(h.root('win-side').querySelector('.sem-window-body')!.hasAttribute('id')).toBe(false)
          expect(h.root('win-side').getAttribute('style')).toContain('left: 200px; top: 160px; width: 500px; height: 300px')
        },
      )
    })

    it('holds a window whose own size is out of bounds to them while docked', () => {
      const { step } = bothShells(kind)
      step((h) => h.open('wn-open-side'))
      step(
        (h) => {
          const f = h.store.factory
          const s = f.namedNode(UI + 'win-side')
          const w = f.namedNode(c + 'width')
          h.runtime.apply({ remove: h.store.match(s, w, null), add: [f.quad(s, w, f.literal('2000', f.namedNode(NS.xsd + 'integer')))] })
          h.shell.flush()
        },
        (h) => {
          expect(h.root('win-side').getAttribute('style')).toContain('width: 720px')
          expect(h.handle('win-side')!.getAttribute('aria-valuenow')).toBe('720')
        },
      )
    })

    it('serves a palette that opts in, which needs a height to size along it', () => {
      const { step } = bothShells(kind)
      step((h) => h.open('wn-open-display'))
      step(
        (h) => h.put('win-display', c + 'attachedTo', c + 'TopEdge'),
        (h) => expect(h.handle('win-display')).toBeNull(),
      )
      step(
        (h) => {
          const f = h.store.factory
          h.runtime.apply({ remove: [], add: [f.quad(f.namedNode(UI + 'win-display'), f.namedNode(RDF_TYPE), f.namedNode(c + 'DockResizable'))] })
          h.shell.flush()
        },
        (h) => {
          expect(h.handle('win-display')!.getAttribute('aria-valuenow')).toBe('240')
          expect(h.root('win-display').getAttribute('style')).toContain('height: 240px')
        },
      )
      step(
        (h) => h.size(h.handle('win-display')!, { size: 320, extent: 900 }),
        (h) => {
          expect(h.fact('win-display', 'height')).toBe('320')
          expect(h.root('win-display').getAttribute('style')).toContain('height: 320px')
        },
      )
    })

    it('names its handle in the viewer\'s language', () => {
      const { step } = bothShells(kind)
      step((h) => h.open('wn-open-side'))
      for (const [lang, label] of [
        ['uk', 'Змінити розмір: Бічна панель'],
        ['de', 'Größe ändern: Seitenleiste'],
        ['ar', 'تغيير الحجم: لوحة جانبية'],
      ] as const) {
        step(
          (h) => {
            h.screen.engine.reconfigure({ languages: [lang] })
            h.shell.flush()
          },
          (h) => expect(h.handle('win-side')!.getAttribute('aria-label')).toBe(label),
        )
      }
    })
  })
}

describe('c:DockResizable shape', () => {
  it('wants c:minSize no more than c:maxSize', () => {
    const { document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
    const store = loadStore(
      'oxigraph',
      `@prefix c: <${c}> . @prefix ex: <https://example.org/> .
       ex:d a c:Desktop ; c:hosts ex:good , ex:bad .
       ex:good a c:Window , c:DockResizable ; c:title "Good" ; c:attachedTo c:StartEdge ; c:minSize 200 ; c:maxSize 400 .
       ex:bad a c:Window , c:DockResizable ; c:title "Bad" ; c:attachedTo c:StartEdge ; c:minSize 500 ; c:maxSize 400 .`,
    )
    const screen = new Runtime(store).project({ modality: MOD.Screen, layers: [VAL.ShapesLayer, SEM.TooltipLayer], name: 'screen', roots: ['https://example.org/d'] }, (e) => {
      throw e
    })
    new DomRenderer(screen.index, document.getElementById('app')!, 'https://example.org/d').flush()
    const f = store.factory
    const about = (s: string) => store.match(null, f.namedNode(SH + 'focusNode'), f.namedNode('https://example.org/' + s)).length
    expect(about('good')).toBe(0)
    expect(about('bad')).toBeGreaterThan(0)
  })
})
