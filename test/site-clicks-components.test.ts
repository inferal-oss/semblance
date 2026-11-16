import { clickThroughPages, sitePages } from './site-clicks.ts'

// Every component page, clicked through (test/site-clicks.ts).
clickThroughPages('the site clicked through: the component pages', sitePages().components)
