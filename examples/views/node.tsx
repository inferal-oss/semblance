// The same views in Node: the todo store served over HTTP, followed into views, rendered to HTML
// with React after the snapshot and after each change the store sends.
//   npx tsx examples/views/node.tsx
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
// In this repository the entry is imported from its source (Node's half of it); an app imports
// '@inferal-oss/semblance/views', whose `node` condition is this file.
import { followSource, httpTransport, openViews } from '../../src/views/node.ts'
import { DataFactory } from 'n3'
import { renderToString } from 'react-dom/server'
import { todoStore } from '../remote/store.ts'
import { App } from './Todos.tsx'
import { EX, patterns, todoViews } from './todos.ts'

const server = todoStore()
const handle = server.handler('/store/')
const http = createServer((req, res) => void (handle(req, res) || res.writeHead(404).end())).listen(0)
await new Promise((r) => http.once('listening', r))
const url = `http://localhost:${(http.address() as AddressInfo).port}/store/`

const views = await openViews({ kind: 'wat' })
const { open, counts } = todoViews(views)
let delivered = () => {}
const source = followSource(views, httpTransport({ url }), { patterns, onChange: () => delivered() })
await source.ready
const show = (what: string) => console.log(`${what}:\n  ${renderToString(<App open={open} counts={counts} />)}\n`)
show('The snapshot')

// Another client changes the store: each change reaches the views as one delta.
const { namedNode: nn, literal, quad } = DataFactory
const bool = (v: boolean) => literal(String(v), nn('http://www.w3.org/2001/XMLSchema#boolean'))
const next = () => new Promise<void>((r) => (delivered = r))
let arrived = next()
server.change({ add: [quad(nn(EX + 't2'), nn(EX + 'done'), bool(true))], remove: [quad(nn(EX + 't2'), nn(EX + 'done'), bool(false))] })
await arrived
show('t2 done')
arrived = next()
const t4 = nn(EX + 't4')
server.change({
  add: [
    quad(t4, nn('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), nn(EX + 'Todo')),
    quad(t4, nn('http://www.w3.org/2000/01/rdf-schema#label'), literal('Ship the views entry')),
    quad(t4, nn(EX + 'done'), bool(false)),
    quad(t4, nn(EX + 'created'), literal('2026-11-04T09:00:00Z', nn('http://www.w3.org/2001/XMLSchema#dateTime'))),
  ],
  remove: [],
})
await arrived
show('t4 added')
console.log(`View work: ${views.runtime.totals.rowsIn} rows in over ${views.tick} ticks`)
source.stop()
http.close()
views.dispose(true)
