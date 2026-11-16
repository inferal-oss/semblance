// What the visitor chose, before the first paint. A server-rendered page shows the graph's defaults;
// the client restores the visitor's choices (src/persistence.ts) only once its module has run, too
// late: the page would be painted one way and then flip. Colours are light-dark() pairs and themes
// are attributes over one stylesheet, so nothing needs rendering twice: only the switches have to
// be right when the page is first painted. The inline script in the head (src/server/document.ts)
// sets them from what the policies in the graph stored (src/server/remembered.ts says where): on
// <html> at once, on the mounted root and on the controls bound to those properties as the parser
// reaches them (a mutation observer's callback runs before the browser can paint what it adds). The
// client then finds the page as its own projection has it, and changes nothing.

/** A rendered chooser bound to a remembered property says which (`<subject> <property>`): per:RememberedChooser. */
export const REMEMBERED_ATTRIBUTE = 'data-sem-remembered'

/** A template's own color scheme meta, which the document does not add a second of. */
export const COLOR_SCHEME_META = /<meta\s[^>]*name=["']?color-scheme\b/i

/** A hooked property of a subject the page can set, with its values' slugs. */
export interface RememberedHook {
  subject: string
  property: string
  attribute: string
  /** The attribute's value for each of the property's values. */
  values: Record<string, string>
  /** On the document, the CSS color-scheme each value declares (sty:declares), for the empty page's <meta>. */
  schemes?: Record<string, string>
  /** On <html> (the document's attributes say so), else on the mounted root. */
  document?: true
}

/** What the head script needs to know of a per:Policy. */
export interface FirstPaintPolicy {
  iri: string
  /** The Web Storage object its scope keeps its strings in. */
  storage: string
  version: string
  retentionMs?: number
  /** Turned off in the graph (per:enabled false), unless the visitor turned it on. */
  off?: true
  hooks: RememberedHook[]
}

export interface FirstPaintPlan {
  mount: string
  /** What stored keys start with. */
  prefix: string
  /** The key on the device that keeps the policies' switches. */
  enabled: string
  policies: FirstPaintPolicy[]
}

const SCRIPT = `(p=>{try{let f={};try{f=JSON.parse(localStorage.getItem(p.enabled)||"{}")}catch{}const w=[];for(const y of p.policies){if(f[y.iri]===false||y.off&&f[y.iri]!==true)continue;let b;try{b=JSON.parse(globalThis[y.storage].getItem(p.prefix+y.iri))}catch{}if(!b||b.version!==y.version||b.chunks||y.retentionMs!==undefined&&Date.now()-b.savedAt>y.retentionMs)continue;for(const l of String(b.nt).split("\\n")){const m=/^<([^>]*)> <([^>]*)> <([^>]*)>/.exec(l);if(m)for(const h of y.hooks)if(h.subject===m[1]&&h.property===m[2]&&Object.hasOwn(h.values,m[3]))w.push([h,m[3]])}}if(!w.length)return;const d=document,r=d.documentElement,t=(e,a,v)=>{if(v===null)e.hasAttribute(a)&&e.removeAttribute(a);else if(e.getAttribute(a)!==v)e.setAttribute(a,v)},g=()=>{for(const[h,v]of w){const e=h.document?r:d.getElementById(p.mount)?.firstElementChild;if(e)t(e,h.attribute,h.values[v]);for(const c of d.querySelectorAll("[${REMEMBERED_ATTRIBUTE}]")){if(c.getAttribute("${REMEMBERED_ATTRIBUTE}")!==h.subject+" "+h.property)continue;for(const o of c.querySelectorAll("[value]")){const n=o.getAttribute("value")===v,k=o.localName;if(k==="option")t(o,"selected",n?"":null);else if(k==="input")t(o,"checked",n?"":null);else t(o,"aria-pressed",String(n))}}}};for(const[h,v]of w){const s=h.document&&h.schemes&&h.schemes[v],m=s&&d.querySelector('meta[name="color-scheme"]');if(m)m.content=s}g();const o=new MutationObserver(g);o.observe(r,{childList:true,subtree:true});d.addEventListener("DOMContentLoaded",()=>o.disconnect(),{once:true})}catch{}})`

/** The inline script for a plan. Small and dependency-free: it runs before anything is painted, and a failure leaves the graph's defaults. */
export function rememberedScript(plan: FirstPaintPlan): string {
  // Inside <script>: nothing in the data may close it.
  return `${SCRIPT}(${JSON.stringify(plan).replace(/</g, '\\u003c')})`
}
