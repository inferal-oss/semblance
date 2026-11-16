import { clickThroughPages, sitePages } from './site-clicks.ts'

// Home, the reference and every docs section, clicked through (test/site-clicks.ts).
const pages = sitePages()
clickThroughPages('the site clicked through: home, reference and docs', [...pages.home, ...pages.docs])
