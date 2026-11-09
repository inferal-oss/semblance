# Shipping the part of the ontology an app uses

Semblance's ontology describes every component, layer, style and theme: about 4.6 MB of Turtle,
700 KiB gzipped. An app uses a part of it. `ontologySubset` (`src/subset.ts`) finds that part from
the app's graphs, and a site can ship only that (#383).

```ts
// semblance.config.ts
export default defineSite({
  root: 'https://example.org/hello#page',
  graphs: () => [read('tally.ttl'), read('app.ttl')],
  subset: true, // or { classes: [...] }: classes the host makes instances of itself
})
```

```ts
// main.ts
import ontology from 'virtual:semblance/ontology' // the Vite plugin's module
await mount(element, { root: 'https://example.org/hello#page', graphs: [tally, app], ontology })
```

With `subset`, the static build and the request handler render from a store of the subset (so the
built `semblance.css` has only its styles), and the client loads the plugin's module in place of
the whole ontology, which it then does not fetch. Outside this repository, an app's TypeScript sees
the module with `/// <reference types="@inferal-oss/semblance/virtual" />`. In Node,
`appOntology(graphs)` returns the subset, and `loadStoreWithOntology(kind, subset.turtle, ...graphs)`
loads a store from it.

| | whole ontology | subset |
|---|---:|---:|
| examples/hello: ontology, gzipped | 704 KiB (149 files) | 171 KiB (one module) |
| examples/hello: stylesheet | 674 KiB | 54 KiB |
| examples/hello: before interactive, gzipped | about 1,180 KiB | about 570 KiB |
| a gallery page on its own: statements kept | | 23–38% |
| a live example: statements kept | | 22–31% |

## What is kept

The unit is a description: a named subject with every blank node it reaches (a blank node nothing
points at, as a `[] a sty:StyleRule`, is one of its own). What a description is about decides
whether it is kept:

- a rendering or a rule: the class it targets (`sem:targets`); a rule that implements a rendering
  or takes its query from another rule, what that one is about;
- a style rule: the classes it applies to (`sty:appliesTo`), and the theme it is narrowed to
  (`sty:when`); without `sty:appliesTo`, the classes whose slugs its selector needs;
- a shape: its `sh:targetClass`; a reaction: its `beh:sourceClass`;
- a class, or a theme: itself; an instance of component classes only: its classes.

A description about nothing (the core, the layers' vocabularies, tokens, phrases) is always kept;
one about something is kept when what it is about is reached. Reached, with every superclass:

- `sem:Component`, and the classes host code makes instances of (the viewer, provenance, rendered
  state, sources);
- the classes of the app's instances, and the component classes its data names;
- the component classes a kept rule or reaction may make instances of: those its `CONSTRUCT` or
  `INSERT` templates name (all those its text names, when a template types a node with a variable);
- any other class a kept rule or reaction names, and the classes of what is kept;
- the themes the app names; all of them when it, or a kept rule, names `sty:theme` (a chooser of
  themes).

A class whose instances read the whole ontology says so with `sem:readsWholeOntology true` (the
Reference's tree and term overview, the SPARQL workbench); an app that reaches one ships all of it.
semblance.dev does.

## What is checked

`test/subset.test.ts` renders examples/hello, every page of the gallery (on its own, and in the
site's shell) and every live example from the whole ontology and from its subset: the HTML is the
same, byte for byte, through an interaction too, and the subset's stylesheet adds no rule and
loses none that selects an element on the page.

## Limits

- The subset is computed from the graphs the site description gives. Data that arrives later and
  makes instances of other component classes (a graph loaded at run time, a host effect) needs
  those classes named in `subset.classes`.
- A function rule (`sem:function`) is not read: what it makes is known from its SPARQL twin.
- Live examples on semblance.dev build their sandboxes over the whole ontology: their sources are
  edited in the page.
