// The viewer's platform, for the keyboard layer's hints: the markup carries every key's Apple and
// other spelling, and the theme shows one by `:root[data-sem-platform=apple]` (no CSS media
// feature reports the operating system). A server-rendered page sets the switch from an inline
// script in its head (PLATFORM_SCRIPT, src/server/document.ts), before the first paint; a page the
// client renders itself sets it when it mounts (markPlatform). Both read the platform alike.

/** The attribute on <html> that says the viewer's platform. */
export const PLATFORM_ATTRIBUTE = 'data-sem-platform'

// macOS, iOS and iPadOS, as navigator.userAgentData.platform ("macOS", "iOS") or navigator.platform
// ("MacIntel", "iPhone", "iPad") names them. An iPad that reports itself as a Mac is Apple too.
const APPLE = /mac|iphone|ipad|ipod|ios/i

interface NavigatorLike {
  platform?: string
  userAgentData?: { platform?: string }
}

/** Whether `nav` is on an Apple platform. */
export function isApple(nav: NavigatorLike | undefined): boolean {
  return APPLE.test(nav?.userAgentData?.platform || nav?.platform || '')
}

/** Set the platform switch on `doc`'s root (only Apple platforms are marked). */
export function markPlatform(doc: Document, nav: NavigatorLike | undefined = globalThis.navigator): void {
  if (isApple(nav)) doc.documentElement.setAttribute(PLATFORM_ATTRIBUTE, 'apple')
}

/** The inline script a server-rendered page's head carries: markPlatform before the first paint, dependency-free. */
export const PLATFORM_SCRIPT = `(()=>{const n=navigator,p=(n.userAgentData&&n.userAgentData.platform)||n.platform||"";if(${APPLE}.test(p))document.documentElement.setAttribute("${PLATFORM_ATTRIBUTE}","apple")})()`
