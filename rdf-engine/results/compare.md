# Engine comparison

## 2026-10-24 · Node v26.10.0 (darwin/arm64)

100,000 quads; 20,000 lookups of (s, p, ?) returning about 0.5 quads each. µs per op, best of 3.

| engine | wasm KiB (raw / gzip / brotli) | load N-Triples | add | match(s, p, ?) | match + read objects | remove + add | memory |
|---|---:|---:|---:|---:|---:|---:|---:|
| rust | 31.3 / 13.0 / 11.2 | 0.83 | 0.14 | 0.32 | 0.72 | 0.41 | 30.3 MiB |
| wat | 8.8 / 4.5 / 4.1 | 0.29 | 0.03 | 0.18 | 0.63 | 0.07 | 26.7 MiB |
| oxigraph | 4226.8 / 1476.7 / 1000.2 | 1.31 | 5.09 | 6.33 | 7.74 | 5.71 |  |
| n3 | JS | 3.09 | 0.62 | 2.03 | 2.16 | 0.83 |  |
