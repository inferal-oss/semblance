// Maintained views in React (docs/VIEWS.md): a component reads a view of @inferal-oss/semblance/views
// with useView or useRows, over useSyncExternalStore. Each view has one source here, shared by every
// component that reads it: it hears the view's own changes (ViewHandle.subscribe, called only for a
// tick that changed that view) and keeps one snapshot until the next, so a component re-renders when
// its view changed and never for another view's change. The server snapshot is the same snapshot:
// renderToString over views built before rendering shows what they hold, and a client that builds
// the same views from the same data hydrates it as is.
//
// Only types come from the framework, so a page that uses views and these hooks pulls in neither
// the hosted-component adapter nor the framework's main entry.
import type { Quad, Row, Term, ViewHandle } from '@inferal-oss/semblance/views'
import { useSyncExternalStore } from 'react'

/** What a view holds now: its rows in order (a SELECT), its triples (a CONSTRUCT), and how many changes it has had. */
export interface ViewState {
  readonly rows: readonly Row[]
  readonly quads: readonly Quad[]
  /** The view's changes heard since its first reader: a new number, a new snapshot. */
  readonly version: number
}

/** A row's values by variable (each term's value): what useRows gives by default. */
export type Values = Record<string, string>

class Source {
  version = 0
  private readonly listeners = new Set<() => void>()
  private state?: ViewState
  /** This version's rows as each reader's select makes them. */
  private mapped = new Map<unknown, readonly unknown[]>()

  constructor(private readonly handle: ViewHandle) {
    // Heard for as long as the view lives, so a change while no component is subscribed (between a
    // render and its effect) still makes a new snapshot.
    handle.subscribe(() => {
      this.version++
      this.state = undefined
      this.mapped.clear()
      for (const l of [...this.listeners]) l()
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  current = (): number => this.version

  snapshot = (): ViewState => (this.state ??= { rows: this.handle.orderedRows(), quads: this.handle.quads(), version: this.version })

  rows<T>(select: (row: Row) => T): readonly T[] {
    let rows = this.mapped.get(select) as readonly T[] | undefined
    if (!rows) this.mapped.set(select, (rows = this.snapshot().rows.map(select)))
    return rows
  }
}

const sources = new WeakMap<ViewHandle, Source>()

function sourceOf(handle: ViewHandle): Source {
  let s = sources.get(handle)
  if (!s) sources.set(handle, (s = new Source(handle)))
  return s
}

/** A view's current state; the component re-renders when that view changes, and only then. */
export function useView(handle: ViewHandle): ViewState {
  const s = sourceOf(handle)
  return useSyncExternalStore(s.subscribe, s.snapshot, s.snapshot)
}

/** Each term's value by variable. */
export const values = (row: Row): Values => {
  const out: Values = {}
  for (const [k, t] of row as Map<string, Term>) out[k] = t.value
  return out
}

/**
 * A SELECT view's rows, in its order, each as `select` makes it (default: values, each variable's
 * term's value). The array is the same until the view changes; pass a `select` defined outside the
 * component (or memoized) to keep it so.
 */
export function useRows(handle: ViewHandle): readonly Values[]
export function useRows<T>(handle: ViewHandle, select: (row: Row) => T): readonly T[]
export function useRows<T>(handle: ViewHandle, select: (row: Row) => T = values as unknown as (row: Row) => T): readonly T[] {
  const s = sourceOf(handle)
  useSyncExternalStore(s.subscribe, s.current, s.current)
  return s.rows(select)
}
