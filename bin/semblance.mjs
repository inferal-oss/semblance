#!/usr/bin/env node
// The semblance command (docs/SSR.md): build a site's static, pre-rendered pages; serve them,
// rendered per request; or render one address. The sources are TypeScript: tsx loads them.
import { register } from 'tsx/esm/api'

register()
await import('./semblance.ts')
