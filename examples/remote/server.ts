// The store on its own, for a page served elsewhere: npx tsx examples/remote/server.ts
// (in development, vite.config.ts serves it under /store/ beside the page).
import { createServer } from 'node:http'
import { todoStore } from './store.ts'

const port = Number(process.env.PORT ?? 3100)
const handle = todoStore().handler('/store/')
createServer((req, res) => void (handle(req, res) || res.writeHead(404).end())).listen(port)
console.log(`http://localhost:${port}/store/changes`)
