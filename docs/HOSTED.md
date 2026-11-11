# Semblance under your component library

A team that has a component library (a React design system, a kit of custom elements) can keep it
and put Semblance underneath: the graph holds the data and the state, rules project it, reactions
turn events into changes, and the library draws. A class of the graph resolves to a host component;
the component gets its props and its projected children; components nested in the graph are nested
in the library's tree; server rendering writes the library's markup and the client hydrates it.

This guide builds on [Getting started](GETTING-STARTED.md) and [Components](COMPONENTS.md). The
running example is `examples/react/`: the todo app's graph (`src/examples/todo.ts`, unchanged)
drawn by a small design system of the example's own.

```bash
npm install @inferal-oss/semblance @inferal-oss/semblance-react react react-dom
npm install --save-dev vite
```

The package's Vite configuration is the one [Getting started](GETTING-STARTED.md#install) gives. In
a checkout of this repository the example runs with

```bash
npx vite --config examples/react/vite.config.ts
```

## What changes, and what does not

Nothing about the projection changes. A component keeps its renderings (SPARQL first, a function
twin, every modality), its reactions, shapes, styles and accessibility. Binding a class to a host
component adds one generic rule (`ext:HostedRendering`) that states, on the component's root, which
host component draws it and the current value of its props. A renderer given a **host adapter**
draws such a root, and everything under it, with the library. Without an adapter (in a test, in the
text modality, on a page that does not load the library) the same projection renders as RDF/HTML,
as before.

```
graph ──rules──▶ RDF/HTML projection ──▶ HtmlIndex ──▶ DomRenderer ─┬─▶ DOM (Semblance's elements)
                 + ext:component, props                │             └─▶ <sem-host> ─▶ host adapter ─▶ React
                   on hosted roots                     └─▶ toHTML ───────▶ <sem-host>React's server markup</sem-host>
```

## 1. Bind classes to host components

In your app's Turtle (or a file that ships with your design system), say which classes your library
draws, under which name, and with which props:

```turtle
@prefix ext: <https://semblance.dev/ns/foreign#> .

c:Button rdfs:subClassOf ext:Hosted ; ext:component "Button" ;
    ext:input [ ext:name "intent" ; ext:from sty:intent ] .
c:Stack rdfs:subClassOf ext:Hosted ; ext:component "Stack" ;
    ext:input [ ext:name "direction" ; ext:from pos:direction ] ,
              [ ext:name "density" ; ext:from sty:density ] .
c:TextField rdfs:subClassOf ext:Hosted ; ext:component "Field" ;
    ext:input [ ext:name "invalid" ; ext:from c:error ] .
```

| term | meaning |
|---|---|
| `ext:Hosted` | the superclass of every class a library draws; only instances of these pay for the rule |
| `ext:component` | the name the host registered, on a class or one instance. A name, never code: what runs is the host's choice |
| `ext:input` | a prop: `ext:name`, `ext:from` (a property of the instance), `ext:through` (read it on a linked node), as for islands. A value arrives typed (numbers, booleans, `rdf:JSON` objects); an IRI with a `sem:slug` arrives as its slug (`sty:Primary` → `"primary"`) |
| `ext:output` | a callback prop that becomes an event: `ext:on "onValueChange"`, `ext:emits` (an `ext:Output` subclass), `ext:path`, `ext:field`, as for islands |
| `ext:tag` | a custom element the root is created as, instead of a host component (below) |

The binding can be your own class too (`ex:Rating rdfs:subClassOf sem:Component, ext:Hosted`), with a
rendering of its own; the library draws its root.

## 2. Write the components

A host component receives:

- its **props** (`ext:input`), and one **callback** per output (`ext:output`);
- **`root`**: the projected root's attributes in the library's naming (ARIA, the `data-sem-*` hooks
  themes and layers use, `class` as `className`, `style` as an object) and a `ref`. **Spread it on
  your root element**: it carries the accessibility the projection worked out and it tells Semblance
  which element stands for the component, so a click on it is the component's click;
- **`children`**: what the component's rendering placed inside its root, in order. Hosted components
  among them are your components; the rest are plain elements;
- **`focus`**: the instance's IRI.

```tsx
export function Button({ root, children, intent }: HostProps & { intent?: string }) {
  const density = useContext(DensityContext)
  return <button type="button" {...root} className={cx(root.className, 'ds-button', `ds-button--${intent}`, density === 'compact' && 'ds-button--small')}>{children}</button>
}

export function Stack({ root, children, direction, density }: HostProps & { direction?: string; density?: Density }) {
  const box = <div {...root} className={cx(root.className, 'ds-stack', direction === 'row' && 'ds-stack--row')}>{children}</div>
  return density ? <DensityContext.Provider value={density}>{box}</DensityContext.Provider> : box
}
```

Context works across the graph's nesting: the todo page is a `c:Stack` holding a row of `c:Button`s,
so the Stack's density context reaches the buttons. The todo app's "Toggle density" reaction changes
one triple (`ex:page sty:density`); the Stack's `density` prop changes; every button under it re-renders
smaller.

## 3. Mount with the adapter

```ts
import { mount } from '@inferal-oss/semblance/web'
import { reactHosts } from '@inferal-oss/semblance-react'

await mount(document.getElementById('app')!, {
  root: 'https://example.org/todo#page',
  graphs: [app, bindings],
  hosts: reactHosts({ components: { Stack, Heading, Button, Field, List } }),
})
```

`reactHosts({ components, wrap })`: `wrap` puts providers (a theme, a router, an i18n context) around
every React root the adapter makes.

## Events

Every element React draws is registered with the node it stands for, so the event bus finds a
hosted component as it finds any other: a click on the design system's `<button>` is `beh:Click` on
the `c:Button`, typing in its `<input>` is `beh:Input` on the text field, ticking a box in its list is
`beh:Change` on the list item. The app's reactions do not change. A component that reports only
through callbacks (a date picker's `onValueChange`) declares outputs:

```turtle
ex:Stars rdfs:subClassOf sem:Component , ext:Hosted ; ext:component "Stars" ;
    ext:input [ ext:name "value" ; ext:from c:value ] ;
    ext:output [ ext:on "onPick" ; ext:emits ex:Picked ; ext:path "value" ] .
ex:Picked rdfs:subClassOf ext:Output .
ex:Pick a beh:Reaction ; beh:when ex:Picked ; beh:sourceClass ex:Stars ; … .
```

The component calls `onPick({ value: 4 })`; the event goes through the reactions, the graph decides,
and the new value comes back as the `value` prop. The graph is the source of truth: write components
controlled by their props (or uncontrolled, reporting through events); a form control drawn as a
plain element keeps what is typed in it and follows the graph's value, as in Semblance's own renderer.

## Server rendering and take-over

The site description takes the same adapter, from the package's server entry (it brings
`react-dom/server`'s `renderToString`):

```ts
import { defineSite } from '@inferal-oss/semblance/node'
import { reactHosts } from '@inferal-oss/semblance-react/server'

export default defineSite({ root: '…', graphs: () => [...], hosts: reactHosts({ components }) })
```

The HTML has each hosted subtree in a `<sem-host>` with React's markup. The client takes the page
over ([SSR.md](SSR.md)): the patcher adopts the `<sem-host>` and the adapter hydrates it
(`hydrateRoot`), so nothing is drawn again.

## Custom elements as the root

A kit of custom elements needs no adapter. `ext:tag` on a hosted class creates the root as that
element; the patcher, the serializer and take-over create, write and adopt it as any element, its
attributes are the projection's, its children Semblance's (light DOM, to slot as the element likes),
and its props are set as properties:

```turtle
c:Heading rdfs:subClassOf ext:Hosted ; ext:tag "ds-title" ; ext:input [ ext:name "level" ; ext:from c:level ] .
```

The tag must be a valid custom element name (with a hyphen), so a graph cannot name `script`.

## Themes, tokens and styles

Semblance's tokens are CSS custom properties (`--sem-accent`, `--sem-space-3`, `--sem-radius-control`),
re-valued by every theme, color scheme, contrast and density on the subtree they are set on. A
stylesheet of the library's that reads them follows the page's theme with no rule of Semblance's
(`examples/react/design-system.css`). The theme hooks (`data-sem-theme`, `data-sem-color-scheme`,
`data-sem-density`) arrive in `root`, so they are on the component's own element.

Semblance's component styles (`[data-sem-c=button]`, in `@layer`s) still apply to an element that
spreads `root`. An unlayered stylesheet wins wherever both set a property; where the library wants
none of Semblance's look, it overrides it (the example removes the heading's accent bar).

## Cost

One React element per index node, memoized and subscribed to its own key: a change re-renders the
nodes it changed in the index, not the tree. Ticking one todo costs the same renders with 5 todos or
40 (`test/hosted.test.ts`).

## Safe authoring

Only names the host registered draw anything. In an authored projection ([SAFETY.md](SAFETY.md)) the
policy also decides which host components and custom elements a graph may name (`safe:hostComponent`,
`safe:customElement` on the policy; none by default); any other renders as its RDF/HTML element.
Attributes reach `root` through the index, so the attribute and URL checks apply to host components too.
So do inputs: a host component's or a custom element's props pass the policy's input check (an
attribute input the attribute check, a property input `safe:property`, none by default), and under a
policy the React adapter never takes `dangerouslySetInnerHTML`, `ref`, `key`, `children` or an `on…`
name from the graph.
To let authored graphs use one of yours, list it in your own Turtle (`safe:Authored safe:hostComponent "Chart"`;
see [Extending or narrowing the policy](SAFETY.md#extending-or-narrowing-the-policy)).

## Hosted components and islands

| | islands ([FOREIGN.md](FOREIGN.md)) | hosted components |
|---|---|---|
| for | code Semblance does not render: a chart, a map, an editor | a component Semblance projects, drawn by a library |
| rendering | a wrapper and a host-owned slot | the component's own rendering |
| children | none | the projected children |
| nesting | each island its own root | one tree per `<sem-host>`, context included |
| server | a custom element's tag, else an empty slot | the library's markup, hydrated |
| shared | `ext:input`, `ext:output`, typed values, the index's input nodes | |

## What is where

| file | what |
|---|---|
| `ontology/layers/foreign.ttl` | `ext:Hosted`, `ext:component`, `ext:HostedRendering` (SPARQL), the `sem-host` style |
| `src/layers/foreign.ts` | `foreign:hosted`, the function twin |
| `src/render/hosts.ts` | `HostAdapter`, `HostRenderer`, `hostedBy` |
| `src/render/html-index.ts` | `component` on nodes, `hostComponent`, custom element tags in `tagName` |
| `src/render/dom.ts`, `src/render/serialize.ts` | `<sem-host>`, adopt and hydrate, custom element props |
| `src/web/mount.ts`, `src/server/render.ts`, `src/server/site.ts` | the `hosts` option |
| `src/foreign.ts` | `outputsOf`, `emitOutput`, shared with islands |
| `packages/react/` | `@inferal-oss/semblance-react` |
| `examples/react/` | the design system, its bindings, the example |
| `test/hosted.test.ts` | rendering, parity, events, outputs, context, cost, SSR and hydration, themes, custom elements, fallback |
