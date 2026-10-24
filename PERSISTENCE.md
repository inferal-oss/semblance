# Proposal: remembering state, ontologically

Status: **proposal**, not implemented. Covers what to remember, where, under
whose control, and how to audit it, all as graph data.

## The idea in one paragraph

What is remembered is a **policy**, a node in the graph like any other. It
says *which triples* (a subject and properties, or a CONSTRUCT), *where*
(a scope: this tab's session, this device, an origin database, later a pod or
server) and *whether it is on* (`per:enabled`, itself graph state, so a
checkbox can control it). A host effect, like the benchmark runner, watches
input-graph deltas. It writes the covered triples to the scope's storage and
puts them back before the first projection on the next load. Policies are
data, so they show up in the inspector, shapes validate them, and a
change log records what was remembered and why.

## Vocabulary (`per:` = `https://semblance.dev/ns/persistence#`)

| term | meaning |
|---|---|
| `per:Policy` | Something to remember. |
| `per:scope` | `per:Session` (sessionStorage: this tab, until closed), `per:Device` (localStorage: this browser profile), `per:Database` (IndexedDB: larger, structured), `per:Pod` (later: a Solid pod / server, shared across devices). |
| `per:enabled` | `xsd:boolean`. Default true. Graph state, so a switch can control it. |
| `per:subject` + `per:properties` | The simple form: these properties of this node. |
| `per:construct` | The general form: a SPARQL CONSTRUCT over the input and derived graphs whose result is remembered. Restoring writes it back to the input graph, the same contract as a reaction's `beh:inserts`. |
| `per:forgets` | Optional CONSTRUCT of what to remove before restoring (default: the current values of what is restored). |
| `per:retention` | Optional `xsd:duration` (e.g. `"P30D"`) after which stored state is dropped. |
| `per:sensitive` | On a property: never remembered (password values, tokens). A shape rejects a policy covering one. |
| `per:version` | Stored with each write. A policy whose shape or version changed discards stale state instead of applying it. |

## Examples

**The inspector's windowing state.** Whether the Inspector is detached, and
where its window is, remembered on this device. A switch on the Playground
turns it off and on.

```turtle
ui:rememberInspectorWindow a per:Policy ;
    rdfs:label "Remember the inspector window" ;
    per:scope per:Device ;
    per:enabled true ;
    per:construct """
CONSTRUCT { ui:inspectorTab c:detached ?d . ?w c:x ?x ; c:y ?y ; c:width ?wd ; c:height ?h ; c:windowState ?s }
WHERE {
  OPTIONAL { ui:inspectorTab c:detached ?d }
  OPTIONAL { ?w prov:wasDerivedFrom ui:inspectorTab .
             OPTIONAL { ?w c:x ?x } OPTIONAL { ?w c:y ?y } OPTIONAL { ?w c:width ?wd }
             OPTIONAL { ?w c:height ?h } OPTIONAL { ?w c:windowState ?s } }
}""" .

ui:rememberInspectorWindowSwitch a c:ToggleSwitch ;
    c:label "Remember the inspector window" ;
    c:controls ui:rememberInspectorWindow ; c:property per:enabled .
```

Windows minted from tabs have deterministic IRIs. A restored `c:x` lands on
the same window the next time it is detached.

**Settings for this tab only.**

```turtle
ui:rememberDisplay a per:Policy ; per:scope per:Session ;
    per:subject ui:shell ; per:properties ( mot:preference sty:contrast sty:density sty:theme ) .
ui:rememberLanguage a per:Policy ; per:scope per:Device ;
    per:subject ui:app ; per:properties ( l10n:language sty:colorScheme ) .
```

**Whole classes**, e.g. every window's geometry:

```turtle
ui:rememberWindows a per:Policy ; per:scope per:Device ;
    per:construct """CONSTRUCT { ?w c:x ?x ; c:y ?y } WHERE { ?w a c:Window ; c:x ?x ; c:y ?y }""" .
```

## Auditing

Two kinds of history, both LDES, both already in the model's grain:

1. **Interactions**: `beh:ChangeLog` exists. A policy can remember it:
   `per:construct` over its members, bounded by its own retention policy, at
   `per:Session` or `per:Database`. Reloading then keeps the Change log and the
   Activity statistics: an audit trail across reloads.
2. **Remembered state**: `per:StateLog`, a second `ldes:EventStream`. Each
   write is a member saying which policy, which scope, the triples' size, a
   `prov:generatedAtTime`, and `prov:wasInformedBy` the change-log event that
   caused it. Each restore is a member too. "Current state" for position and
   size is the last member per policy. "How it got there" is the chain of
   members, joined to the change log by provenance.

A `c:PolicyList` component would show every policy: scope, on/off, stored
size, last written, a "Forget" button (a reaction clearing that policy's
storage). It also has a back side, like every view.

## How it runs (no engine change)

- **Boot**: load the app graph, then for each enabled policy read its scope,
  check `per:version` (and the shapes), apply the stored triples as one delta,
  then project. No flicker; the first render already has the state.
- **Write**: a runtime listener on input deltas. A delta that touches a
  policy's subject and properties, or for `per:construct` policies the
  predicates the query mentions, schedules that policy's write in idle time,
  debounced: re-run the CONSTRUCT, serialize as N-Triples, store, and append a
  `per:StateLog` member.
- **Turning a policy off** clears its storage. The `per:enabled` triple
  itself lives in a meta-policy at `per:Device`, so the switch's own state is
  remembered.

## Open questions for you

1. Default scope when unspecified: `per:Session` is my choice (least
   surprising; nothing survives closing the tab without asking).
2. Should remembering the change log be on by default in the demo (audit
   across reloads), or opt-in via a switch?
3. `per:Pod` (Solid) is natural here: the stored form is already RDF. Do you
   want that path designed now, or later?
