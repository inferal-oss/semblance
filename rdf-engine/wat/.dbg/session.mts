// Debug only: a shell session on one store; ms/event per 100 events.
import '../../../src/behaviour/events.ts'
import { mountShell } from '../../../test/harness.ts'
const kind = (process.argv[2] ?? 'wat') as any
const n = Number(process.argv[3] ?? 400)
const h = mountShell(5, kind, 'sparql')
const { document, fire } = h
const box = () => document.querySelector('[data-sem-c=list-item] input') as HTMLInputElement
const field = () => document.querySelector('[data-sem-c=text-field] input') as HTMLInputElement
let t = performance.now()
for (let i = 1; i <= n; i++) {
  if (i % 2) { const b = box(); b.checked = !b.checked; fire(b, 'change') }
  else { const f = field(); f.value = 'w'.repeat((i % 7) + 1); fire(f, 'input') }
  h.runtime.warm(8)
  if (i % 100 === 0) {
    const now = performance.now()
    const extra = kind === 'wat' || kind === 'rust' ? ' terms ' + (h.store as any).termCount?.() : ''
    console.log(kind, 'events', i - 99, '-', i, ((now - t) / 100).toFixed(1), 'ms/event' + extra)
    t = now
  }
}
