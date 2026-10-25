import { md5Key } from '../src/components/data.ts'
import { NS } from '../src/ns.ts'
import { mountShell } from './harness.ts'

const UI = 'https://semblance.dev/demo#'
const c = NS.c

/** A column's key in the IRIs the grid mints for it. */
export const key = (iri: string) => md5Key(iri)

/** The shell on the Components page, showing the Data gallery group. */
export function showGrids(prefer: 'sparql' | 'function' = 'sparql') {
  const h = mountShell(5, 'oxigraph', prefer)
  const f = h.store.factory
  const app = f.namedNode(UI + 'app')
  const group = f.namedNode(UI + 'galleryGroup')
  h.showPage('Components')
  h.runtime.apply({ remove: h.store.match(app, group, null), add: [f.quad(app, group, f.namedNode(UI + 'GroupData'))] })
  h.shell.flush()
  const node = (iri: string) => ([...h.document.querySelectorAll('*')].find((el) => h.shell.keyOf(el) === iri) ?? null) as HTMLElement | null
  const root = (local: string) => node(`${UI}${local}/~root`)!
  const part = (local: string, name: string) => node(`${UI}${local}/~${name}`)
  const values = (s: string, p: string) => h.store.match(f.namedNode(s.startsWith('http') ? s : UI + s), f.namedNode(p.startsWith('http') ? p : c + p), null).map((q) => q.object.value)
  const click = (el: Element) => (h.fire(el, 'click'), h.shell.flush())
  /** The grid's rows, top to bottom, as their first cells' text. */
  const rows = (grid: string) => [...root(grid).querySelectorAll('tbody > tr[role=row]')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent).join(' '))
  return { ...h, f, node, root, part, values, click, rows }
}
