# Safe authoring

A Semblance interface is a graph, and a graph can come from someone you do not trust: a person
typing in a live example, a page, a model. **Authored content** is rendered under a policy, so that
Turtle and SPARQL describe an interface without running code or loading anything from elsewhere on
their own. The policy is vocabulary (`ontology/layers/safety.ttl`), applied in one place every
output reads from.

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
author's, which could add to its lists. `mount` reads it before it loads `authored`; the live
examples read it from the site's store (their sources are text there, not triples); `authoredPolicy`
and `readPolicy` take the store you trust.

## What an authored graph may do

- Render any element of the framework's components and of your own, built from the elements
  `safe:Authored` lists (`safe:element`): text, headings, lists, tables, forms and their controls,
  `details`, `dialog`, images, audio and video, the SVG extension's elements.
- Give them attributes from `safe:attribute`, and any `data-…` or `aria-…` one.
- Link and load by URL when the URL is relative, a fragment, or `http:`, `https:`, `mailto:` or
  `tel:`; an image, audio or video source (`src`, `srcset`, `poster`) may also be `data:image/…` or
  `blob:`.
- Style with `sty:StyleRule`s, tokens and keyframes, and `style` attributes, whose values pass the
  CSS check below; `url()` of a fragment (`url(#gradient)`) or of a `data:image/…` loads nothing from
  elsewhere and is allowed.
- Define classes, renderings, SPARQL rules, reactions and shapes: they only produce triples, and
  what they produce is checked.
- Have a component drawn by a host component library ([HOSTED.md](HOSTED.md)) only by a host
  component (`safe:hostComponent`) or custom element (`safe:customElement`) the policy lists, none by
  default; any other renders as its projected element.

## What it may not do

- **No element that runs or embeds:** `script`, `iframe`, `object`, `embed`, `base`, `link`, `meta`,
  `style`, `noscript`, `template`, `slot`, nor `html`, `head`, `body` or `title`.
- **No attribute outside the list:** no event handler (`on…`), `srcdoc`, `is`, `nonce`, `ping`,
  `http-equiv`, `sandbox`, `allow`, `integrity`, `shadowrootmode`.
- **No other URL scheme:** no `javascript:`, `vbscript:`, `data:` (but an image's) or `file:`, however
  it is spelled (case, spaces, tabs and newlines are read as a browser reads them).
- **No CSS that loads or escapes:** no `url()` to an address, `image-set()`, `image()`,
  `cross-fade()`, `element()`, `src()`, `paint()` or `expression()`; no `{`, `}`, `@`, `<` or `;` that
  would start another rule or at-rule (`@import`), no escape outside a string (an escape can spell
  `url`), quotes and brackets that balance; no `behavior` or `-moz-binding`. The same holds for every
  string the style compiler writes from the graph: properties, values, slugs, parts, states, media
  conditions, keyframe names and steps.
- **No upload elsewhere:** `file:uploadTo` posts only to the page's own origin, or to an origin the
  host lists (`files: { uploadOrigins: ['https://uploads.example.com'] }`); this holds whether or
  not the graph is authored, since the graph says where and the host says where may be.

## What happens to what is refused

Nothing is dropped silently.

| refused | DOM and HTML | text | report |
|---|---|---|---|
| an element | an empty `<sem-refused data-sem-refused="script">`, without its attributes or children | nothing | once, as it arrives |
| an attribute or a URL | left out; the element stays | - | once |
| a style declaration | left out of the `style` attribute or the sheet | - | once |
| a style rule's selector or condition | the rule is left out | - | once |

Reports go through the projection's error channel as `Refused` errors (`src/safety.ts`): a live
example lists them as warnings under its editor, on the server and in the browser; `mount` passes
them to `onRefused` (by default `console.warn`); `HtmlIndex.refusals` keeps them by node.

The check sits in `HtmlIndex`, which every output reads: the DOM patcher (creating, patching,
taking over server-rendered HTML), `toHTML`, `toIndentedHTML`, `toText` and server rendering all
get the same answer. A SPARQL rule and its function twin produce the same triples, which are checked
after, so parity is unchanged. An authored projection costs one set lookup per attribute more (and a
scheme test for a URL); a trusted one checks only that an attribute node's name is an attribute name.

## Content Security Policy

Nothing in the mode needs inline script or inline style: a refused node adds none, and a live
example's own style rules go through an adopted stylesheet (CSSOM) in the browser. A strict CSP is
the other half of the policy: the policy limits the **schemes** of rendered URLs, a CSP their
**origins** (`img-src`, `media-src`, `form-action`, `connect-src`). Applying `style` attributes
without `unsafe-inline` is #157.

## Not covered

- Where an `http(s)` link goes or an image comes from: use a CSP.
- DOM clobbering by `id` or `name` (a host script that reads `window.someId`).
- Foreign components (`ext:island`): an authored graph mounts only what the host registered; a live
  example's sandbox registers none.
- Host effects you attach yourself: navigation, persistence and network capture act on graph state
  as the host configured them. A live example's sandbox attaches none of them (its full screen is
  shown over the page).
