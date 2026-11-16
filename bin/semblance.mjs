#!/usr/bin/env node
// The semblance command (docs/SSR.md): build a site's static, pre-rendered pages; serve them,
// rendered per request; or render one address. The package runs its build (lib/bin/semblance.js);
// this repository, which has the sources beside this file, runs them. Either way tsx is registered:
// a site's own semblance.config.ts is TypeScript.
import { existsSync } from 'node:fs'
import { register } from 'tsx/esm/api'

register()
const source = new URL('./semblance.ts', import.meta.url)
await import(existsSync(source) ? source.href : new URL('../lib/bin/semblance.js', import.meta.url).href)
