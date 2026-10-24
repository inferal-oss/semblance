// The keyboard layer (ontology/layers/keyboard.ttl): shortcuts as data.
import type { FnRule } from '../engine/context.ts'
import { KEY, MOD } from '../ns.ts'
import { labelOf, str } from '../components/util.ts'
import { mint } from '../rdf.ts'

const MODIFIERS = ['mod', 'ctrl', 'alt', 'shift', 'meta']

/** "Shift+Mod+k" -> "mod+shift+k": modifiers in a fixed order, lower case. */
export function normalizeShortcut(combo: string): string {
  const parts = combo.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean)
  const key = parts.filter((p) => !MODIFIERS.includes(p)).join('+')
  return [...MODIFIERS.filter((m) => parts.includes(m)), key].join('+')
}

/** The combination a keyboard event stands for ("mod" when the platform's command key is held). */
export function comboOf(e: KeyboardEvent, apple: boolean): string {
  const parts: string[] = []
  if (apple ? e.metaKey : e.ctrlKey) parts.push('mod')
  if (apple && e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (!apple && e.metaKey) parts.push('meta')
  parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase())
  return normalizeShortcut(parts.join('+'))
}

const GLYPHS: Record<string, [string, string]> = { mod: ['⌘', 'Ctrl+'], ctrl: ['⌃', 'Ctrl+'], alt: ['⌥', 'Alt+'], shift: ['⇧', 'Shift+'], meta: ['◆', 'Win+'] }
/** Display labels: [Apple, others]. */
export function shortcutLabels(combo: string): [string, string] {
  const parts = normalizeShortcut(combo).split('+')
  const key = parts.pop()!
  const k = key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1)
  return [parts.map((p) => GLYPHS[p]![0]).join('') + k, parts.map((p) => GLYPHS[p]![1]).join('') + k]
}

/** aria-keyshortcuts uses platform key names. */
const aria = (combo: string) =>
  normalizeShortcut(combo)
    .split('+')
    .map((p) => ({ mod: 'Control', ctrl: 'Control', alt: 'Alt', shift: 'Shift', meta: 'Meta' })[p] ?? (p.length === 1 ? p.toUpperCase() : p))
    .join('+')

const shortcut: FnRule = (ctx, focus) => {
  const combo = str(ctx.object(focus, KEY.shortcut))
  if (!combo) return []
  const o = ctx.out(focus)
  const root = ctx.nn(mint(focus.value, 'root'))
  const [apple, other] = shortcutLabels(combo)
  o.attr(root, 'aria-keyshortcuts', aria(combo))
    .attr(root, 'data-sem-shortcut', normalizeShortcut(combo))
    .attr(root, 'data-sem-shortcut-apple', apple)
    .attr(root, 'data-sem-shortcut-other', other)
  return o.quads
}

const shortcutList: FnRule = (ctx, focus) => {
  const o = ctx.out(focus)
  const items = ctx
    .match(null, KEY.shortcut, null)
    .map((q) => ({ node: q.subject, combo: q.object.value, label: labelOf(ctx, q.subject) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  if (ctx.modality === MOD.Text) {
    o.renders(o.el('root', 'Div', {}, items.map((it, i) => o.text('l' + i, `${shortcutLabels(it.combo)[1]}  ${it.label}\n`))))
    return o.quads
  }
  const rows = items.map((it, i) => {
    const [apple, other] = shortcutLabels(it.combo)
    return o.el('row-' + i, 'Div', {}, [
      o.el('row-' + i + '-dt', 'Dt', {}, [o.text('row-' + i + '-label', it.label)]),
      o.el('row-' + i + '-dd', 'Dd', {}, [
        o.el('row-' + i + '-apple', 'Kbd', { class: 'sem-apple' }, [o.text('row-' + i + '-apple-text', apple)]),
        o.el('row-' + i + '-other', 'Kbd', { class: 'sem-other' }, [o.text('row-' + i + '-other-text', other)]),
      ]),
    ])
  })
  o.renders(o.el('root', 'Dl', {}, rows))
  return o.quads
}

export const keyboardFunctions: Record<string, FnRule> = { 'keyboard:shortcut': shortcut, 'shortcut-list': shortcutList }
