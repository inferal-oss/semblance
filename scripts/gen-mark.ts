// Writes Semblance's mark as a standalone SVG (demo/favicon.svg), rendered by the
// c:GraphMark component from the ontology. test/mark.test.ts checks it is current.
import { writeFileSync } from 'node:fs'
import { renderMark } from '../src/mark.ts'
import { loadStore } from '../src/node/load.ts'

writeFileSync('demo/favicon.svg', renderMark(loadStore('n3')))
console.log('wrote demo/favicon.svg')
