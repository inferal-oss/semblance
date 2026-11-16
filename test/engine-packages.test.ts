// The engine builds as packages of their own (@semblance-dev/rdf-engine-wat, -rust; docs/RELEASING.md):
// what each exports in this repository, the ABI check the core makes before it loads one, and the
// browser's engine list (the rust build added by the app). The tarballs are checked by
// scripts/pack-check.ts.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as rust from '@semblance-dev/rdf-engine-rust'
import * as wat from '@semblance-dev/rdf-engine-wat'
import { describe, expect, it, vi } from 'vitest'
import { ABI_VERSION } from '../rdf-engine/host/engine.ts'
import { checkedBuild, ENGINE_PACKAGES, isMissingPackage } from '../src/store/engine-build.ts'

describe('engine packages', () => {
  it('each names its kind, the host ABI and its build', () => {
    for (const [build, kind] of [
      [wat, 'wat'],
      [rust, 'rust'],
    ] as const) {
      expect(build.kind).toBe(kind)
      expect(build.abi).toBe(ABI_VERSION)
      expect(build.wasm.protocol).toBe('file:')
      expect(existsSync(fileURLToPath(build.wasm))).toBe(true)
    }
  })

  it('a build of another ABI or kind is refused, naming the package to install', () => {
    expect(checkedBuild('wat', wat, ABI_VERSION)).toBe(wat)
    expect(() => checkedBuild('wat', { ...wat, abi: ABI_VERSION + 1 }, ABI_VERSION)).toThrow(`${ENGINE_PACKAGES.wat} implements engine ABI ${ABI_VERSION + 1}; @semblance-dev/semblance runs ABI ${ABI_VERSION}`)
    expect(() => checkedBuild('rust', wat, ABI_VERSION)).toThrow(`${ENGINE_PACKAGES.rust} is the wat engine build`)
  })

  it('a missing optional package is told apart from a failing one', () => {
    const missing = Object.assign(new Error(`Cannot find package '${ENGINE_PACKAGES.rust}' imported from /app/node_modules/@semblance-dev/semblance/lib/src/node/stores.js`), { code: 'ERR_MODULE_NOT_FOUND' })
    expect(isMissingPackage(missing, ENGINE_PACKAGES.rust)).toBe(true)
    expect(isMissingPackage(Object.assign(new Error(`Cannot find package 'other'`), { code: 'ERR_MODULE_NOT_FOUND' }), ENGINE_PACKAGES.rust)).toBe(false)
    expect(isMissingPackage(new Error('engine ABI 2, host expects 3'), ENGINE_PACKAGES.rust)).toBe(false)
  })

  it('in the browser, the wat build is there and the rust one once the app adds it', async () => {
    vi.resetModules()
    const engine = await import('../src/web/engine.ts')
    expect(engine.hasEngine('wat')).toBe(true)
    expect(engine.hasEngine('rust')).toBe(false)
    await expect(engine.engineBuild('rust')).rejects.toThrow(`install ${ENGINE_PACKAGES.rust} and call addEngine('rust', () => import('${ENGINE_PACKAGES.rust}'))`)
    engine.addEngine('rust', () => import('@semblance-dev/rdf-engine-rust'))
    expect(engine.hasEngine('rust')).toBe(true)
    expect((await engine.engineBuild('rust')).kind).toBe('rust')
    expect((await engine.engineBuild('wat')).kind).toBe('wat')
  })
})
