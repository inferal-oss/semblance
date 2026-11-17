// A V8 heap snapshot summarised by what holds the memory: self size by constructor (objects) or by
// type (strings, arrays, code, native), the largest first, without loading the snapshot as one
// JSON value (a site's snapshot is over a gigabyte). With a second snapshot, the difference.
//
//   npx tsx scripts/heap-summary.ts a.heapsnapshot [b.heapsnapshot] [--top 40]
//   npx tsx scripts/heap-summary.ts a.heapsnapshot --retainers 'object: gH' [--depth 5]
//
// --retainers: for each node of that group, the path to its first owner that is a named object (not a
// plain Object, Array, Map, Set or an internal array), by edge names, and the self size of the nodes
// under each path: who holds them. scripts/memory-walk.ts --snapshot writes the snapshots.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs'

const args = process.argv.slice(2)
const files = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const top = Number(args[args.indexOf('--top') + 1]) || 40

/** The byte offset of the first occurrence of `needle` at or after `from`. */
function find(fd: number, needle: string, from = 0): number {
  const n = Buffer.from(needle)
  const chunk = Buffer.alloc(1 << 24)
  let pos = from
  for (;;) {
    const got = readSync(fd, chunk, 0, chunk.length, pos)
    if (got <= 0) return -1
    const i = chunk.subarray(0, got).indexOf(n)
    if (i >= 0) return pos + i
    if (got < chunk.length) return -1
    pos += got - n.length
  }
}

/** The integers of a JSON array starting at `at` (just after its `[`), into a growable Float64Array. */
function numbers(fd: number, at: number): Float64Array {
  let out = new Float64Array(1 << 22)
  let len = 0
  const chunk = Buffer.alloc(1 << 24)
  let pos = at
  let cur = 0
  let inNum = false
  let neg = false
  for (;;) {
    const got = readSync(fd, chunk, 0, chunk.length, pos)
    if (got <= 0) break
    for (let i = 0; i < got; i++) {
      const c = chunk[i]!
      if (c >= 48 && c <= 57) {
        cur = cur * 10 + (c - 48)
        inNum = true
      } else if (c === 45) neg = true
      else {
        if (inNum) {
          if (len === out.length) {
            const b = new Float64Array(out.length * 2)
            b.set(out)
            out = b
          }
          out[len++] = neg ? -cur : cur
        }
        cur = 0
        inNum = false
        neg = false
        if (c === 93) return out.subarray(0, len)
      }
    }
    pos += got
  }
  return out.subarray(0, len)
}

/** The strings array (each element parsed on its own). */
function strings(fd: number, at: number): string[] {
  const size = fstatSync(fd).size
  const out: string[] = []
  const chunk = Buffer.alloc(1 << 24)
  let pos = at
  let buf: number[] = []
  let inStr = false
  let esc = false
  let start = -1
  let carry: Buffer | undefined
  while (pos < size) {
    const got = readSync(fd, chunk, 0, chunk.length, pos)
    if (got <= 0) break
    let data = chunk.subarray(0, got)
    if (carry) data = Buffer.concat([carry, data])
    carry = undefined
    start = inStr ? 0 : -1
    for (let i = 0; i < data.length; i++) {
      const c = data[i]!
      if (inStr) {
        if (esc) esc = false
        else if (c === 92) esc = true
        else if (c === 34) {
          inStr = false
          out.push(JSON.parse(data.subarray(start, i + 1).toString('utf8')))
        }
      } else if (c === 34) {
        inStr = true
        start = i
      } else if (c === 93) return out
    }
    if (inStr) carry = Buffer.from(data.subarray(start)), (inStr = false), (esc = false)
    // (Re-scan the carried part from its opening quote.)
    pos += got
    void buf
  }
  return out
}

interface Loaded {
  nodes: Float64Array
  edges: Float64Array
  strs: string[]
  nf: number
  ef: number
  types: string[]
  edgeTypes: string[]
  iType: number
  iName: number
  iSize: number
  iEdges: number
}

function load(file: string, withEdges: boolean): Loaded {
  const fd = openSync(file, 'r')
  const head = Buffer.alloc(8192)
  readSync(fd, head, 0, head.length, 0)
  const metaEnd = head.indexOf('"nodes"')
  const meta = JSON.parse(head.subarray(head.indexOf('{', 1), head.lastIndexOf('}', metaEnd) + 1).toString())
  const m = (meta.meta ?? meta) as { node_fields: string[]; node_types: (string[] | string)[]; edge_fields: string[]; edge_types: (string[] | string)[] }
  const nodesAt = find(fd, '"nodes":[') + 9
  const nodes = numbers(fd, nodesAt)
  const edgesAt = find(fd, '"edges":[', nodesAt) + 9
  const edges = withEdges ? numbers(fd, edgesAt) : new Float64Array(0)
  const stringsAt = find(fd, '"strings":[', edgesAt) + 11
  const strs = strings(fd, stringsAt)
  closeSync(fd)
  const f = m.node_fields
  return { nodes, edges, strs, nf: f.length, ef: m.edge_fields.length, types: m.node_types[0] as string[], edgeTypes: m.edge_types[0] as string[], iType: f.indexOf('type'), iName: f.indexOf('name'), iSize: f.indexOf('self_size'), iEdges: f.indexOf('edge_count') }
}

function groupOf(l: Loaded, i: number): string {
  const type = l.types[l.nodes[i + l.iType]!]!
  const name = l.strs[l.nodes[i + l.iName]!] ?? '?'
  if (type === 'object' || type === 'closure' || type === 'native') return `${type}: ${name.slice(0, 60)}`
  if (type === 'hidden' || type === 'synthetic' || type === 'array' || type === 'code' || type === 'object shape') return `${type}: ${name.replace(/\d+/g, '#').slice(0, 60)}`
  return `(${type})`
}

/** Who holds the nodes of a group: the path of edge names up to the first named owner. */
function retainers(file: string, group: string, depth: number) {
  const l = load(file, true)
  const n = l.nodes.length / l.nf
  // Reverse edges: for each node, its retainers (node index, edge name).
  const count = new Uint32Array(n + 1)
  const edgeFrom = new Uint32Array(l.edges.length / l.ef)
  let e = 0
  for (let i = 0; i < n; i++) {
    const k = l.nodes[i * l.nf + l.iEdges]!
    for (let j = 0; j < k; j++, e++) {
      edgeFrom[e] = i
      const to = l.edges[e * l.ef + 2]! / l.nf
      count[to + 1]!++
    }
  }
  for (let i = 0; i < n; i++) count[i + 1]! += count[i]!
  const firstOf = count.slice()
  const rev = new Uint32Array(e)
  for (let x = 0; x < e; x++) {
    const to = l.edges[x * l.ef + 2]! / l.nf
    rev[firstOf[to]!++] = x
  }
  const weak = l.edgeTypes.indexOf('weak')
  const edgeName = (x: number) => {
    const t = l.edgeTypes[l.edges[x * l.ef]!]
    const v = l.edges[x * l.ef + 1]!
    return t === 'element' || t === 'hidden' ? `[]` : t === 'internal' && /^\d+$/.test(l.strs[v] ?? '') ? '[#]' : (l.strs[v] ?? String(v)).replace(/^\d+$/, '#').slice(0, 30)
  }
  const plain = /^(object: (Object|Array|Map|Set)|array: |hidden: |\(|native: system)/
  const out = new Map<string, { size: number; count: number }>()
  for (let i = 0; i < n; i++) {
    if (groupOf(l, i * l.nf) !== group) continue
    const path: string[] = []
    let cur = i
    for (let d = 0; d < depth; d++) {
      let best = -1
      for (let r = count[cur]!; r < count[cur + 1]!; r++) {
        const x = rev[r]!
        if (l.edges[x * l.ef]! === weak) continue
        const from = edgeFrom[x]!
        if (from === cur) continue
        best = x
        // Prefer an owner that is not a system root.
        if (!groupOf(l, from * l.nf).startsWith('(') && !groupOf(l, from * l.nf).startsWith('synthetic')) break
      }
      if (best < 0) break
      const from = edgeFrom[best]!
      const g = groupOf(l, from * l.nf)
      path.push(`${edgeName(best)} <- ${g}`)
      cur = from
      if (!plain.test(g)) break
    }
    const key = path.join('  ')
    const o = out.get(key) ?? { size: 0, count: 0 }
    o.size += l.nodes[i * l.nf + l.iSize]!
    o.count++
    out.set(key, o)
  }
  const rows = [...out].sort((a, b) => b[1].size - a[1].size).slice(0, top)
  for (const [k, v] of rows) console.log(`${fmt(v.size)} MiB ${String(v.count).padStart(8)}  ${k}`)
}

interface Summary {
  total: number
  count: number
  groups: Map<string, { size: number; count: number }>
}

function summarise(file: string): Summary {
  const fd = openSync(file, 'r')
  const head = Buffer.alloc(8192)
  readSync(fd, head, 0, head.length, 0)
  const metaEnd = head.indexOf('"nodes"')
  const meta = JSON.parse(head.subarray(head.indexOf('{', 1), head.lastIndexOf('}', metaEnd) + 1).toString().replace(/^\{"meta":/, '{"meta":'))
  const m = (meta.meta ?? meta) as { node_fields: string[]; node_types: (string[] | string)[] }
  const fields = m.node_fields
  const types = m.node_types[0] as string[]
  const nf = fields.length
  const iType = fields.indexOf('type')
  const iName = fields.indexOf('name')
  const iSize = fields.indexOf('self_size')
  const nodesAt = find(fd, '"nodes":[') + 9
  const nodes = numbers(fd, nodesAt)
  const stringsAt = find(fd, '"strings":[', nodesAt) + 11
  const strs = strings(fd, stringsAt)
  closeSync(fd)
  const groups = new Map<string, { size: number; count: number }>()
  let total = 0
  for (let i = 0; i < nodes.length; i += nf) {
    const type = types[nodes[i + iType]!]!
    const size = nodes[i + iSize]!
    total += size
    let key: string
    if (type === 'object' || type === 'closure' || type === 'native') key = `${type}: ${(strs[nodes[i + iName]!] ?? '?').slice(0, 60)}`
    else if (type === 'hidden' || type === 'synthetic' || type === 'array' || type === 'code' || type === 'object shape') key = `${type}: ${(strs[nodes[i + iName]!] ?? '?').replace(/\d+/g, '#').slice(0, 60)}`
    else key = `(${type})`
    const g = groups.get(key) ?? { size: 0, count: 0 }
    g.size += size
    g.count++
    groups.set(key, g)
  }
  return { total, count: nodes.length / nf, groups }
}

const MIB = 2 ** 20
const fmt = (n: number) => (n / MIB).toFixed(1).padStart(7)
const ri = args.indexOf('--retainers')
if (ri >= 0) {
  const di = args.indexOf('--depth')
  retainers(files[0]!, args[ri + 1]!, di >= 0 ? Number(args[di + 1]) : 5)
  process.exit(0)
}
const a = summarise(files[0]!)
const b = files[1] ? summarise(files[1]) : undefined
console.log(`${files[0]}: ${fmt(a.total)} MiB in ${a.count} nodes`)
if (b) console.log(`${files[1]}: ${fmt(b.total)} MiB in ${b.count} nodes`)
const keys = new Set([...a.groups.keys(), ...(b?.groups.keys() ?? [])])
const rows = [...keys].map((k) => ({ k, a: a.groups.get(k)?.size ?? 0, ac: a.groups.get(k)?.count ?? 0, b: b?.groups.get(k)?.size ?? 0, bc: b?.groups.get(k)?.count ?? 0 }))
rows.sort((x, y) => (b ? Math.abs(y.b - y.a) - Math.abs(x.b - x.a) : y.a - x.a))
console.log(b ? '   a MiB    b MiB    Δ MiB   a count   b count  group' : '     MiB      count  group')
for (const r of rows.slice(0, top))
  console.log(b ? `${fmt(r.a)}  ${fmt(r.b)}  ${fmt(r.b - r.a)}  ${String(r.ac).padStart(8)}  ${String(r.bc).padStart(8)}  ${r.k}` : `${fmt(r.a)}  ${String(r.ac).padStart(9)}  ${r.k}`)
