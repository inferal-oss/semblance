// The example's components: plain React, each reading one view (useRows). A change to the store
// re-renders the components whose view it changed, and only those.
import type { ViewHandle } from '@inferal-oss/semblance/views'
import { useRows } from '@inferal-oss/semblance-react/views'

export const renders = { open: 0, counts: 0 }

export function OpenTodos({ view }: { view: ViewHandle }) {
  renders.open++
  const rows = useRows(view)
  return (
    <ul aria-label="Open todos">
      {rows.map((r) => (
        <li key={r.todo}>{r.label}</li>
      ))}
    </ul>
  )
}

export function Counts({ view }: { view: ViewHandle }) {
  renders.counts++
  const rows = useRows(view)
  const n = (done: boolean) => rows.find((r) => r.done === String(done))?.n ?? '0'
  return (
    <p role="status">
      {n(false)} open, {n(true)} done
    </p>
  )
}

export function App({ open, counts }: { open: ViewHandle; counts: ViewHandle }) {
  return (
    <main>
      <h1>Todos</h1>
      <Counts view={counts} />
      <OpenTodos view={open} />
    </main>
  )
}
