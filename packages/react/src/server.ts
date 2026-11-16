// Server rendering of hosted components with React (docs/HOSTED.md): reactHosts with react-dom/server's
// renderToString, for `defineSite({ hosts })` and renderToString({ hosts }). The client mounts with the
// same components (`reactHosts` from the package's main entry) and React hydrates what this wrote.
import { renderToString } from 'react-dom/server'
import { reactHosts as clientHosts, type ReactHostsOptions } from './index.ts'

export * from './index.ts'

/** reactHosts that also renders on the server. */
export function reactHosts(opts: ReactHostsOptions) {
  return clientHosts({ renderToString, ...opts })
}
