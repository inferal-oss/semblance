// Trusted Types (docs/SAFETY.md): under `require-trusted-types-for 'script'` (the recommended
// Content-Security-Policy, src/server/csp.ts) a script sink takes only what a named policy made.
// Semblance writes no HTML and no script from a string - the renderer creates elements and sets
// attributes and text - so it runs under Trusted Types as it is. What a host loads as script itself
// (a worker) goes through Semblance's policy, which makes script URLs of the page's own origin only.

/** The name of Semblance's policy (the CSP's trusted-types directive lists it). */
export const TRUSTED_TYPES_POLICY = 'semblance'

interface ScriptUrlPolicy {
  createScriptURL(url: string): unknown
}
interface TrustedTypesLike {
  createPolicy(name: string, rules: { createScriptURL(url: string): string }): ScriptUrlPolicy
}

let policy: ScriptUrlPolicy | undefined

/**
 * A script URL a script sink takes under Trusted Types (`new Worker(scriptURL(url))`): the URL as is
 * where the browser has no Trusted Types; a URL of another origin is refused (a TypeError).
 */
export function scriptURL(url: string | URL): string | URL {
  const tt = (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes
  if (!tt) return url
  policy ??= tt.createPolicy(TRUSTED_TYPES_POLICY, {
    createScriptURL(u) {
      const here = globalThis.location?.href
      if (!here || new URL(u, here).origin !== new URL(here).origin) throw new TypeError(`Semblance loads scripts only from the page's own origin, not ${u}`)
      return u
    },
  })
  return policy.createScriptURL(String(url)) as string
}
