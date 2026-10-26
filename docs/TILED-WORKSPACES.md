# Tiled workspaces

`c:TiledWorkspace` renders one persistent tree. An internal node is a
`c:SplitView`; a leaf can be any component, including `c:Tabs` with host-owned
`c:slot` content. Each split has its own `c:ratio` and keyboard-accessible
separator. Tabs keep their own IRIs when moved between leaves.

```turtle
@prefix c: <https://semblance.dev/ns/component#> .
@prefix ui: <https://example.com/ui#> .

ui:workspace a c:TiledWorkspace ; c:label "Workspace" ; c:rootTile ui:main .
ui:main a c:Tabs ; c:tabs ( ui:editor ) ; c:selected ui:editor .
ui:editor a c:Tab ; c:label "Editor" ; c:slot "editor" .
```

Hosts that manage pane commands can use `TiledWorkspace` from the package root.
It reads the graph and returns one RDF delta per command. Apply that delta through
`Runtime.apply` so the projections see a single change:

```ts
const tree = new TiledWorkspace(runtime.store, runtime.store.factory.namedNode('https://example.com/ui#workspace'))
runtime.apply(tree.split(editorTabs, inspectorTabs, 'row'))
runtime.apply(tree.moveTab(editorTab, editorTabs, inspectorTabs))
runtime.apply(tree.close(editorTabs))
```

`split` accepts `row` or `column` and can put the new pane before or after the
target. `close` promotes the sibling and retains the removed pane's own graph
facts. `moveTab` rewrites the two RDF lists and selects the moved tab in its new
group. It leaves the tab IRI, its content node and its host slot intact. The
caller decides whether an empty source pane should then close. All operations
reject targets outside the workspace and malformed tab lists.

For a named input graph, pass it as the third constructor argument. Pane and
tab identities should come from application data and remain stable across
re-rendering and persistence restore.
