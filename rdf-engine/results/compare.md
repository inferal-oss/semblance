# Engine comparison

## 2026-10-24 · Node v26.10.0 (darwin/arm64)

100,000 quads; 20,000 lookups of (s, p, ?) returning about 0.5 quads each. µs per op, best of 3.

| engine | wasm KiB (raw / gzip / brotli) | load N-Triples | add | match(s, p, ?) | match + read objects | remove + add | memory |
|---|---:|---:|---:|---:|---:|---:|---:|
| rust | 251.7 / 98.5 / 83.0 | 0.97 | 0.13 | 0.30 | 0.74 | 0.44 | 30.3 MiB |
| oxigraph | 4226.8 / 1476.7 / 1000.2 | 1.30 | 5.27 | 6.52 | 7.65 | 5.67 |  |
| n3 | JS | 2.30 | 0.43 | 2.02 | 2.33 | 1.18 |  |
