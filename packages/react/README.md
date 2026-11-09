# @inferal-oss/semblance-react

React as the component library under [Semblance](https://semblance.dev): Semblance keeps the data,
the state and the behaviour (the graph, the rules that project it, the reactions to events), and your
React components draw the components the graph binds to them, with their props and projected
children, nested in one React tree, with events and server rendering.

```bash
npm install @inferal-oss/semblance @inferal-oss/semblance-react react react-dom
```

```turtle
c:Button rdfs:subClassOf ext:Hosted ; ext:component "Button" ;
    ext:input [ ext:name "intent" ; ext:from sty:intent ] .
```

```tsx
import type { HostProps } from '@inferal-oss/semblance-react'

export const Button = ({ root, children, intent }: HostProps & { intent?: string }) => (
  <button type="button" {...root} className={`ds-button ds-button--${intent}`}>{children}</button>
)
```

```ts
import { mount } from '@inferal-oss/semblance/web'
import { reactHosts } from '@inferal-oss/semblance-react'

await mount(el, { root, graphs, hosts: reactHosts({ components: { Button } }) })
```

On the server, `reactHosts` from `@inferal-oss/semblance-react/server` (it brings `renderToString`) goes
in `defineSite({ hosts })`; the client hydrates what it wrote.

The guide is [docs/HOSTED.md](https://github.com/inferal-oss/semblance/blob/main/docs/HOSTED.md); the
example is `examples/react/` in the repository. React 19 is a peer dependency.

Licence: MIT OR Apache-2.0.
