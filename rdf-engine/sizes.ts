// Where a wasm build's bytes go: function body sizes by name, from an
// unstripped build. `npx tsx rdf-engine/sizes.ts <file.wasm> [top]`
import { readFileSync } from 'node:fs'

const bytes = readFileSync(process.argv[2]!)
const top = Number(process.argv[3] ?? 40)
let at = 8
const leb = () => {
  let n = 0
  let shift = 0
  for (;;) {
    const b = bytes[at++]!
    n += (b & 0x7f) * 2 ** shift
    shift += 7
    if (b < 0x80) return n
  }
}
let imports = 0
const bodies: number[] = []
const names = new Map<number, string>()
const sections: [string, number][] = []
const sectionNames = ['custom', 'type', 'import', 'function', 'table', 'memory', 'global', 'export', 'start', 'element', 'code', 'data', 'datacount']
while (at < bytes.length) {
  const id = bytes[at++]!
  const size = leb()
  const end = at + size
  sections.push([sectionNames[id] ?? String(id), size])
  if (id === 2) {
    for (let n = leb(); n--; ) {
      at += leb()
      at += leb()
      const kind = bytes[at++]
      if (kind === 0) {
        leb()
        imports++
      } else if (kind === 1) {
        at++
        const f = bytes[at++]!
        leb()
        if (f & 1) leb()
      } else if (kind === 2) {
        const f = bytes[at++]!
        leb()
        if (f & 1) leb()
      } else at += 2
    }
  } else if (id === 10) {
    for (let n = leb(); n--; ) {
      const s = leb()
      bodies.push(s)
      at += s
    }
  } else if (id === 0) {
    const nameLen = leb()
    const name = bytes.subarray(at, at + nameLen).toString()
    at += nameLen
    if (name === 'name') {
      while (at < end) {
        const sub = bytes[at++]
        const subSize = leb()
        const subEnd = at + subSize
        if (sub === 1) {
          for (let n = leb(); n--; ) {
            const idx = leb()
            const l = leb()
            names.set(idx, bytes.subarray(at, at + l).toString())
            at += l
          }
        }
        at = subEnd
      }
    }
  }
  at = end
}
console.log(sections.map(([n, s]) => `${n} ${(s / 1024).toFixed(1)}K`).join(', '))
const rows = bodies.map((s, i) => [s, names.get(i + imports) ?? `#${i + imports}`] as const).sort((a, b) => b[0] - a[0])
const total = bodies.reduce((a, b) => a + b, 0)
console.log(`code: ${(total / 1024).toFixed(1)} KiB in ${bodies.length} functions`)
// Group by crate/module path prefix.
const groups = new Map<string, number>()
for (const [s, n] of rows) {
  const m = /(?:^|[<_ ])((?:core|alloc|semblance_rdf)::[a-z_0-9]+(?:::[a-z_0-9]+)?)/.exec(n.replace(/_\$LT\$|\$GT\$|\$u20\$/g, ' ').replace(/\.\./g, '::'))
  const k = m?.[1] ?? 'other'
  groups.set(k, (groups.get(k) ?? 0) + s)
}
for (const [k, s] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${(s / 1024).toFixed(1).padStart(7)}K  ${k}`)
console.log('')
for (const [s, n] of rows.slice(0, top)) console.log(`${String(s).padStart(7)}  ${n.slice(0, 140)}`)
