// What a package's manifest names (scripts/build-package.ts, scripts/pack-check.ts): the one list
// of its entries is its `exports` (and `bin`).

export interface Manifest {
  name: string
  exports: Record<string, string | Record<string, string>>
  bin?: Record<string, string>
}

/** Every file target of a package's exports, as written (`./lib/src/index.js`); wildcards and ./package.json left out. */
export function targets(manifest: Manifest): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(manifest.exports)) {
    if (key === './package.json') continue
    for (const target of typeof value === 'string' ? [value] : Object.values(value)) if (!target.includes('*')) out.push(target)
  }
  return out
}

/**
 * Aliases from a package's entries to their sources, for Vite and Vitest in this repository: the
 * output an export names (`./lib/src/web/index.js`) is built from the same path under `sources`
 * (`src/web/index.ts`). Wildcard entries map their pattern (`./wasm/*` → `rdf-engine/build/*`);
 * declarations-only entries need none.
 */
export function sourceAliases(manifest: Manifest, sources: string): { find: RegExp; replacement: string }[] {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const aliases: { find: RegExp; replacement: string }[] = []
  for (const [key, value] of Object.entries(manifest.exports)) {
    const target = typeof value === 'string' ? value : value.default
    if (key === './package.json' || !target?.startsWith('./lib/')) continue
    const source = sources.replace(/\/?$/, '/') + target.slice('./lib/'.length).replace(/\.js$/, '.ts')
    const name = manifest.name + key.slice(1)
    if (key.includes('*')) aliases.push({ find: new RegExp(`^${escape(name).replace('\\*', '(.+)')}$`), replacement: source.replace('*', '$1') })
    else aliases.push({ find: new RegExp(`^${escape(name)}$`), replacement: source })
  }
  return aliases
}
