// The site's foreign components (demo/gallery/_ex-foreign.ttl): well-known open-source libraries
// loaded from a CDN when an island first needs them, and the glue the islands effect (src/foreign.ts)
// mounts them with. The graph names a module ("shoelace/rating") or a widget ("leaflet"); only this file
// says what code that is.
import type { Widget } from '../src/foreign.ts'

/** Pinned versions, served with CORS and Cross-Origin-Resource-Policy headers (the page is cross-origin isolated). */
const CDN = 'https://cdn.jsdelivr.net/npm/'
const SHOELACE_RATING = CDN + '@shoelace-style/shoelace@2.20.1/cdn/components/rating/rating.js'
const CHART_JS = CDN + 'chart.js@4.4.7/+esm'
const LEAFLET = CDN + 'leaflet@1.9.4/+esm'
const LEAFLET_CSS = CDN + 'leaflet@1.9.4/dist/leaflet.css'
const FLATPICKR = CDN + 'flatpickr@4.6.13/+esm'
const FLATPICKR_CSS = CDN + 'flatpickr@4.6.13/dist/flatpickr.min.css'
const FLATPICKR_LOCALES: Record<string, [string, string]> = {
  uk: [CDN + 'flatpickr@4.6.13/dist/l10n/uk.js/+esm', 'Ukrainian'],
  de: [CDN + 'flatpickr@4.6.13/dist/l10n/de.js/+esm', 'German'],
  ar: [CDN + 'flatpickr@4.6.13/dist/l10n/ar.js/+esm', 'Arabic'],
}
const load = (url: string) => import(/* @vite-ignore */ url)

/** Loaders by ext:module name. */
export const modules: Record<string, () => Promise<unknown>> = {
  // Defines <sl-rating> (Shoelace, MIT): a property `value`, attributes, `sl-change`.
  'shoelace/rating': () => load(SHOELACE_RATING),
}

/** A library's stylesheet, added to the document once. */
const sheets = new Map<string, Promise<void>>()
function stylesheet(doc: Document, href: string): Promise<void> {
  let ready = sheets.get(href)
  if (!ready) {
    const link = Object.assign(doc.createElement('link'), { rel: 'stylesheet', href, crossOrigin: 'anonymous' })
    ready = new Promise((resolve, reject) => {
      link.onload = () => resolve()
      link.onerror = () => reject(new Error(`Could not load ${href}`))
    })
    doc.head.append(link)
    sheets.set(href, ready)
  }
  return ready
}

/**
 * The theme's colours for a canvas or SVG library: a custom property the island's style rules set
 * (from tokens: light-dark(), color-mix(), var()), resolved to rgba - the browser computes such
 * colours to forms libraries cannot parse (oklab), so one pixel painted with it gives it as rgba.
 */
function themeColours(element: HTMLElement): { colour(name: string, fallback: string): string; dispose(): void } {
  const doc = element.ownerDocument
  const probe = doc.createElement('span')
  probe.style.display = 'none'
  element.append(probe)
  const pixel = doc.createElement('canvas').getContext('2d', { willReadFrequently: true })!
  return {
    colour(name, fallback) {
      probe.style.color = `var(${name}, ${fallback})`
      pixel.clearRect(0, 0, 1, 1)
      pixel.fillStyle = getComputedStyle(probe).color || fallback
      pixel.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data
      return `rgba(${r}, ${g}, ${b}, ${Math.round((a! / 255) * 1000) / 1000})`
    },
    dispose: () => probe.remove(),
  }
}

/** Call `changed` when the theme, colour scheme, contrast, direction or language changes (attributes on <html> or an ancestor). */
function followLook(doc: Document, changed: () => void): () => void {
  const looks = new MutationObserver(changed)
  looks.observe(doc.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-sem-theme', 'data-sem-color-scheme', 'data-sem-contrast', 'dir', 'lang'] })
  const scheme = matchMedia('(prefers-color-scheme: dark)')
  scheme.addEventListener('change', changed)
  return () => {
    looks.disconnect()
    scheme.removeEventListener('change', changed)
  }
}

const rtlAt = (element: Element) => (element.closest('[dir]')?.getAttribute('dir') ?? element.ownerDocument.documentElement.dir) === 'rtl'
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// --- Chart.js ----------------------------------------------------------------------------------------

interface Bar {
  id: string
  label: string
  value: number
  order?: number
}

// The parts of Chart.js the widget uses (it has no types here: it comes from the CDN).
type ChartModule = {
  Chart: { new (canvas: HTMLCanvasElement, config: unknown): ChartLike; register(...items: unknown[]): void }
  BarController: unknown
  BarElement: unknown
  CategoryScale: unknown
  LinearScale: unknown
  Tooltip: unknown
}
type ChartLike = {
  data: { labels: string[]; datasets: { data: number[]; backgroundColor: string[]; hoverBackgroundColor: string[] }[] }
  options: Record<string, any>
  update(mode?: string): void
  destroy(): void
  scales: { x: { getValueForPixel(pixel: number): number | undefined } }
}

/**
 * Chart.js as a widget: a bar chart of `bars` ({ id, label, value, order }), `selected` (an id)
 * highlighted, `label` its accessible name. Choosing a bar - a click, or the arrow keys on the focused
 * chart (swapped in RTL) - calls emit('select', { id, label, index }). Colours are the theme's: the
 * island's style rules set --chart-bar, --chart-bar-selected, --chart-text and --chart-grid.
 */
export const chartJs: { load(): Promise<Widget> } = {
  async load() {
    const m = (await load(CHART_JS)) as ChartModule
    m.Chart.register(m.BarController, m.BarElement, m.CategoryScale, m.LinearScale, m.Tooltip)
    return chartWidget(m)
  },
}

function chartWidget(m: ChartModule): Widget {
  return {
    mount(element, inputs, emit) {
      const doc = element.ownerDocument
      const box = doc.createElement('div')
      box.style.cssText = 'position: relative; block-size: 14rem; inline-size: 100%'
      const canvas = doc.createElement('canvas')
      canvas.tabIndex = 0
      canvas.setAttribute('role', 'img')
      box.append(canvas)
      element.append(box)
      const { colour, dispose } = themeColours(element)
      let bars: Bar[] = []
      let selected: string | undefined
      let label = ''
      const chart = new m.Chart(canvas, {
        type: 'bar',
        data: { labels: [], datasets: [{ data: [], backgroundColor: [], hoverBackgroundColor: [], borderRadius: 6, maxBarThickness: 56, minBarLength: 4 }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: reducedMotion() ? false : { duration: 250 },
          interaction: { mode: 'index', intersect: false },
          plugins: { tooltip: { displayColors: false } },
          scales: { y: { beginAtZero: true, suggestedMax: 5, ticks: { stepSize: 1 } }, x: {} },
          // A click anywhere in a bar's column chooses it, by the category scale: an unrated coffee's
          // bar has no height to hit, and bars still animating are not where they will be.
          onClick: (e: { x: number }) => {
            const at = chart.scales.x.getValueForPixel(e.x)
            if (at !== undefined && Number.isFinite(at)) choose(Math.round(at))
          },
        },
      })
      const choose = (index: number) => {
        const b = bars[index]
        if (b) emit('select', { id: b.id, label: b.label, index })
      }
      const paint = () => {
        const bar = colour('--chart-bar', 'steelblue')
        const strong = colour('--chart-bar-selected', 'navy')
        const text = colour('--chart-text', '#666')
        const grid = colour('--chart-grid', '#ddd')
        const ds = chart.data.datasets[0]!
        ds.backgroundColor = bars.map((b) => (b.id === selected ? strong : bar))
        ds.hoverBackgroundColor = bars.map(() => strong)
        const o = chart.options
        const rtl = rtlAt(element)
        o.color = text
        o.scales.x.ticks = { color: text }
        o.scales.y.ticks = { color: text, stepSize: 1 }
        o.scales.x.grid = { color: grid }
        o.scales.y.grid = { color: grid }
        o.scales.x.reverse = rtl
        o.scales.y.position = rtl ? 'right' : 'left'
        o.plugins.tooltip.rtl = rtl
      }
      const draw = () => {
        chart.data.labels = bars.map((b) => b.label)
        chart.data.datasets[0]!.data = bars.map((b) => b.value)
        canvas.setAttribute('aria-label', `${label}: ${bars.map((b) => `${b.label} ${b.value}`).join(', ')}`)
        paint()
        chart.update()
      }
      const set = (o: Record<string, unknown>) => {
        if ('bars' in o) bars = Array.isArray(o.bars) ? [...(o.bars as Bar[])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : []
        if ('selected' in o) selected = o.selected === undefined ? undefined : String(o.selected)
        if ('label' in o) label = o.label === undefined ? '' : String(o.label)
      }
      canvas.addEventListener('keydown', (e) => {
        const at = Math.max(0, bars.findIndex((b) => b.id === selected))
        const rtl = rtlAt(element)
        const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key]
        const to = step !== undefined ? at + step : e.key === 'Home' ? 0 : e.key === 'End' ? bars.length - 1 : undefined
        if (to === undefined || to < 0 || to >= bars.length) return
        e.preventDefault()
        choose(to)
      })
      const unfollow = followLook(doc, () => (paint(), chart.update('none')))
      set(inputs)
      draw()
      return {
        update(changed) {
          set(changed)
          draw()
        },
        destroy() {
          unfollow()
          chart.destroy()
          box.remove()
          dispose()
        },
      }
    },
  }
}

// --- Leaflet -----------------------------------------------------------------------------------------

interface Place {
  id: string
  label: string
  lat: number
  lng: number
}

type LeafletModule = any

/**
 * Leaflet as a widget: a map of `places` ({ id, label, lat, lng }) as circle markers, `selected` (an id)
 * brought into view as a marker to drag, `label` the map's accessible name. A marker's click (or Enter on
 * a focused marker) calls emit('select', { id }); a click on the map elsewhere, dragging the chosen
 * marker, or the arrow keys on it (Shift: further) call emit('place', { lat, lng }) (two decimals). Markers are vectors, coloured from --map-marker and --map-marker-selected; the tiles are
 * OpenStreetMap's, fetched with CORS.
 */
export const leaflet: { load(): Promise<Widget> } = {
  async load() {
    await stylesheet(document, LEAFLET_CSS)
    const m = await load(LEAFLET)
    return leafletWidget(m.default ?? m)
  },
}

function leafletWidget(L: LeafletModule): Widget {
  return {
    mount(element, inputs, emit) {
      const doc = element.ownerDocument
      const box = doc.createElement('div')
      box.style.cssText = 'block-size: 16rem; inline-size: 100%; border-radius: inherit'
      element.append(box)
      const { colour, dispose } = themeColours(element)
      const map = L.map(box, { worldCopyJump: true, minZoom: 1, maxZoom: 9, zoomSnap: 0.5 })
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 9,
        crossOrigin: true,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map)
      const markers = L.layerGroup().addTo(map)
      let places: Place[] = []
      let selected: string | undefined
      let fitted = false
      const round = (n: number) => Math.round(n * 100) / 100
      const place = (lat: number, lng: number) => emit('place', { lat: round(lat), lng: round(((((lng + 180) % 360) + 360) % 360) - 180) })
      const draw = () => {
        // The chosen marker keeps the focus across a redraw (a nudge by key redraws it).
        const refocus = !!markers.getLayers().find((m: any) => m.options.draggable && m.getElement?.()?.contains(doc.activeElement))
        markers.clearLayers()
        const plain = colour('--map-marker', 'steelblue')
        const strong = colour('--map-marker-selected', 'navy')
        const surface = colour('--map-surface', 'white')
        for (const p of places) {
          if (p.id === selected) continue
          const marker = L.circleMarker([p.lat, p.lng], { radius: 7, color: strong, weight: 2, fillColor: plain, fillOpacity: 0.9, bubblingMouseEvents: false })
          marker.bindTooltip(p.label, { direction: 'top', offset: [0, -6] })
          marker.on('click', () => emit('select', { id: p.id }))
          marker.addTo(markers)
          // Vector markers are not focusable by default: make each one a button.
          const path = marker.getElement?.() as SVGElement | undefined
          if (path) {
            path.setAttribute('tabindex', '0')
            path.setAttribute('role', 'button')
            path.setAttribute('aria-label', p.label)
            path.addEventListener('keydown', (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              emit('select', { id: p.id })
            })
          }
        }
        // The chosen coffee: a marker to drag, or to nudge with the arrow keys, which places it.
        const chosen = places.find((p) => p.id === selected)
        if (!chosen) return
        const icon = L.divIcon({
          className: '',
          html: `<span style="display:block;inline-size:22px;block-size:22px;border-radius:50%;background:${strong};border:3px solid ${surface};box-shadow:0 1px 4px rgba(0,0,0,.45);cursor:grab"></span>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        })
        const marker = L.marker([chosen.lat, chosen.lng], { icon, draggable: true, keyboard: true, autoPanOnFocus: false, zIndexOffset: 1000 })
        marker.bindTooltip(chosen.label, { direction: 'top', offset: [0, -12] })
        marker.on('dragend', () => {
          const at = marker.getLatLng()
          place(at.lat, at.lng)
        })
        marker.addTo(markers)
        const el = marker.getElement?.() as HTMLElement | undefined
        if (el) {
          el.setAttribute('role', 'button')
          el.setAttribute('aria-label', chosen.label)
          el.setAttribute('aria-roledescription', 'draggable marker')
          el.addEventListener('keydown', (e) => {
            const step = e.shiftKey ? 2 : 0.5
            const move: Record<string, [number, number]> = { ArrowUp: [step, 0], ArrowDown: [-step, 0], ArrowLeft: [0, -step], ArrowRight: [0, step] }
            const d = move[e.key]
            if (!d) return
            // The map pans by the arrow keys too: this one is the marker's.
            e.preventDefault()
            e.stopPropagation()
            place(chosen.lat + d[0], chosen.lng + d[1])
          })
          if (refocus) el.focus({ preventScroll: true })
        }
      }
      const view = () => {
        const target = places.find((p) => p.id === selected)
        if (!fitted && places.length) {
          map.fitBounds(L.latLngBounds(places.map((p) => [p.lat, p.lng])), { padding: [24, 24], maxZoom: 5, animate: false })
          fitted = true
        } else if (target) map.panTo([target.lat, target.lng], { animate: !reducedMotion() })
        else if (!places.length) map.setView([10, 20], 1.5)
      }
      const set = (o: Record<string, unknown>) => {
        if ('places' in o) places = Array.isArray(o.places) ? (o.places as Place[]).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)) : []
        if ('selected' in o) selected = o.selected === undefined ? undefined : String(o.selected)
        if ('label' in o) box.setAttribute('aria-label', o.label === undefined ? '' : String(o.label))
      }
      map.on('click', (e: any) => place(e.latlng.lat, e.latlng.lng))
      // Shown after it was mounted (a hidden page, a narrower column): the map measures again.
      const sized = new ResizeObserver(() => map.invalidateSize())
      sized.observe(box)
      const unfollow = followLook(doc, draw)
      set(inputs)
      draw()
      view()
      // Vector markers have their elements once the map has rendered: name them then.
      map.whenReady(() => queueMicrotask(draw))
      return {
        update(changed) {
          set(changed)
          draw()
          if ('selected' in changed || 'places' in changed) view()
        },
        destroy() {
          unfollow()
          sized.disconnect()
          map.remove()
          box.remove()
          dispose()
        },
      }
    },
  }
}

// --- flatpickr ---------------------------------------------------------------------------------------

/**
 * flatpickr as a widget: a date field whose `value` is an ISO date (YYYY-MM-DD), `label` its accessible
 * name; picking a date calls emit('change', { date }). The calendar opens beside the field (static), so
 * the island's style rules reach it; it speaks the page's language (uk, de, ar, else English). A value
 * pushed from the graph is set without raising a change: flatpickr's own echo suppression.
 */
export const flatpickr: { load(): Promise<Widget> } = {
  async load() {
    await stylesheet(document, FLATPICKR_CSS)
    const m = await load(FLATPICKR)
    return flatpickrWidget(m.default ?? m)
  },
}

async function locale(lang: string): Promise<unknown> {
  const entry = FLATPICKR_LOCALES[lang.slice(0, 2)]
  if (!entry) return 'default'
  const m = await load(entry[0])
  return m[entry[1]] ?? 'default'
}

function flatpickrWidget(make: (input: HTMLInputElement, options: object) => any): Widget {
  return {
    mount(element, inputs, emit) {
      const doc = element.ownerDocument
      const input = doc.createElement('input')
      input.type = 'text'
      element.append(input)
      let label = ''
      const picker = make(input, {
        static: true,
        dateFormat: 'Y-m-d',
        altInput: true,
        altFormat: 'j F Y',
        allowInput: false,
        disableMobile: true,
        defaultDate: (inputs.value as string | undefined) || undefined,
        onChange: (_: Date[], date: string) => emit('change', { date }),
      })
      const name = () => picker.altInput?.setAttribute('aria-label', label)
      let lang = ''
      const speak = async () => {
        const now = doc.documentElement.lang || 'en'
        if (now === lang) return
        lang = now
        picker.set('locale', await locale(now))
        picker.redraw()
        // A new locale writes the shown date anew.
        if (picker.selectedDates.length) picker.setDate(picker.selectedDates, false)
      }
      const unfollow = followLook(doc, () => void speak())
      void speak()
      const set = (o: Record<string, unknown>) => {
        if ('label' in o) (label = o.label === undefined ? '' : String(o.label)), name()
        if ('value' in o) {
          const value = o.value === undefined ? '' : String(o.value)
          if (input.value !== value) picker.setDate(value || [], false)
        }
      }
      set(inputs)
      return {
        update: set,
        destroy() {
          unfollow()
          picker.destroy()
          input.remove()
        },
      }
    },
  }
}
