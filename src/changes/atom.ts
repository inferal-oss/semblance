// The change log as an Atom feed (RFC 4287): one entry per change, newest first, linking to its page
// on the site. Made from the same graph the Changes page shows (changeRecords), when the site is built.
import { Parser, Store } from 'n3'
import { NS } from '../ns.ts'

const RDF_TYPE = NS.rdf + 'type'
const LABEL = NS.rdfs + 'label'
const CHG = NS.chg

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const oneLine = (s: string) => s.replace(/[ \t\r\n]+/g, ' ').trim()

/** An Atom feed of the changes a change log (Turtle) holds; `site` is the site's address, ending with '/'. */
export function changesAtom(records: string, site: string): string {
  const store = new Store(new Parser().parse(records))
  const one = (s: string, p: string) => store.getObjects(s, p, null)[0]?.value
  const changes = store
    .getSubjects(RDF_TYPE, CHG + 'Change', null)
    .map((c) => {
      const release = one(c.value, CHG + 'releasedIn')
      return {
        iri: c.value,
        slug: one(c.value, NS.sem + 'slug') ?? c.value.replace(/^.*[#/]/, ''),
        title: one(c.value, LABEL) ?? c.value,
        date: one(c.value, CHG + 'recorded') ?? '1970-01-01',
        version: release ? one(release, CHG + 'version') : undefined,
        motivation: oneLine(one(c.value, CHG + 'motivation') ?? ''),
        substance: oneLine(one(c.value, CHG + 'substance') ?? ''),
      }
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug))
  const updated = (changes[0]?.date ?? '1970-01-01') + 'T00:00:00Z'
  const entries = changes.map(
    (c) => `  <entry>
    <id>${escape(c.iri)}</id>
    <title>${escape(c.title)}</title>
    <link href="${escape(`${site}changes/${encodeURIComponent(c.slug)}/`)}"/>
    <updated>${c.date}T00:00:00Z</updated>
    <category term="${escape(c.version ?? 'unreleased')}"/>
    <summary>${escape(c.motivation)}</summary>
    <content type="text">${escape(c.substance)}</content>
  </entry>`,
  )
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escape(site)}changes/</id>
  <title>Semblance: changes</title>
  <subtitle>What changed in every component, and how to move with it.</subtitle>
  <link href="${escape(site)}changes/"/>
  <link rel="self" href="${escape(site)}changes.atom"/>
  <updated>${updated}</updated>
  <author><name>Semblance</name></author>
${entries.join('\n')}
</feed>
`
}
