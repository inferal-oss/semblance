// A minimal DevTools protocol client and a headless Chromium to drive with it: the layout checker
// (scripts/layout-check.ts) measures pages with it, and the click test (test/clicks.test.ts) clicks
// with real mouse input. Playwright's cached Chromium is used, or SEMBLANCE_CHROME.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** The headless Chromium to drive, if there is one. */
export function chromePath(): string | undefined {
  if (process.env.SEMBLANCE_CHROME) return process.env.SEMBLANCE_CHROME
  const roots = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]
  for (const r of roots) {
    if (!existsSync(r)) continue
    for (const d of readdirSync(r).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
      for (const sub of readdirSync(join(r, d))) {
        const bin = join(r, d, sub, 'chrome-headless-shell')
        if (existsSync(bin)) return bin
      }
    }
  }
  return undefined
}

function chrome(): string {
  const bin = chromePath()
  if (!bin) throw new Error('no headless Chromium found; set SEMBLANCE_CHROME')
  return bin
}

/** A minimal DevTools protocol client over one page session. */
export class Cdp {
  private id = 0
  private waiting = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>()
  sessionId = ''
  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id !== undefined) this.waiting.get(m.id)?.(m)
    })
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url)
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok)
      ws.addEventListener('error', fail)
    })
    return new Cdp(ws)
  }
  send<T = any>(method: string, params: object = {}, session = true): Promise<T> {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params, ...(session && this.sessionId ? { sessionId: this.sessionId } : {}) }))
    return new Promise((ok, fail) =>
      this.waiting.set(id, (r) => {
        this.waiting.delete(id)
        if (r.error) fail(new Error(method + ': ' + r.error.message))
        else ok(r.result as T)
      }),
    )
  }
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value as T
  }
  close() {
    this.ws.close()
  }
}

export async function launch(): Promise<{ cdp: Cdp; stop: () => void }> {
  const profile = join(tmpdir(), 'semblance-layout-' + process.pid)
  const proc = spawn(chrome(), ['--headless', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--hide-scrollbars', '--font-render-hinting=none', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const url = await new Promise<string>((ok, fail) => {
    let err = ''
    proc.stderr!.on('data', (d) => {
      err += d
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err)
      if (m) ok(m[1])
    })
    proc.on('exit', () => fail(new Error('chrome exited: ' + err)))
  })
  // never leave a browser behind, however this process ends
  process.on('exit', () => proc.kill())
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(1))
  const cdp = await Cdp.connect(url)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }, false)
  cdp.sessionId = (await cdp.send('Target.attachToTarget', { targetId, flatten: true }, false)).sessionId
  await cdp.send('Runtime.enable')
  return { cdp, stop: () => (cdp.close(), proc.kill()) }
}
