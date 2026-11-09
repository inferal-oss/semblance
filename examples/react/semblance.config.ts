// The example as a site (docs/SSR.md): its page rendered at build time, the design system's markup
// included (React's renderToString), and hydrated by the client (main.ts) with the same components.
import { readFileSync } from 'node:fs'
import { defineSite } from '@inferal-oss/semblance/node'
import { reactHosts } from '@inferal-oss/semblance-react/server'
import { todoApp } from '../../src/examples/todo.ts'
import { components } from './design-system.tsx'

const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')

export default defineSite({
  root: 'https://example.org/react#shell',
  graphs: () => [todoApp(5), read('bindings.ttl'), read('app.ttl')],
  hosts: reactHosts({ components }),
})
