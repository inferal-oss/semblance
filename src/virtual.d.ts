// The Vite plugin's module (src/node/vite.ts, docs/SUBSET.md): the part of Semblance's ontology a
// site's graphs use (Site.subset), as Turtle for mount's `ontology`; undefined when it ships whole.
// An app outside this repository references it: /// <reference types="@inferal-oss/semblance/virtual" />
declare module 'virtual:semblance/ontology' {
  const turtle: string | undefined
  export default turtle
}
