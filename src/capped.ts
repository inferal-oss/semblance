// A host cache with a cap (docs/RETENTION.md, host caches): past it, setting a new key forgets the
// oldest one, in insertion order. For caches of what is cheap to make again (term objects, parsed
// dependencies, per-node lookups) that would otherwise keep every key they ever saw.

/** A Map holding at most `cap` entries: a new key past the cap forgets the oldest. */
export class CappedMap<K, V> extends Map<K, V> {
  constructor(readonly cap: number) {
    super()
  }

  override set(key: K, value: V): this {
    if (this.size >= this.cap && !this.has(key)) {
      const oldest = this.keys().next()
      if (!oldest.done) this.delete(oldest.value)
    }
    return super.set(key, value)
  }
}
