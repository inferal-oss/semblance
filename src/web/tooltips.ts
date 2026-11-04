// The host side of the tooltip layer (ontology/layers/tooltip.ttl). The graph says what a node's
// tooltip is (sem:tooltip, projected as data-sem-tooltip); the theme's ::after can only show it
// inside the source's overflow, so while this effect runs it shows the text on a surface of its
// own: one element at a time, lifted and placed by the anchored-panel effect (anchored-popups.ts),
// so no ancestor clips it. Hover and keyboard focus show it, as :hover and :focus-visible did;
// Escape, pressing the source and printing dismiss it until the source is left. On touch, where
// nothing hovers, a long press shows it and so does a tap on what a tap does nothing else to.
//
// Which tooltip is showing is the browser's state, as :hover is: nothing here writes the graph.
// The surface lives in the host, so it copies from its source what the source inherits (the theme's
// tokens, the colour scheme, the direction, the language), and it follows the source's text.

/** Rendered with data-sem-tooltip; the effect marks its host so the theme's ::after stands down. */
const SOURCE = '[data-sem-tooltip]'
const ACTIVE = 'data-sem-tooltips'
const SSR = '[data-sem-ssr]'
/** What a tap on a touch screen acts on: there a tap is not asking for the tooltip. */
const TAPPABLE = 'a[href], button, input, select, textarea, summary, label, [tabindex], [role=button], [role=link], [role=tab], [role=menuitem], [role=switch], [role=checkbox]'
const LONG_PRESS_MS = 500
const PRESS_SLOP_PX = 8
/** What the surface's style reads from where its source is (a theme may be set on any subtree). */
const INHERITED = ['--sem-tooltip-bg', '--sem-tooltip-fg', '--sem-font', '--sem-shadow-raised', 'color-scheme']

let surfaces = 0

/** `lift` puts a panel in the top layer next to an element, until the panel leaves the DOM. */
export function attachTooltips(host: Element, owns: (element: Element) => boolean, lift: (panel: HTMLElement, anchor: HTMLElement) => void) {
  const document = host.ownerDocument
  const window = document.defaultView!
  /** What asks for a tooltip: the pointer over it, the keyboard on it, a finger that held it. */
  const asking = { hovered: null as HTMLElement | null, focused: null as HTMLElement | null, touched: null as HTMLElement | null }
  /** Dismissed, and not showing again until nothing asks for it any more. */
  const dismissed = new Set<HTMLElement>()
  let shown: { source: HTMLElement; surface: HTMLElement; id: string } | null = null
  let press: { source: HTMLElement; x: number; y: number; wasTouched: boolean; timer: ReturnType<typeof setTimeout> } | null = null
  /** A focus that follows a touch is not the keyboard's, even where :focus-visible says so (a text field). */
  let touching = false

  const sourceOf = (target: EventTarget | null) => {
    const element = (target as Element | null)?.closest?.(SOURCE) as HTMLElement | null | undefined
    return element && host.contains(element) && owns(element) && !element.closest(SSR) ? element : null
  }
  const present = (source: HTMLElement) => source.isConnected && !!source.getAttribute('data-sem-tooltip') && !source.closest('[hidden], [inert]')

  const hide = () => {
    if (!shown) return
    observer.disconnect()
    const tokens = (shown.source.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((t) => t && t !== shown!.id)
    if (tokens.length) shown.source.setAttribute('aria-describedby', tokens.join(' '))
    else shown.source.removeAttribute('aria-describedby')
    shown.surface.remove()
    shown = null
  }
  const show = (source: HTMLElement) => {
    hide()
    const surface = document.createElement('div')
    const id = `sem-tooltip-${++surfaces}`
    const style = window.getComputedStyle(source)
    surface.id = id
    surface.className = 'sem-tooltip'
    surface.setAttribute('role', 'tooltip')
    surface.setAttribute('data-sem-anchor', '')
    surface.setAttribute('data-sem-anchor-side', 'above')
    surface.setAttribute('data-sem-anchor-align', 'center')
    surface.setAttribute('dir', style.direction)
    const lang = source.closest('[lang]')?.getAttribute('lang')
    if (lang) surface.setAttribute('lang', lang)
    for (const property of INHERITED) surface.style.setProperty(property, style.getPropertyValue(property))
    surface.textContent = source.getAttribute('data-sem-tooltip')
    host.append(surface)
    source.setAttribute('aria-describedby', [source.getAttribute('aria-describedby'), id].filter(Boolean).join(' '))
    shown = { source, surface, id }
    lift(surface, source)
    observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-sem-tooltip', 'hidden', 'inert'] })
  }
  /** Show what was asked for last; when that stops asking, what still asks. */
  const settle = (latest?: HTMLElement) => {
    for (const source of dismissed) if (source !== asking.hovered && source !== asking.focused && source !== asking.touched) dismissed.delete(source)
    const candidates = [latest, shown?.source, asking.touched, asking.hovered, asking.focused]
    const wanted = candidates.find((source) => source && (source === asking.touched || source === asking.hovered || source === asking.focused) && !dismissed.has(source)) ?? null
    if (wanted === (shown?.source ?? null)) return
    if (wanted) show(wanted)
    else hide()
  }
  const dismiss = () => {
    for (const source of Object.values(asking)) if (source) dismissed.add(source)
    settle()
  }
  const ask = (kind: keyof typeof asking, source: HTMLElement | null) => {
    if (asking[kind] === source) return
    asking[kind] = source
    settle(source ?? undefined)
  }

  // The source left, was hidden, or lost its tooltip; or its text changed (a language, a validation).
  const observer = new window.MutationObserver(() => {
    if (!shown) return
    for (const kind of Object.keys(asking) as (keyof typeof asking)[]) if (asking[kind] && !present(asking[kind]!)) asking[kind] = null
    if (!shown.surface.isConnected || !present(shown.source)) hide()
    settle()
    if (!shown) return
    const text = shown.source.getAttribute('data-sem-tooltip')
    if (shown.surface.textContent !== text) shown.surface.textContent = text
  })

  const over = (e: Event) => {
    const event = e as PointerEvent
    // Nothing hovers on touch, and what the pointer crosses in a drag is not being asked about.
    if (event.pointerType === 'touch' || event.buttons) return
    ask('hovered', sourceOf(event.target))
  }
  const out = (e: Event) => {
    const event = e as PointerEvent
    if (event.pointerType !== 'touch' && !host.contains(event.relatedTarget as Node | null)) ask('hovered', null)
  }
  const focusIn = (e: Event) => {
    const target = e.target as HTMLElement
    const source = sourceOf(target)
    ask('focused', source === target && !touching && focusVisible(source) ? source : null)
  }
  const focusOut = () => ask('focused', null)
  const endPress = () => {
    if (!press) return
    clearTimeout(press.timer)
    document.removeEventListener('pointermove', moved, true)
    press = null
  }
  const moved = (e: Event) => {
    const event = e as PointerEvent
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > PRESS_SLOP_PX) endPress()
  }
  const down = (e: Event) => {
    const event = e as PointerEvent
    touching = event.pointerType === 'touch'
    if (!touching) {
      // Pressing what the tooltip is about: the action is under way, it has said its piece.
      const source = sourceOf(event.target)
      if (source) dismissed.add(source)
      settle()
      return
    }
    endPress()
    const source = sourceOf(event.target)
    const wasTouched = !!source && asking.touched === source
    ask('touched', null)
    if (!source) return
    press = {
      source, wasTouched, x: event.clientX, y: event.clientY,
      timer: setTimeout(() => {
        const held = press?.source
        endPress()
        if (held && present(held)) ask('touched', held)
      }, LONG_PRESS_MS),
    }
    document.addEventListener('pointermove', moved, true)
  }
  const up = () => {
    if (!press) return
    const { source, wasTouched } = press
    endPress()
    if (!wasTouched && !source.matches(TAPPABLE)) ask('touched', source)
  }
  const key = (e: Event) => {
    touching = false
    // The key goes on: what closes on Escape (a dialog, a menu) still closes at the same press.
    if ((e as KeyboardEvent).key === 'Escape') dismiss()
  }

  host.setAttribute(ACTIVE, '')
  host.addEventListener('pointerover', over)
  host.addEventListener('pointerout', out)
  host.addEventListener('focusin', focusIn)
  host.addEventListener('focusout', focusOut)
  document.addEventListener('pointerdown', down, true)
  document.addEventListener('pointerup', up, true)
  document.addEventListener('pointercancel', endPress, true)
  document.addEventListener('keydown', key, true)
  window.addEventListener('beforeprint', dismiss)

  // Taking over under a resting pointer or focus: what the ::after was showing goes on showing.
  const under = hoveredSource(host)
  if (under) ask('hovered', sourceOf(under))
  const active = document.activeElement as HTMLElement | null
  if (active?.matches?.(SOURCE) && focusVisible(active)) ask('focused', sourceOf(active))

  return () => {
    endPress()
    hide()
    host.removeAttribute(ACTIVE)
    host.removeEventListener('pointerover', over)
    host.removeEventListener('pointerout', out)
    host.removeEventListener('focusin', focusIn)
    host.removeEventListener('focusout', focusOut)
    document.removeEventListener('pointerdown', down, true)
    document.removeEventListener('pointerup', up, true)
    document.removeEventListener('pointercancel', endPress, true)
    document.removeEventListener('keydown', key, true)
    window.removeEventListener('beforeprint', dismiss)
  }
}

/** Whether the focus shows, where the page can tell (a page that cannot shows the tooltip). */
function focusVisible(element: Element | null) {
  if (!element) return false
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}

/** The innermost source under a resting pointer, where the page can tell. */
function hoveredSource(host: Element) {
  try {
    return [...host.querySelectorAll(`${SOURCE}:hover`)].at(-1) ?? null
  } catch {
    return null
  }
}
