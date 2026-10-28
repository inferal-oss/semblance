// A render worker of buildSite (src/node/site.ts): renders the pages of the job it is sent.
import { renderPages, type PagesJob } from './site.ts'

process.once('message', async (job: PagesJob) => {
  try {
    const { bytes, css } = await renderPages(job)
    process.send!({ ok: true, bytes, css })
  } catch (e) {
    process.send!({ ok: false, error: String((e as Error)?.stack ?? e) })
  }
})
