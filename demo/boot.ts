performance.mark('sem:boot')
// Entry point. The same document boots either the app or, inside a hidden
// srcdoc iframe owned by the Performance view, a single benchmark cell - so
// cells run in a fresh realm even when the whole demo is one HTML file.
import { CELL_PREFIX } from './cell-protocol.ts'
import { hasEngine, startEngine } from '../src/web/engine.ts'

// The engine (main.ts's default store, or the one the address asks for) is fetched and compiled
// while the bundles download, not after them.
const store = new URLSearchParams(location.search).get('store') ?? 'wat'
if ((store === 'wat' || store === 'rust') && hasEngine(store)) void startEngine(store).catch(() => {})

if (window.name.startsWith(CELL_PREFIX)) {
  await import('./cell.ts')
} else {
  // The untouched document, re-used as the srcdoc of benchmark cells.
  ;(window as unknown as { semblancePristine: string }).semblancePristine = '<!doctype html>\n' + document.documentElement.outerHTML
  await import('./main.ts')
}
