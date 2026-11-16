// Protocol Buffers wire format, as much of it as Jelly needs (docs/JELLY.md): varints,
// length-delimited fields, and skipping the fields a reader does not know.

export class JellyError extends Error {}

const utf8 = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

/** Wire types. */
export const VARINT = 0
export const I64 = 1
export const LEN = 2
export const I32 = 5

/** A reader over `buf[pos, end)`. */
export class ProtoReader {
  constructor(
    readonly buf: Uint8Array,
    public pos = 0,
    public end = buf.length,
  ) {}

  get done(): boolean {
    return this.pos >= this.end
  }

  /** A varint as a number (exact up to 2^53; larger values saturate, which every check then refuses). */
  varint(): number {
    let x = 0
    let mul = 1
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new JellyError('truncated varint')
      const b = this.buf[this.pos++]!
      x += (b & 0x7f) * mul
      if (b < 0x80) return x
      mul *= 128
    }
    throw new JellyError('varint longer than 10 bytes')
  }

  /** A field tag: [field number, wire type]. */
  tag(): [number, number] {
    const t = this.varint()
    const field = Math.floor(t / 8)
    if (field === 0) throw new JellyError('field number 0')
    return [field, t & 7]
  }

  /** The bounds of a length-delimited field's bytes, and moves past them. */
  len(): [number, number] {
    const n = this.varint()
    const start = this.pos
    if (n > this.end - start) throw new JellyError('truncated field')
    this.pos = start + n
    return [start, start + n]
  }

  sub(): ProtoReader {
    const [s, e] = this.len()
    return new ProtoReader(this.buf, s, e)
  }

  string(): string {
    const [s, e] = this.len()
    try {
      return utf8.decode(this.buf.subarray(s, e))
    } catch {
      throw new JellyError('invalid UTF-8')
    }
  }

  skip(wire: number): void {
    if (wire === VARINT) this.varint()
    else if (wire === LEN) this.len()
    else if (wire === I64 || wire === I32) {
      const n = wire === I64 ? 8 : 4
      if (this.end - this.pos < n) throw new JellyError('truncated field')
      this.pos += n
    } else throw new JellyError(`unsupported wire type ${wire}`)
  }

  /** A varint field's value, checking its wire type. */
  uint(wire: number): number {
    if (wire !== VARINT) throw new JellyError('expected a varint field')
    return this.varint()
  }

  /** The varints of a repeated scalar field, packed or not, appended to `out`. */
  packed(wire: number, out: number[]): void {
    if (wire === VARINT) out.push(this.varint())
    else if (wire === LEN) {
      const [s, e] = this.len()
      const r = new ProtoReader(this.buf, s, e)
      while (!r.done) out.push(r.varint())
    } else throw new JellyError('expected a varint field')
  }
}

/** A growable byte buffer that writes the wire format. */
export class ProtoWriter {
  buf = new Uint8Array(256)
  pos = 0

  private room(n: number): void {
    if (this.pos + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.pos + n) size *= 2
    const b = new Uint8Array(size)
    b.set(this.buf.subarray(0, this.pos))
    this.buf = b
  }

  varint(x: number): void {
    this.room(10)
    while (x >= 0x80) {
      this.buf[this.pos++] = (x % 128) | 0x80
      x = Math.floor(x / 128)
    }
    this.buf[this.pos++] = x
  }

  tag(field: number, wire: number): void {
    this.varint(field * 8 + wire)
  }

  bytes(b: Uint8Array): void {
    this.room(b.length)
    this.buf.set(b, this.pos)
    this.pos += b.length
  }

  /** A varint field, left out when 0 (proto3). */
  uint(field: number, x: number): void {
    if (x === 0) return
    this.tag(field, VARINT)
    this.varint(x)
  }

  /** A string field, always written (repeated strings keep their empty values). */
  string(field: number, s: string): void {
    const b = encoder.encode(s)
    this.tag(field, LEN)
    this.varint(b.length)
    this.bytes(b)
  }

  /** A packed repeated varint field, left out when empty. */
  packed(field: number, xs: ArrayLike<number>, n = xs.length): void {
    if (n === 0) return
    let size = 0
    for (let i = 0; i < n; i++) size += varintSize(xs[i]!)
    this.tag(field, LEN)
    this.varint(size)
    for (let i = 0; i < n; i++) this.varint(xs[i]!)
  }

  /** A length-delimited field whose contents `write` produces (its length is patched in after). */
  message(field: number, write: (w: ProtoWriter) => void): void {
    const inner = new ProtoWriter()
    write(inner)
    this.tag(field, LEN)
    this.varint(inner.pos)
    this.bytes(inner.finish())
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos)
  }
}

export function varintSize(x: number): number {
  let n = 1
  while (x >= 0x80) {
    x = Math.floor(x / 128)
    n++
  }
  return n
}
