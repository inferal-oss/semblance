// The Content-Security-Policy recommended for a page that renders Semblance, authored content
// above all (docs/SAFETY.md): scripts and style sheets from the page's own origin and the inline
// ones the document carries (by hash), nothing evaluated but WebAssembly (the engines), Trusted
// Types required for every script sink (Semblance never writes HTML or script from a string), and
// images, media, fonts and connections only from the page's origin and those the host lists. With
// it, markup that slipped past the policy still could not run, load or post anywhere else.
//
// The document helper (renderDocument, renderToStream) puts it in a <meta> at the top of <head>,
// with the hashes of the inline scripts and style elements the finished document has (its own and
// the template's); contentSecurityPolicy gives the same as a header value (with frame-ancestors,
// which a meta cannot carry).
import { base64, sha256 } from './sha256.ts'
import { TRUSTED_TYPES_POLICY } from '../web/trusted-types.ts'

export { TRUSTED_TYPES_POLICY }

export interface CspOptions {
  /** Origins scripts may come from besides the page's own (a CDN a foreign component loads from). */
  script?: string[]
  /** Origins stylesheets may come from (a font service). Style attributes stay allowed: Semblance's renderer writes them (#157). */
  style?: string[]
  /** Origins images may come from besides the page's own, data: and blob: (authored images name http(s) addresses). */
  img?: string[]
  /** Origins audio and video may come from besides the page's own, data: and blob:. */
  media?: string[]
  /** Origins fonts may come from. */
  font?: string[]
  /** Origins the page may connect to (remote sources, uploads elsewhere). */
  connect?: string[]
  /** Origins a frame may show. */
  frame?: string[]
  /** Trusted Types policies the page creates, besides Semblance's own ("semblance"); "default" for libraries that write HTML themselves. */
  trustedTypes?: string[]
  /** Hashes of inline scripts ('sha256-…'), besides those the document helper finds. */
  hashes?: string[]
  /** Hashes of inline style elements, besides those the document helper finds. */
  styleHashes?: string[]
  /** Where violations are reported (report-uri). */
  report?: string
  /** Other directives, as written (a directive given here replaces the recommended one). */
  directives?: Record<string, string>
}

/** The hash source of an inline script's or style element's text, as CSP compares it. */
export const scriptHash = (text: string): string => `'sha256-${base64(sha256(new TextEncoder().encode(text)))}'`

/** The hash sources of the inline scripts (no src) of an HTML document or part of one. */
export function inlineScriptHashes(html: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\ssrc\s*=/i.test(m[1]!) || /\stype\s*=\s*["']?(?:application\/json|application\/ld\+json|importmap|speculationrules|text\/plain)/i.test(m[1]!)) continue
    out.add(scriptHash(m[2]!))
  }
  return [...out]
}

/** The hash sources of the style elements of an HTML document or part of one (an inline SVG's too). */
export function inlineStyleHashes(html: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) out.add(scriptHash(m[1]!))
  return [...out]
}

/**
 * The recommended policy, as a header's value. `meta`: as a <meta http-equiv> carries it (without
 * frame-ancestors and report-uri, which it ignores).
 */
export function contentSecurityPolicy(opts: CspOptions = {}, meta = false): string {
  const list = (...xs: (string | undefined)[]) => xs.filter(Boolean).join(' ')
  const own = (more?: string[]) => ["'self'", ...(more ?? [])]
  const directives: Record<string, string> = {
    'default-src': "'self'",
    // The engine is WebAssembly: compiling it needs wasm-unsafe-eval (nothing else is evaluated).
    'script-src': list(...own(opts.script), ...(opts.hashes ?? []), "'wasm-unsafe-eval'"),
    // Constructed sheets (the compiled theme, each live example's) need only 'self'; style
    // elements the document carries are allowed by hash; the renderer's style attributes need inline (#157).
    'style-src': list(...own(opts.style), ...(opts.styleHashes ?? [])),
    'style-src-attr': "'unsafe-inline'",
    'img-src': list(...own(opts.img), 'data:', 'blob:'),
    'media-src': list(...own(opts.media), 'data:', 'blob:'),
    'font-src': list(...own(opts.font)),
    'connect-src': list(...own(opts.connect)),
    'frame-src': list(...own(opts.frame)),
    'worker-src': "'self'",
    'object-src': "'none'",
    'base-uri': "'none'",
    'form-action': "'self'",
    'require-trusted-types-for': "'script'",
    'trusted-types': list(TRUSTED_TYPES_POLICY, ...(opts.trustedTypes ?? [])),
    ...(meta ? {} : { 'frame-ancestors': "'self'", ...(opts.report ? { 'report-uri': opts.report } : {}) }),
    ...opts.directives,
  }
  return Object.entries(directives)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k} ${v}`)
    .join('; ')
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * A document's parts with the policy in a <meta> first in its <head>, listing the hashes of every
 * inline script and style element in them and in `inner` (what goes between them, when known: a
 * stream sends its head before the root's HTML exists).
 */
export function withCsp(parts: [string, string], opts: CspOptions, inner = ''): [string, string] {
  const all = [parts[0], parts[1], inner]
  const hashes = [...new Set([...(opts.hashes ?? []), ...all.flatMap(inlineScriptHashes)])]
  const styleHashes = [...new Set([...(opts.styleHashes ?? []), ...all.flatMap(inlineStyleHashes)])]
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(contentSecurityPolicy({ ...opts, hashes, styleHashes }, true))}">`
  // After the charset (which must stay in the first 1024 bytes), before anything that loads or runs.
  const head = /<head\b[^>]*>(\s*<meta\s+charset\b[^>]*>)?/i.exec(parts[0])
  if (!head) throw new Error('The template has no <head> for the Content-Security-Policy')
  const at = head.index + head[0].length
  return [parts[0].slice(0, at) + meta + parts[0].slice(at), parts[1]]
}
