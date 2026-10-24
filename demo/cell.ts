import { CONFIGS, runBench } from '../bench/scenarios.ts'
import { initWeb, loadStore } from '../src/web/load.ts'
import { CELL_PREFIX } from './cell-protocol.ts'

// One benchmark cell: parameters arrive in window.name, rows go back to the parent.
const { id, config: configId, size } = JSON.parse(window.name.slice(CELL_PREFIX.length)) as { id: string; config: string; size: number }
const post = (message: object) => parent.postMessage({ source: 'semblance-bench', id, ...message }, '*')

try {
  const config = CONFIGS.find((c) => c.id === configId)
  if (!config || !size) throw new Error(`Bad cell: ${window.name}`)
  document.body.replaceChildren()
  const stage = document.body.appendChild(document.createElement('div'))
  stage.style.cssText = 'position:absolute;left:-10000px;top:0;width:600px'
  await initWeb()
  const rows = await runBench({ name: 'browser', loadStore, host: () => stage.appendChild(document.createElement('div')), log: () => {} }, [size], [config])
  post({ rows })
} catch (e) {
  post({ error: String((e as Error).stack ?? e) })
}
