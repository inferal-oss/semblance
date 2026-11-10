# Safe authoring

A Semblance interface is a graph, and a graph can come from someone you do not trust: a person
typing in a live example, a page, a model. **Authored content** is rendered under a policy, so that
Turtle and SPARQL describe an interface without running code or reaching outside what it renders. The policy is vocabulary (`ontology/layers/safety.ttl`), applied in one place every
output reads from.

This guide covers who decides what is authored, what an authored graph may and may not do, how the
check works, how to extend or narrow the policy, what it does not cover and what to put around it.
The worked examples at the end are each backed by a test. The site's docs have the same guide, with
a live example to edit: [Safe authoring](https://semblance.dev/docs/safety/)
(`demo/gallery/_docs.ttl`, `ui:DocSafety`).

## Trusted and authored

Trust is the host's decision, never the graph's: no triple makes a graph trusted.

- **Trusted:** the framework's ontology, the themes, and your app's own Turtle (`mount`'s `graphs`,
  a site's graphs). Rendered as written.
- **Authored:** everything else you render. The live example editors always run authored. In your
  own app, pass the author's Turtle as `authored` (it is loaded after `graphs`):

  ```ts
  await mount(element, { root, graphs: [appTtl], authored: [fromTheModel], onRefused: (e) => report(e.message) })
  ```

  or give a projection the policy yourself: `runtime.project({ …, policy: authoredPolicy(trusted) })`,
  `renderToString({ …, policy })`, `compileStyles(store, { policy, onRefused })`.

The policy is read from a **trusted** store: one with the ontology and your own graphs, and not the
author's, which could add to its lists. `mount` reads it from a store of `graphs` alone, kept apart
from the one `authored` is loaded into; the live examples read it from the ontology alone;
`authoredPolicy` and `readPolicy` take the store you trust.

Authored is a property of a **projection**, not of triples. A projection with a policy checks
everything it renders, your own components included: in `mount({ authored })` your app's graphs and
the author's are one store and one projection, and the policy applies to both. Being in one store
also means the author's triples can describe your resources (add a child to your page, change a
label) and its reactions can change any state of the store. What the host's effects do is not part
of that: they read their configuration from the trusted store alone ([below](#what-it-may-not-do)).
When the rest matters, give the author a store of its own, as the live examples do
([Sandboxes](#live-examples-run-in-sandboxes)).

## What an authored graph may do

- Render any element of the framework's components and of your own, built from the elements
  `safe:Authored` lists (`safe:element`): text, headings, lists, tables, forms and their controls,
  `details`, `dialog`, images, audio and video, the SVG extension's elements.
- Give them attributes from `safe:attribute`, and any `data-…` or `aria-…` one but the framework's
  own hooks (below).
- Refer to its own elements by id: `for`, `form`, `list`, `commandfor`, `popovertarget`, `headers`,
  `itemref`, the ARIA relationships (`aria-labelledby`, `aria-controls`, …) and a link to `#id` must
  name ids that elements of the same rendering have (`safe:idReferenceAttribute`,
  `safe:idReferenceListAttribute`, `safe:fragmentAttribute`). The framework's components mint their
  ids from their IRIs, so their ARIA relationships hold.
- Link and load by URL when the URL is relative, a fragment, or `http:`, `https:`, `mailto:` or
  `tel:`; an image, audio or video source (`src`, `srcset`, `poster`) may also be `data:image/…` or
  `blob:`.
- **Remote resources, the one rule:** an `http(s)` address appears only in an attribute: a link,
  followed when a person follows it, or an image, audio or video source, loaded as it renders, as in
  any page. The policy limits their schemes; a CSP limits their origins (`img-src`, `media-src`).
  CSS loads nothing from an address, since a style rule reaches beyond the element it is written for
  and loads on states (a hover) that render nothing to check.
- Style with `sty:StyleRule`s, tokens and keyframes, and `style` attributes, whose values pass the
  CSS check below; `url()` of a fragment (`url(#gradient)`) or of a `data:image/…` loads nothing from
  elsewhere and is allowed.
- Define classes, renderings, SPARQL rules, reactions and shapes: they only produce triples, and
  what they produce is checked.
- Have a component drawn by a host component library ([HOSTED.md](HOSTED.md)) only by a host
  component (`safe:hostComponent`) or custom element (`safe:customElement`) the policy lists, none by
  default; any other renders as its projected element.
- Mount a foreign component ([FOREIGN.md](FOREIGN.md), `ext:Island`) only by what the policy lists,
  none by default: its custom element (`safe:customElement`), widget (`safe:widget`), module
  (`safe:module`) and, beyond the built-in custom element and widget adapters, its adapter
  (`safe:adapter`). Any other is not mounted: its slot stays its projected element, empty, and it is
  reported. This holds in the DOM (`mount` gives the islands effect its policy, and the effect reads
  the index's by default), in the HTML a server writes and on take-over.
- Give an island or a custom element inputs (`ext:input`): an attribute input (`ext:Attribute`)
  passes the attribute check, as any authored attribute does; a property input (`ext:Property`, the
  default) only names a property in `safe:property`, none by default. A property that takes markup
  (`innerHTML`, `outerHTML`, `srcdoc`, `dangerouslySetInnerHTML`), an event handler (`on…`), React's
  own props (`ref`, `key`, `children`) and prototype names are never set, listed or not. An input
  name that is not an attribute name is never written, trusted or not.

## What it may not do

- **No element that runs or embeds:** `script`, `iframe`, `object`, `embed`, `base`, `link`, `meta`,
  `style`, `noscript`, `template`, `slot`, nor `html`, `head`, `body` or `title`.
- **No attribute outside the list:** no event handler (`on…`), `srcdoc`, `is`, `nonce`, `ping`,
  `http-equiv`, `sandbox`, `allow`, `integrity`, `shadowrootmode`, `referrerpolicy` (the page's own
  policy decides what an address is told).
- **No reach into the host's page by id:** authored content renders in the host's document, so an id
  reference to an id the rendering does not have (the host's login form, its theme picker) is left
  out.
- **No framework hooks the host sets:** `data-sem-…` is refused (`safe:refusedAttributePrefix`), but
  for the hooks the framework's components render, which `safe:Authored` lists (an authored graph has
  them by using the component); `data-sem-sandbox`, `data-sem-ssr` and the other hooks the host sets
  are not among them. `data-sem-anchor` and `data-sem-origin` name ids, and are held as id
  references.
- **No `opener`:** a link's `rel` may not hold `opener` (`safe:refusedLinkType`), so a page it opens
  does not get the host's window.
- **No other URL scheme:** no `javascript:`, `vbscript:`, `data:` (but an image's) or `file:`, however
  it is spelled (case, spaces, tabs and newlines are read as a browser reads them).
- **No CSS that loads or escapes:** no `url()` to an address, `image-set()`, `image()`,
  `cross-fade()`, `element()`, `src()`, `paint()` or `expression()`; no `{`, `}`, `@`, `<` or `;` that
  would start another rule or at-rule (`@import`), no escape outside a string (an escape can spell
  `url`), quotes and brackets that balance; no `behavior` or `-moz-binding`. The same holds for every
  string the style compiler writes from the graph: properties, values, slugs, parts, states, media
  conditions, keyframe names and steps.
- **CSS is read as the browser tokenizes it** (css-syntax-3), in one pass, linear in its length:
  strings end where the browser ends them; an unquoted `url(` is one url token up to its `)`; a name
  after a number or a `#` calls no function. What the check could read otherwise than the browser is
  refused: a comment, a string a newline ends, and a bad url (an unquoted `url(` holding a quote,
  `(`, `\`, a control character or a space before its end).
- **No reaching outside the authored box:** a part, state or media condition may not name `&` or
  `:scope`. Authored styles stay in the element the content renders in
  ([The authored box](#the-authored-box)).
- **No upload elsewhere:** `file:uploadTo` posts only to the page's own origin, or to an origin the
  host lists (`files: { uploadOrigins: ['https://uploads.example.com'] }`); this holds whether or
  not the graph is authored, since the graph says where and the host says where may be.
- **No store elsewhere:** a remote source (`src:Source`, [REMOTE.md](REMOTE.md)) names no endpoint
  in the graph at all: the host maps each source's IRI to its URL and credentials, and a source it
  does not map stays `src:Unbound`. An authored graph cannot point a source anywhere.
- **No fetching:** SPARQL `SERVICE` and `LOAD` run only in the host's own `store.fetching`
  calls, under the host's list of endpoints and documents ([FETCHING.md](FETCHING.md)). A rule,
  view or reaction that uses them fails and fetches nothing, and a `SERVICE ?endpoint` whose
  endpoint an author wrote is checked against that list like any other.
- **No reconfiguring the host's effects:** under `mount({ authored })` the effects read their
  configuration from the trusted graphs alone (`app.trusted`, a store of the ontology and `graphs`):
  remote sources (`src:`), the location and whether there is one (`nav:`), where and by what a drop
  uploads (`file:uploadTo`, `file:handler`), which module an island loads (`ext:module`), and, when
  you attach persistence with `{ trusted: app.trusted }`, its policies and their storage keys
  (`per:`). An authored graph cannot add a source or widen one, turn navigation on or add a
  dimension, pick an upload handler, have a module loaded, or name a stored key. It changes state
  (the values the effects carry), as the interface does.

Authored rules read the whole store: your graphs as well as the author's. What an author must not
see (a token, someone else's data) does not belong in the store they render from.

## The authored box

Authored content renders in an element of its own, the **authored box**, marked `data-sem-sandbox`:
a live example's sandbox, the element `mount({ authored })` renders into, the mount element of a
page `renderToString({ policy })` rendered. One scoping applies in all three
(`scopedCss`, `src/style/scope.ts`):

- The trusted stylesheet (the ontology and your own graphs) is the page's. Every style rule the
  authored graphs add, or change, is rewritten so that each of its selectors starts at the box
  (`[data-sem-sandbox="…"] p`); `:root` is the box itself, and a selector that starts at a sibling
  (`~ p`, `+ p`) is left out. A rule with no `sty:appliesTo`, or an authored class given a framework
  slug, styles only what is in the box.
- Keyframes the authored graphs add are renamed for the box, as are the animations of its rules
  that name them: a framework animation keeps its own keyframes outside.
- The box has `contain: layout paint` (a rule of `ontology/layers/safety.ttl`): fixed and absolute
  positions resolve to it rather than to the page, and what is drawn outside it is clipped (beyond
  a margin of `--sem-space-3`, so a focus ring at its edge shows). The top
  layer (a modal `dialog`, a popover) is not contained by it.

`renderToString({ policy, trusted })` takes the store the policy was read from, whose stylesheet is
the page's; without it the whole stylesheet is scoped to the box. `Rendered.box` names the box, and
`renderDocument` marks the mount element with it, so `mount` takes it over in the same box.

### In a shadow root

`mount(element, { authored, isolate: 'shadow' })` renders into a box in a shadow root of `element`,
and the browser keeps the boundary: the author's ids, `form`, `popovertarget` and `commandfor`
references, named elements and style rules stop at it, and nothing outside reaches in by selector.
The whole stylesheet (the trusted one with the author's additions) is adopted by the shadow root,
scoped to the box, so `:root` is the box there too; the page's own sheet is not touched. Custom
properties still inherit from the page through the host element.

Events, focus and keys work as in the light DOM: the event bus reads an event's own target inside
the shadow root (`composedPath`), and the element that has the focus inside it. HTML a server
rendered into `element` is not taken over (it is rendered anew in the shadow root). It works for a
trusted graph as well (`graphs` with `isolate`), for an app that should not share the page's
document.

### The framework's globals

A document shows some elements by `name` as its own properties, ahead of its methods, and a window
every element by `id`: `<img name="adoptedStyleSheets">` is `document.adoptedStyleSheets`.
Semblance reads what it needs of the document and the global object from their prototypes, or as
properties a script set (`src/web/builtins.ts`): adopted style sheets, `getElementById`, the events
the capture script keeps before take-over. So an authored name cannot break a mount or the next
live example. The host's own scripts are another matter (Not covered, below).

## How it works

### The policy is a graph, read once

`safe:Authored` is a `safe:Policy` in `ontology/layers/safety.ttl`: lists of element classes
(`safe:element`), attribute names and prefixes (`safe:attribute`, `safe:attributePrefix`), which
attributes hold URLs (`safe:urlAttribute`, `safe:urlListAttribute` for `srcset`) and which of those
load a resource (`safe:resourceAttribute`), URL schemes (`safe:scheme`, and `safe:resourceScheme`
for resources only), which attributes hold CSS (`safe:styleAttribute`, `safe:cssValueAttribute` for
SVG paints), the CSS functions that fetch (`safe:fetchingFunction`) and the properties that bind
code (`safe:refusedProperty`), and the host components and custom elements an author may name.

`readPolicy(store, iri = safe:Authored)` (`src/safety.ts`) reads those triples from a store into a
`SafetyPolicy` of plain sets; it throws when the IRI is not a `safe:Policy` there.
`authoredPolicy(store)` does the same for `safe:Authored`, once per store. From then on the policy is
data in the host, and nothing the author adds to a store changes it.

### One check, in the HTML index

Every projection writes its RDF/HTML into an `HtmlIndex` (`src/render/html-index.ts`), and every
output reads the index, never the triples. A projection with a policy (`runtime.project({ policy })`)
gets an index with that policy, and the index answers each question under it:

| the index's answer | under a policy |
|---|---|
| `tagName(node)` | `sem-refused` for an element class the policy does not list; a custom element (`ext:tag`) only if it lists it |
| `attributes(node)` | each attribute checked by name (and a `rel` by its link types), then its URL, `srcset` or CSS; an id reference only if the projection mints that id; a refused element has only `data-sem-refused` |
| `childrenOf(node)` | nothing under a refused element |
| `hostComponent(node)` | the host component (`ext:component`) only if the policy lists it |
| `isSvg`, `isVoid` | false for a refused element (it is created as an empty `sem-refused`) |

What reads it gets the same answer: the DOM patcher (`DomRenderer`: creating, patching, and taking
over server-rendered HTML, which compares the page against the index), `toHTML`, `toIndentedHTML` and
`toText` (`src/render/serialize.ts`), server rendering (`renderToString`, `renderToStream`), the live
examples' prerendered HTML, and a host component adapter (`hostedBy`, `src/render/hosts.ts`, asks the
index which component draws a node). A site (`defineSite`, the static build and the request handler)
renders its own graphs, which are trusted, and its live examples under the policy. A SPARQL rule and its function
twin produce the same triples, which are checked after, so parity is unchanged.

The index checks as a delta arrives, not when a node is first shown: an element whose class or
attributes changed is checked in `apply`, so a refusal in a part of the page that is hidden is
reported too. An id reference is held until the id it names is minted in the same projection, and
dropped again when that element goes. A relative URL is checked as written, then resolved against the site's base
(`nav:base`).

One check holds for trusted projections as well: an attribute node whose name is no attribute name
(a space, a quote, `<`, `>`, `/`, `=`) is left out and reported, since it would break the markup it is
written in.

### Styles, in the style compiler

Styles do not go through the index: `compileStyles(store, { policy, onRefused })`
(`src/style/compile.ts`) writes the stylesheet from `sty:` rules, tokens and keyframes, and under a
policy checks every string it takes from the graph before writing it: a property against
`safe:refusedProperty`, a value, selector part, state or media condition with the CSS scan
(`cssProblem`), a slug or keyframe name and step against their grammar. A declaration that fails is
left out of its rule; a rule whose selector or condition fails is left out whole. `style` attributes
are checked by the index, as declarations (`declarationsProblem`). Where authored content has a box,
the host then scopes what the authored graphs added to the stylesheet to it (`scopedCss`).

The CSS scan (`scan` in `src/safety.ts`) reads the text as the css-syntax-3 tokenizer does, in one
pass, far enough to know it stays a value: strings close where the browser closes them, brackets
balance, no comment, no `{`, `}`, `@` or `<` anywhere and no `;` outside a declaration list, no
backslash outside a string, no bad url, and a function from `safe:fetchingFunction` only as `url()`
of a fragment or of a `safe:resourceScheme`. In a selector part, state or media condition, also no
`&` or `:scope`.

### Uploads, host components, islands, remote sources

- **Uploads** are checked by the files effect, not the policy, for every graph: `uploadRefused`
  (`src/files.ts`) allows an `http(s)` address on the page's own origin or one in `uploadOrigins`
  (`"*"` allows any, for a host that trusts its graph). A refused upload is not sent; its file gets a
  `file:Failure` event with the reason ("Files are not uploaded to https://evil.example: this page
  does not allow it."), and its reaction sets the file's `file:state` to `file:Failed` with that
  `file:reason`, and announces it.
- **Host components and custom elements** ([HOSTED.md](HOSTED.md)) are asked of the index, so an
  authored projection draws one only if `safe:hostComponent` or `safe:customElement` lists it, and a
  host adapter must also have it. The attributes it is given are the index's, already checked.
- **Islands** (`ext:Island`, [FOREIGN.md](FOREIGN.md)) are checked by the islands effect against the
  policy (`islandProblem`, `src/foreign.ts`), and their inputs by the index (`inputProblem`); the
  server and take-over ask the same. A refused island stays its projected element, empty, and is reported. Even a listed one
  mounts only what the host registered by name: the graph names one, it cannot bring one.
- **Remote sources** ([REMOTE.md](REMOTE.md)) have no endpoint in the graph.

### What happens to what is refused

Nothing is dropped silently.

| refused | DOM and HTML | text | report (`Refused.kind`) |
|---|---|---|---|
| an element | an empty `<sem-refused data-sem-refused="script">`, without its attributes or children | nothing | `element`, once, as it arrives |
| a host component or custom element | the projected element, drawn by Semblance | as usual | `element`, once |
| an island, or an input to it | the island's slot, empty; the input is not set | as usual | `element` or `attribute`, once |
| an id reference to an id the projection does not mint | the attribute is left out | - | `attribute`, once |
| an attribute | left out; the element stays | - | `attribute`, once |
| a URL | its attribute is left out; the element stays | - | `url`, once |
| a CSS value in a `style` attribute | the attribute is left out | - | `style`, once |
| a style declaration | left out of the sheet | - | `style`, once |
| a style rule's selector or condition | the rule is left out | - | `style`, once |
| an upload elsewhere | not sent; the file is `file:Failed` with the reason | - | the file's state |
| a turn over a work budget | what was complete; the rest keeps its last rendering | as usual | `budget`, once per turn |

A refused element keeps its place among its siblings, empty, so the gap shows in the inspector and in
tests. The drag-and-drop layer uses `data-sem-refused` for a refused drop as well, and its theme
animates both (#405).

Reports are `Refused` errors (`src/safety.ts`), with `at` (the node's IRI, or the style rule's),
`kind` and a message such as `Refused on <https://example.org/evil#it/~x>: authored content may not
have a script element.` Where they go:

- **`mount`**: to `onRefused`, by default `console.warn('[semblance]', message)`, from both the
  projection and the stylesheet.
- **`runtime.project(opts, onError)`**: to `onError`, like the projection's other errors; without one,
  to `console.error`.
- **`compileStyles`**: to its `onRefused`, by default `console.warn`.
- **`renderToString`**: to its `onRefused`, by default `console.warn`, from both the projection and
  the stylesheet (and a turn over a work budget); `rendered.projection.index.refusals` has the
  projection's afterwards.
- **`renderToStream`**: the projection's to `console.error`. It compiles no stylesheet: compile the one
  it links with `compileStyles(store, { policy, onRefused })`.
- **A live example**: as warnings under its editor, the same on the server and in the browser.
- **`HtmlIndex.refusals`**: every reason by node, kept while the node exists. Each reason is
  reported once per node.

### What it costs

An authored projection costs one set lookup per attribute more (and a scheme test for a URL, a scan
for CSS); a trusted one checks only that an attribute node's name is an attribute name. The style
compiler's checks run once per compile.

### Work budgets

An authored graph brings its own rules, and a rule can ask for more work than any page can do: one
that mints two nodes for every node it renders never ends. The policy bounds it
(`ontology/layers/safety.ttl`):

| | default | what it bounds |
|---|---|---|
| `safe:budget` | `PT1.5S` | how long a turn may run (the watchdog's budget, `src/engine/watchdog.ts`) |
| `safe:maxEvaluations` | 200 000 | rule evaluations (a rule for a focus) in a turn: deterministic, so a server renders the same at any load |
| `safe:maxDerived` | 1 000 000 | derived triples a projection holds: its output |
| `safe:maxLength` | 262 144 | the longest string the policy checks (an attribute value, an input, a piece of CSS); a longer one is refused unread |

A runtime that projects authored content takes the budgets of its policy (`Runtime.project({ policy
})`; the tightest, if several projections have one). The watchdog counts evaluations per turn as
well as time, and the engine its derived triples; a turn over any of them is suspended at the
watchdog's next check, at a consistent point (strata below are complete, every derived triple comes
from a complete evaluation). Then:

- **`mount`** stops it: the held work is dropped, as the watchdog's `sem:Stop` drops it, and what is
  left is counted out of date; the page shows what was complete, and `onRefused` gets a `Refused` of
  kind `budget` ("Stopped: authored content took more than 200000 rule evaluations, and 37
  renderings were left undone."). A later turn over budget, an event's, is stopped the same way.
- **`renderToString`**, **`renderToStream`**: the same, before serializing: the HTML is what was
  complete, `onRefused` gets the report, and `Rendered.exceeded` says why.
- **A live example** stops itself and shows the reason inline, as it does over its time budget.

The live examples of this site stay under 100 evaluations and 3 000 derived triples a turn. A
stricter policy narrows them (`{ ...authoredPolicy(trusted), maxEvaluations: 10_000 }`), or a
`safe:Policy` of your own states them in Turtle.

### Remembered state

Restoring brings back only what a persistence policy covers: its subject's listed properties
(`per:subject`, `per:properties`), or what its query's template can produce (`per:construct`), into
its graph (`per:graph`); a stored switch only for a policy there is. Whatever else storage holds
stays there. The live examples' policy is read from the ontology alone, never from the site's store,
which holds what was restored.

## Extending or narrowing the policy

The policy is triples, so extending it is Turtle in a **trusted** graph, and narrowing it is a
policy of your own.

**More of what is there.** Add to `safe:Authored` in your app's own Turtle (`mount`'s `graphs`, or
the store you pass to `authoredPolicy`):

```turtle
@prefix safe: <https://semblance.dev/ns/safety#> .

safe:Authored
    safe:scheme "sms:" ;                 # links to sms: addresses
    safe:hostComponent "Chart" ;         # your library's Chart may draw an authored chart
    safe:customElement "ds-badge" ;      # and ds-badge may be created for an authored badge
    safe:property "value" .              # an island's or custom element's value property may be set
```

An element is an RDF/HTML class (`rdfhtml:Dialog`) or one of the SVG extension's (`svg:Path`):
those are the elements the index can create, so "your own element" is a custom element
(`ext:tag`, listed in `safe:customElement`) or a host component, not a new class. A component you
write needs nothing from the policy as long as it renders listed elements and attributes; prefix your
own attributes with `data-` (not `data-sem-`) and they are allowed already.

When the framework itself starts to emit an element or attribute the policy does not list, add it to
`safe:Authored` in `ontology/layers/safety.ttl`: `test/safety.test.ts` renders every live example
of the site under the policy and fails on any refusal.

**Less.** A stricter policy is a `SafetyPolicy` of your own. The quickest is the framework's, with
some sets replaced:

```ts
const strict: SafetyPolicy = { ...authoredPolicy(trusted), schemes: new Set(['https:']), resourceSchemes: [] }
await mount(element, { root, graphs: [appTtl], authored: [fromTheModel], policy: strict })
```

or a `safe:Policy` of its own in your Turtle, read with `readPolicy(trusted, ex + 'Plain')`. Such a
policy lists everything it allows; nothing is inherited from `safe:Authored`.

```turtle
ex:Plain a safe:Policy ;
    safe:element rdfhtml:Div , rdfhtml:Span , rdfhtml:P ;
    safe:attribute "class" , "lang" , "dir" ;
    safe:attributePrefix "data-" , "aria-" .
```

**Why it must come from a trusted store.** The policy is the only thing between the author and the
page, and it is triples. Read from a store that holds the authored graph, the author could write
`safe:Authored safe:element rdfhtml:Script` and allow itself anything. So the policy is read before
the authored graph is loaded (`mount`, from a store of `graphs` alone), or from the ontology alone
(the live examples), and handed to the projection as data.

## Defence in depth

The policy decides what an authored graph renders. Around it:

### Content Security Policy

The policy limits the **schemes** of what is rendered, a CSP their **origins**, and what may run at
all. With the recommended policy, markup that slipped past the check still could not run a script,
load from an origin you did not list, or post a form elsewhere.

**From the document helper.** `renderDocument(template, rendered, { csp })` (and `renderToStream`,
and a site's `csp`, which the static build and the request handler pass on) puts the policy in a
`<meta>` right after the charset, with the hash of every inline script and style element the
finished document has: the platform mark, the app bar's measure for what sticks below it, the event
capture, the first-paint script of what the visitor chose, an inline stylesheet, the template's own. `csp: true` gives the recommended policy;
an object adds the origins your page uses (`src/server/csp.ts`, `CspOptions`):

```ts
renderDocument(template, rendered, {
  csp: { img: ['https://images.example'], connect: ['https://api.example'], trustedTypes: ['my-app'] },
})
```

```
default-src 'self';
script-src 'self' 'sha256-…' 'sha256-…' 'wasm-unsafe-eval';
style-src 'self';
style-src-attr 'unsafe-inline';
img-src 'self' https://images.example data: blob:;
media-src 'self' data: blob:;
font-src 'self';
connect-src 'self' https://api.example;
frame-src 'self';
worker-src 'self';
object-src 'none';
base-uri 'none';
form-action 'self';
require-trusted-types-for 'script';
trusted-types semblance my-app
```

`contentSecurityPolicy(opts)` gives the same as a header value, with `frame-ancestors 'self'` (and
`report-uri` from `report`), which a `<meta>` cannot carry; `inlineScriptHashes(html)` and
`inlineStyleHashes(html)` give the hashes for a document you assemble yourself. `directives`
replaces any directive outright. The hashes are SHA-256, computed synchronously in plain
TypeScript, so the same code runs in Node, Deno and workers.

- `script-src`: the page's own scripts, and the inline ones by hash: no `'unsafe-inline'`, no
  `'unsafe-eval'`. `'wasm-unsafe-eval'` lets the stores, WebAssembly modules (Semblance's engines,
  Oxigraph), compile; it allows WebAssembly, not `eval`.
- `style-src 'self'`: the compiled stylesheet and each live example's are constructed stylesheets
  (`adoptedStyleSheets`), which it allows; a stylesheet inline in the document, and the styles a
  server writes into a prerendered live example, by hash. `style-src-attr 'unsafe-inline'`: the DOM
  patcher writes `style` attributes with `setAttribute`, each of which, under the policy, passed the
  CSS check first. Writing them through the CSSOM, so this line can go, is #157.
- `img-src`, `media-src`: `data:` and `blob:` are the resource schemes the policy allows (`blob:` is
  also what picked and dropped files are previewed from). List the origins images may come from,
  rather than `https:`, if authored graphs should not load from anywhere.
- `connect-src`: the engines' `.wasm` files; add the endpoints of the remote sources the host binds
  and the `uploadOrigins` it allows.
- `form-action 'self'`: an authored form may name an `https:` action, or a button a `formaction`;
  the CSP keeps them on your origin. `base-uri 'none'` and `object-src 'none'` close the rest.
- A link's destination is outside any CSP: an authored `https:` link goes where it says when
  followed.

A streamed document (`renderToStream`) sends its head before the root's HTML exists, so the styles
of a live example the server prerenders into it are not among the hashes: add
`directives: { 'style-src-elem': "'self' 'unsafe-inline'" }` there, or render with
`renderToString`. One self-contained file (`--single`) carries no policy.

**Trusted Types.** `require-trusted-types-for 'script'` makes every script sink (`innerHTML`,
`srcdoc`, a script's `src`, `new Worker`, `eval`) take only values a named policy made. Semblance
writes no HTML and no script from a string: the renderer creates elements and sets attributes and
text, so it runs under Trusted Types as it is, and an authored input that reached `innerHTML` would
throw instead of parsing (a test scans `src/` for such sinks). Its one policy, `semblance`, makes
script URLs of the page's own origin, for what the host loads itself:

```ts
import { scriptURL } from '@inferal-oss/semblance/web'
import thumbnails from './thumbnails.worker.ts?worker&url' // Vite: the worker's URL
new Worker(scriptURL(thumbnails), { type: 'module' })
```

Libraries that write HTML from strings themselves need a policy of their own, and those that are
not aware of Trusted Types the `default` one. The site runs under this policy: its fonts and its
foreign-component examples' CDN are listed, and `demo/trusted-types.ts` adds `semblance-site` (the
page's own HTML as the document the Performance view's benchmark cells run in) and a `default`
policy for Leaflet, flatpickr, Temml and Shoelace's icons, which parses what they write inertly and
strips what runs code or loads a document. Lit's `lit-html` policy is listed for Shoelace.

**With the live editors**, a visitor writes the graph, so the CSP is what limits where it can reach:
keep `img-src`, `media-src` and `form-action` to the origins you mean.

### Live examples run in sandboxes

Each live example (`src/sandbox.ts`) runs in a sandbox of its own: its own store (the ontology and
its sources, never the site's graph), its own runtime and projections under the policy, its own event
bus, and a turn budget (`budgetMs`, 1500 ms by default) past which it stops itself and reports, so the
site never waits on it. A source that does not parse, a rule that throws or a reaction that fails
stays in the sandbox; what happened is written back to the site's graph as data the example shows.
Besides its event bus, a sandbox attaches only its full screen (shown over the page): no
navigation, persistence, network capture or files effect, and no islands. It is not a separate browsing context: it shares the page's
document and origin, which the policy and the CSP protect.

For authored content in your own app, the same holds by construction when you give it its own
store and runtime (`buildSandbox`, or a second `mount` of only the authored graph).

### Remote sources

A remote source ([REMOTE.md](REMOTE.md)) names no endpoint and no credentials in the graph: the host
maps a source's IRI to its URL, and an unmapped one stays `src:Unbound`. What a remote store sends is
data in the page's store like any other, and is rendered under the projection's policy if it has
one. Whether a server accepts a write is the server's decision (`src:WriteRefused`).

### Graphs from a model or a form

Treat a model's or a form's output as authored: pass it as `authored`, or render it in a sandbox.
Beyond the policy:

- **Shapes describe, they do not guard.** A shape (`c:Link`'s requires an `http(s)`, `mailto:` or
  relative `c:href`) marks a component invalid and says why; it does not stop a trusted projection
  from rendering what it flags. The policy does.
- **Cost.** An authored graph brings its own rules, so its work is bounded too: see
  [Work budgets](#work-budgets).
- **Parse failures.** Turtle that does not parse fails to load; a sandbox reports it as a problem of
  the example.

## Worked examples

Each row is an authored graph trying one thing, what renders instead, and the test that checks it.
`test/safety.test.ts` renders each vector in a live example's sandbox, in the DOM and as a server
writes it; `test/safety-guide.test.ts` holds the examples of this guide that go through `mount` and
`renderToString`. The site's live example (`ui:sa-live`: a `javascript:` link, a component whose
rendering asks for a script, and a style that loads an image from elsewhere) is checked to be refused
exactly those three things ("renders every live example of the site", `test/safety.test.ts`).

A component of the author's own, whose SPARQL rendering emits a script:

```turtle
ex:Evil a owl:Class ; rdfs:subClassOf sem:Component ; sem:slug "ex-evil" .
ex:EvilRendering a sem:Rendering ; sem:targets ex:Evil ; sem:stratum 0 .
ex:EvilRendering-sparql a sem:Rule ; sem:implements ex:EvilRendering ; sem:construct """
CONSTRUCT { ?root a rdfhtml:Div ; sem:renders $this ; rdfhtml:hasChild ?x .
            ?x a rdfhtml:Script ; rdfhtml:hasChild ?t . ?t a rdfhtml:Text ; rdfhtml:data "window.pwned = 1" }
WHERE { $this a ex:Evil .
        BIND(IRI(CONCAT(STR($this), "/~root")) AS ?root) BIND(IRI(CONCAT(STR($this), "/~x")) AS ?x)
        BIND(IRI(CONCAT(STR($this), "/~t")) AS ?t) }""" .
ex:it a ex:Evil .
```

The `div` renders, and in it `<sem-refused data-sem-refused="script"></sem-refused>`; the text has
nothing of it, and the example warns `Refused on <…#it/~x>: authored content may not have a script
element.` The others, in `test/safety.test.ts` unless named:

| the authored graph tries | what renders | test |
|---|---|---|
| a `script` | `<sem-refused data-sem-refused="script"></sem-refused>` | render a script element |
| `iframe`, `object`, `embed`, `base`, `link`, `meta`, `style`, `noscript`, `template` | `sem-refused`, without its `src` or `href` | render an iframe, object, embed, … |
| what a refused element holds (an `img` in a `noscript`) | nothing | use a refused element to smuggle what it holds |
| `onclick` on a button, as an attribute node | `<button title="kept"></button>` | set an event handler attribute |
| `href="javascript:alert(1)"`, also as ` JaVaScRiPt:`, `java\tscript:`, `vbscript:`, `data:text/html` | `<a>link</a>` | link to a javascript: URL, however it is spelled |
| a form's `action` and a button's `formaction` of `javascript:` | the form and button, without them | submit a form to a javascript: URL |
| `srcdoc`, and an image `src` of `data:text/html` | `<img alt="a">` | give srcdoc, or an image a data: URL that is not an image |
| an SVG path with `onload` and `fill: url(https://…)` | `<svg><path></path></svg>` | load a script through SVG |
| `url()`, `image-set()`, `} @import …`, an escaped `u\72l(`, a selector part with `}`, `-moz-binding`, a token of `url(…)` | each left out of the sheet; `color: rebeccapurple` and a `data:image/svg+xml` background stay | load a resource from its styles |
| a host component and a custom element the policy does not list | `<div data-sem-c="ex-evil">`, not drawn by the host | have a component drawn by a host component … |
| `safe:Authored safe:element rdfhtml:Script` in its own graph | still `sem-refused` | is read from a trusted store |
| `file:uploadTo "https://evil.example/upload"` | not sent; the reason | lets uploads go to the page's own origin … |
| `https:`, `mailto:`, `tel:`, relative and fragment links, a `data:image/png` image, `data-ex-thing`, `style="color: red"` | all of it, nothing refused | link to http(s), mailto: and tel: addresses … |

Through `mount` (`test/safety-guide.test.ts`), with your page linking to `javascript:void 0` and the
author's link (`ui:theirs a c:Link ; c:label "Theirs" ; c:href "javascript:alert(1)"`):

| | what renders | test |
|---|---|---|
| `mount({ graphs: [app], authored: [theirs], onRefused })` | both links without `href`; `onRefused` gets two `Refused` of kind `url`, yours and theirs | mount({ authored, onRefused }) |
| `mount({ graphs: [app, theirs] })` | both as written | without authored, the same graphs render as written |
| `safe:Authored safe:scheme "sms:"` in `graphs`, an `sms:` link authored | the link, with its `href` | a trusted graph extends safe:Authored |
| the same triple in the authored graph instead | the link without `href`, reported | (the same test) |
| `policy: { ...authoredPolicy(trusted), schemes: new Set(['https:']) }` | an `https:` link; a `mailto:` one without `href` | a stricter policy |
| `ex:Plain a safe:Policy` in Turtle, `readPolicy(trusted, ex:Plain)` | a policy of three elements and no schemes | a policy of its own, in Turtle |
| `renderToString({ store, root, policy })` | the same HTML as the browser's; `rendered.projection.index.refusals` lists both links | renderToString({ policy }) |

## Not covered

- Where an `http(s)` link goes or an image comes from: use a CSP.
- An id the rendering has that the host's page has too: the browser takes the first in the document
  (in a shadow root, each has its own).
- What the author's triples say about your resources, and what its reactions change, when it shares
  your store (`mount({ authored })`): give it a store of its own to keep it out.
- DOM clobbering by `id` or `name` of the host's own scripts (one that reads `window.someId`):
  render authored content in a shadow root (`isolate: 'shadow'`), where its names do not reach the
  document. Semblance's own reads go past named elements.
- What a foreign component the policy lists does with its inputs once mounted: it is the host's
  code. A live example's sandbox attaches no islands effect.
- Host effects you attach yourself: navigation, persistence and network capture act on graph state
  as the host configured them; give them `trusted` (above) when the store holds authored graphs. A
  live example's sandbox attaches none of them (its full screen is shown over the page).
