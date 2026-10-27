# Strict-CSP browser regression fixture

From an installed checkout with current `rdf-engine/build/wat.wasm`:

```sh
npx vite --config test/fixtures/csp/vite.config.mjs
```

Open `http://127.0.0.1:59118/` in an ordinary browser. The response disallows
inline style attributes (`style-src 'self'`) and loads the framework from this
checkout. It does not weaken the policy with `unsafe-inline`.

The two stock Progress/LineChart views share one graph and projection. The left
comparison renderer deliberately restores the original `setAttribute('style',
value)` behavior through the new style synchronization method. It is expected
to generate `style-src-attr` violations, leave the progress fill at zero and
lose the series stroke. The right uses the real DOM renderer and should fill
and color the same stock components, with no additional violations.

- Change progress from 75 to 25 percent. After its transition the fixed fill
  should take one quarter of its track; its keyed graph/DOM nodes persist.
- Try stock themes, Day/Night, a phone viewport and RTL. The graph values and
  series colors should still apply.
- The declaration probe starts with a quoted custom value containing `;` and
  `:`, a 70px width and an important color. Its button updates the width/value,
  removes the priority, then removes the style attribute entirely.
- The JSON readout reports computed state. While a stock motion transition is
  running, its immediate width can still show the preceding value; inspect
  again after the transition.

This is a browser fixture, because the test DOM does not enforce CSP or fully
implement CSS parsing/priorities. The automated renderer tests separately
cover RDF/HTML updates, removal, keyed identity and unchanged-render costs.
