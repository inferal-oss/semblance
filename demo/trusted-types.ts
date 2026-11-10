// The site under Trusted Types (its Content-Security-Policy is semblance.config.ts's csp; docs/SAFETY.md).
// Semblance itself needs only its own policy, for the workers' URLs (src/web/trusted-types.ts). The
// site adds two policies:
//   - "semblance-site": the page's own HTML, read from itself, as the document a benchmark cell of
//     the Performance view runs in (perf-runner.ts), and the inert parse below;
//   - "default": for the foreign libraries its examples mount (demo/foreign.ts: Leaflet, flatpickr,
//     Temml, Shoelace's icons), which write HTML from strings. What they write is parsed inertly (a
//     template) and stripped of what runs code or loads a document before it reaches the page.
// Without Trusted Types in the browser, nothing here does anything.

interface Policy {
  createHTML(html: string): unknown
}
interface TrustedTypesLike {
  createPolicy(name: string, rules: { createHTML(html: string): string }): Policy
}

const tt = (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes
const own = tt?.createPolicy('semblance-site', { createHTML: (html) => html })

/** The page's own HTML, as a srcdoc takes it. */
export const pageHTML = (html: string): string => (own ? (own.createHTML(html) as string) : html)

/** Elements that run code, load a document or change where the page's URLs point. */
const RUNS = 'script, iframe, frame, frameset, object, embed, applet, base, meta, link, noscript, portal'
/** A URL that runs code (an image's data: URL loads nothing that runs). */
const RUNNING_URL = /^[\u0000- ]*(?:javascript|vbscript|data(?![\u0000- ]*:[\u0000- ]*image\/))[\u0000- ]*:/i

/** HTML a library wrote, without what runs code or loads a document. */
function strip(html: string): string {
  const doc = document.implementation.createHTMLDocument('')
  const template = doc.createElement('template')
  template.innerHTML = own!.createHTML(html) as string
  const root = template.content
  for (const el of root.querySelectorAll(RUNS)) el.remove()
  for (const el of root.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const name = a.name.toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'is' || (/(?:^|:)(?:href|src|action|data)$/.test(name) && RUNNING_URL.test(a.value.replace(/[\t\n\r]/g, '')))) el.removeAttribute(a.name)
    }
  }
  return template.innerHTML
}

if (tt && own) tt.createPolicy('default', { createHTML: strip })
