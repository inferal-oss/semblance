# What Semblance did not make

Every element the DOM patcher creates traces back to a graph node and the rule that rendered it. Some
of a page can still come from elsewhere: host code that inserts its own elements, an extension, a
hosted library's own DOM, embedded media. The finder says which, and how much of the page it is.

## The finder

```ts
import { surveyUnmanaged, unmanagedElements } from '@semblance-dev/semblance/web'

const survey = surveyUnmanaged(document)   // { findings, visible, managed, unmanaged }
const elements = unmanagedElements(root)   // the findings' elements
```

An element is **made by Semblance** when

- a renderer (`DomRenderer`) made it from a rendering: its `keyOf` knows it;
- a host library drew it for a graph node (`ext:Hosted`, through the adapter's `keyOf`);
- it is inside an island (`ext:Island`) or a custom element the graph names (`ext:tag`): mounting
  foreign components is what islands are for, so their content counts as Semblance's.

Renderers register on the element they render into, so a renderer inside another one's slot (a live
example's sandbox) is followed too. Elements that only hold a renderer (the page's mount point, a
sandbox's box) are neither Semblance's nor not.

Every other element that is **visible on the page** belongs to a finding: the topmost element of a
subtree of such elements, with how many visible elements it holds. Visible means rendered on the page,
anywhere in the document, not only in the viewport: `checkVisibility()` with opacity and visibility,
and a box of more than a pixel (a visually hidden live region is not UI). Where there is no layout (linkedom), what is not hidden counts as visible;
`options.visible` and `options.displayed` replace either test.

| category | what |
|---|---|
| `host-code` | inside a renderer's tree (a host-owned slot, named in the reason, or not), or bearing one of the framework effects' marks (`data-sem-*`, `sem-*`) |
| `third-party` | a custom element the page does not define (an extension defines its own in its own world), an element on `<html>` outside `<body>` |
| `sanctioned` | a hosted library's own elements inside `<sem-host>`; embedded media (`iframe`, `video`, `audio`, `canvas`, `embed`, `object`) |
| `unknown` | outside every renderer, with nothing to say who made it |

It is one walk of the DOM with each renderer's own map, no query per element; it reads layout, so it
runs on demand.

## In tests

`notMadeBySemblance(root)` in `test/harness.ts` lists the findings as `category reason: path`:

```ts
expect(notMadeBySemblance(shell.document)).toEqual([])
```

## In the graph and the Tools

`attachUnmanaged(runtime, { renderers, onWrite })` is the host effect of `um:Survey`
(`ontology/layers/unmanaged.ttl`). When a survey is asked (`um:request um:Run`, a `c:Setter` button),
the page is walked and the findings written into the rendered graph (`urn:semblance:rendered`,
unrecorded) as the survey's members, replacing the last ones:

```turtle
<survey/~finding-1x9a2> a um:Finding ; um:order 1 ; um:category um:HostCode ;
    um:reason "host-owned slot gallery-host" ; um:element "div" ; um:path "div[data-sem-c=host-slot] > div" ;
    um:elements 3 ; um:near <…/~root> ; um:nearComponent ui:hostSlotSpecimen .
```

with the survey's figures (`um:visibleElements`, `um:managedElements`, `um:unmanagedElements`,
`um:share`, `um:surveyedAt`). A finding is named by where it is and what it is, so the same element
keeps its name from one survey to the next. The counts are maintained views, SPARQL with function
twins: `um:found` on a survey (`um:FindingCounts`) and on each `um:Category` (`um:CategoryCounts`),
which a `c:Segmented` shows with `c:countProperty um:found`.

With `c:bindFrom` and `c:bindProperty` on the survey (a data grid's `c:selectedRow`), the finding held
there is marked on the page (`data-sem-unmanaged`, its category) and scrolled to; the theme outlines it
while a `c:Highlight` is shown. A `c:Highlight` with `c:via um:near` marks the nearest element Semblance
made. Nothing is walked until a survey is asked, and nothing is marked before.

The site's Inspector has it as its second view, **Not made by Semblance** (`demo/app.ttl`).
