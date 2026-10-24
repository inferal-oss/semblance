// Runs one (config, size) pair; spawned by bench/node.ts so that runs do not
// share a heap (earlier stores and WASM term wrappers skew later runs).
// reactions.ts and persistence.ts import each other; entering through the event
// bus (as the app and the tests do) initializes them in a working order.
import '../src/behaviour/events.ts'
import { loadStore } from '../src/node/load.ts'
import { runMicro } from './micro.ts'
import { CONFIGS, runBench } from './scenarios.ts'

const [mode, a, b] = process.argv.slice(2)
if (mode === 'micro') {
  console.log('RESULT:' + JSON.stringify(await runMicro()))
} else {
  const config = CONFIGS.find((c) => c.id === a)
  if (!config) throw new Error(`Unknown config "${a}"`)
  const rows = await runBench({ name: 'node', loadStore, log: (l) => console.error(l) }, [Number(b)], [config])
  console.log('RESULT:' + JSON.stringify(rows))
}
