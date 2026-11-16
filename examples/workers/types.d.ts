// What the Worker imports (wrangler.jsonc): a .wasm module compiled at deploy time, Turtle as text.
declare module '*.wasm' {
  const module: WebAssembly.Module
  export default module
}
declare module '*.ttl' {
  const text: string
  export default text
}
