// Renames the single-file build to something shareable and reports its size.
import { renameSync, statSync } from 'node:fs'

const out = 'dist-single/semblance.html'
renameSync('dist-single/index.html', out)
console.log(`\n  ${out}  ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB, self-contained\n`)
