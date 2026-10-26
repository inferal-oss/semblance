// The full suite, in shards: each shard is its own run through scripts/test-queue.sh, so each stays
// well within the queue's per-run limit (SEMBLANCE_RUN_LIMIT, 1800 s), and the shards together
// report one result.
//
//   npm run test:full                    all shards, at most two of them in the queue at a time
//   npm run test:full -- --list          the shards and their expected times, without running them
//   npm run test:full -- --only=soak,3   only these shards (by name or number)
//   npm run test:full -- --update-timings   also write the measured times to test/timings.json
//   npm run test:full -- --budget=300    pack the shards to this many seconds of tests (900)
//   npm run test:full -- --parallel=1    at most this many shards in the queue at a time (2)
//
// The slow files run alone (ALONE). The rest are packed into shards by the per-file times in
// test/timings.json (longest first, each into the least loaded shard, until a shard would pass
// SHARD_BUDGET); a file without a recorded time counts as DEFAULT_SECONDS. A file's time is its
// whole run in the JSON report (loading and setup included), measured on a busy machine, so a shard
// of 2 workers takes about half its sum: some 450 s under load, well within the queue's limit. Each shard waits its turn in the queue like any other run; at most PARALLEL of them
// hold a ticket at a time, so the suite neither floods the queue nor goes back to the end of it
// after every shard.
//
// Exit status: 0 when every shard passed, 1 otherwise (a failed test, a file that did not load, or
// a shard the queue stopped at its limit). Logs are kept in .test-full/ (one per shard).

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const TIMINGS = resolve(root, 'test/timings.json')
const OUT = resolve(root, '.test-full')
// Files that run in a shard of their own: the soak and the whole-app shell tests.
const ALONE = ['test/soak.test.ts', 'test/shell.test.ts']
// Seconds of summed file time per packed shard (about half of it in wall time with two workers).
const SHARD_BUDGET = Number(process.argv.find(a => a.startsWith('--budget='))?.split('=')[1] ?? 900)
const DEFAULT_SECONDS = 20
const PARALLEL = Number(process.argv.find(a => a.startsWith('--parallel='))?.split('=')[1] ?? 2)

const args = process.argv.slice(2)
const flag = (name: string) => args.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
const only = flag('only')?.split('=')[1]?.split(',')
const updateTimings = !!flag('update-timings')

const files = readdirSync(resolve(root, 'test'))
  .filter(f => f.endsWith('.test.ts'))
  .map(f => `test/${f}`)
  .sort()
const timings: Record<string, number> = existsSync(TIMINGS) ? JSON.parse(readFileSync(TIMINGS, 'utf8')) : {}
const seconds = (f: string) => timings[f] ?? DEFAULT_SECONDS

interface Shard { name: string; files: string[] }
const shards: Shard[] = ALONE.filter(f => files.includes(f)).map(f => ({
  name: f.replace(/^test\/|\.test\.ts$/g, ''),
  files: [f],
}))
{
  const rest = files.filter(f => !ALONE.includes(f)).sort((a, b) => seconds(b) - seconds(a) || a.localeCompare(b))
  const total = rest.reduce((s, f) => s + seconds(f), 0)
  const bins: string[][] = Array.from({ length: Math.max(1, Math.ceil(total / SHARD_BUDGET)) }, () => [])
  const load = (b: string[]) => b.reduce((s, f) => s + seconds(f), 0)
  for (const f of rest) bins.reduce((m, b) => (load(b) < load(m) ? b : m)).push(f)
  bins.forEach((b, i) => shards.push({ name: String(i + 1), files: b.sort() }))
}
const expected = (s: Shard) => s.files.reduce((t, f) => t + seconds(f), 0)

if (flag('list')) {
  for (const s of shards) console.log(`${s.name.padEnd(6)} ${String(Math.round(expected(s))).padStart(5)} s  ${s.files.join(' ')}`)
  process.exit(0)
}

interface JsonAssertion { fullName: string; status: string; failureMessages: string[]; duration?: number }
interface JsonFile { name: string; status: string; message?: string; startTime?: number; endTime?: number; assertionResults: JsonAssertion[] }
interface Result {
  shard: Shard
  status: number
  wall: number
  waited: number
  failures: { file: string; test: string; message: string }[]
  unfinished: string[]
  counts: { passed: number; failed: number; skipped: number }
}

const run = (shard: Shard): Promise<Result> =>
  new Promise(done => {
    const json = resolve(OUT, `shard-${shard.name}.json`)
    const log = resolve(OUT, `shard-${shard.name}.log`)
    rmSync(json, { force: true })
    const queued = Date.now()
    let started = 0
    const cmd = [
      'scripts/test-queue.sh', 'npx', 'vitest', 'run', '--maxWorkers=2',
      '--reporter=default', '--reporter=json', `--outputFile.json=${json}`,
      ...shard.files,
    ]
    const child = spawn(cmd[0], cmd.slice(1), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', c => {
      // vitest's first output marks the end of the wait in the queue.
      started ||= Date.now()
      chunks.push(c)
    })
    child.stderr.on('data', c => {
      chunks.push(c)
      // The queue's own messages (waiting, stopped) are worth seeing as they happen.
      for (const line of String(c).split('\n')) if (line.startsWith('[test-queue]')) console.log(`  shard ${shard.name}: ${line}`)
    })
    child.on('close', code => {
      writeFileSync(log, Buffer.concat(chunks))
      const result: Result = {
        shard, status: code ?? 1,
        wall: (Date.now() - (started || queued)) / 1000, waited: ((started || Date.now()) - queued) / 1000,
        failures: [], unfinished: [], counts: { passed: 0, failed: 0, skipped: 0 },
      }
      const seen = new Set<string>()
      if (existsSync(json)) {
        const report = JSON.parse(readFileSync(json, 'utf8')) as { testResults: JsonFile[] }
        for (const file of report.testResults) {
          const name = relative(root, file.name)
          seen.add(name)
          let time = 0
          for (const a of file.assertionResults) {
            time += (a.duration ?? 0) / 1000
            if (a.status === 'passed') result.counts.passed++
            else if (a.status === 'failed') {
              result.counts.failed++
              result.failures.push({ file: name, test: a.fullName, message: a.failureMessages[0] ?? '' })
            } else result.counts.skipped++
          }
          if (file.status === 'failed' && !file.assertionResults.some(a => a.status === 'failed')) {
            result.failures.push({ file: name, test: '(file)', message: file.message ?? 'failed to run' })
          }
          // The file's whole time (loading and setup included) where the report has it.
          if (file.startTime && file.endTime) time = (file.endTime - file.startTime) / 1000
          measured[name] = Math.round(time * 10) / 10
        }
      }
      result.unfinished = shard.files.filter(f => !seen.has(f))
      done(result)
    })
  })

const firstLine = (s: string) => s.split('\n').find(l => l.trim())?.trim().slice(0, 200) ?? ''
const measured: Record<string, number> = {}
mkdirSync(OUT, { recursive: true })
const chosen = only ? shards.filter((s, i) => only.includes(s.name) || only.includes(String(i + 1))) : shards
const results: Result[] = []
const t0 = Date.now()
let next = 0
const worker = async () => {
  while (next < chosen.length) {
    const i = next++
    const shard = chosen[i]
    console.log(`[test-full] shard ${shard.name} (${i + 1}/${chosen.length}): ${shard.files.length} files, ~${Math.round(expected(shard))} s of tests`)
    const r = await run(shard)
    results[i] = r
    const verdict = r.status === 124 ? 'STOPPED at the queue limit' : r.status === 0 ? 'passed' : 'FAILED'
    console.log(`[test-full] shard ${shard.name}: ${verdict} in ${Math.round(r.wall)} s after ${Math.round(r.waited)} s in the queue (${r.counts.passed} passed, ${r.counts.failed} failed, ${r.counts.skipped} skipped)`)
  }
}
await Promise.all(Array.from({ length: Math.max(1, PARALLEL) }, worker))

console.log(`\n[test-full] summary, ${Math.round((Date.now() - t0) / 1000)} s`)
for (const r of results) {
  const verdict = r.status === 124 ? 'STOPPED (timed out)' : r.status === 0 ? 'ok' : 'FAILED'
  console.log(`  ${r.shard.name.padEnd(6)} ${verdict.padEnd(20)} ${String(Math.round(r.wall)).padStart(5)} s  ${r.counts.passed} passed, ${r.counts.failed} failed  (.test-full/shard-${r.shard.name}.log)`)
  for (const f of r.unfinished) console.log(`         did not finish: ${f}`)
  for (const f of r.failures) console.log(`         ✗ ${f.file} > ${f.test}\n           ${firstLine(f.message)}`)
  if (r.status !== 0 && r.status !== 124 && !r.failures.length && !r.unfinished.length) console.log(`         exited ${r.status}: see the log`)
}
const failed = results.filter(r => r.status !== 0)
const total = results.reduce((s, r) => ({ passed: s.passed + r.counts.passed, failed: s.failed + r.counts.failed }), { passed: 0, failed: 0 })
console.log(`[test-full] ${failed.length ? 'FAILED' : 'passed'}: ${total.passed} tests passed, ${total.failed} failed, ${failed.length} of ${results.length} shards failed`)

if (updateTimings) {
  const merged = Object.fromEntries(Object.entries({ ...timings, ...measured }).filter(([f]) => files.includes(f)).sort())
  writeFileSync(TIMINGS, JSON.stringify(merged, null, 2) + '\n')
  console.log(`[test-full] wrote ${relative(root, TIMINGS)}`)
}
process.exit(failed.length ? 1 : 0)
