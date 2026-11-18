// Markdown from a screen projection (src/render/markdown.ts): what a page shows, as Markdown, the same
// whichever side of a rendering (its SPARQL rule or its function twin) drew it.
import { afterEach, describe, expect, it } from 'vitest'
import { loadStore } from '../src/node/load.ts'
import { DEFAULT_LAYERS, MOD, NS } from '../src/ns.ts'
import { markdownText, toMarkdown, type MarkdownOptions } from '../src/render/markdown.ts'
import { Runtime } from '../src/runtime.ts'

const EX = 'https://example.org/md#'
const graph = `@prefix ex: <${EX}> . @prefix c: <${NS.c}> . @prefix sty: <${NS.sty}> .
ex:root a c:Stack ; c:children ( ex:title ex:intro ex:link ex:away ex:code ex:inline ex:note ex:rule ex:sub ex:ask ) .
ex:title a c:Heading ; c:level 1 ; c:label "A page, read as Markdown" .
ex:intro a c:Text ; c:label "Text with *stars*, [brackets], a_snake_case name and _underscores_ stays text." .
ex:link a c:Link ; c:href "/docs/rules/" ; c:label "the rules" .
ex:away a c:Link ; c:href "https://example.org/elsewhere" ; c:label "elsewhere" ; c:external true .
ex:code a c:Code ; c:block true ; c:language "turtle" ; c:label """ex:a a c:Button ;
    c:label \`\`\`Go\`\`\` .""" .
ex:inline a c:Code ; c:label "c:Button" .
ex:note a c:Alert ; c:label "Careful" ; c:help "It says what to watch." .
ex:rule a c:Divider .
ex:sub a c:Heading ; c:level 2 ; c:label "# Not a heading of its own" .
ex:ask a c:Button ; c:label "A control, not content" .`

const live: Runtime[] = []
afterEach(() => {
  for (const r of live.splice(0)) r.dispose()
})

function markdown(prefer: 'sparql' | 'function', opts?: MarkdownOptions) {
  const runtime = new Runtime(loadStore('wat', graph))
  live.push(runtime)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, roots: [EX + 'root'], prefer })
  return toMarkdown(screen.index, EX + 'root', opts)
}

describe('Markdown of a screen projection', () => {
  it('is the same by SPARQL and by function', () => {
    expect(markdown('sparql')).toBe(markdown('function'))
  })

  it('reads headings, paragraphs, links, code, quotes and rules as Markdown', () => {
    const md = markdown('sparql')
    expect(md).toMatch(/^# A page, read as Markdown\n\n/)
    // Its own characters are text, not emphasis or links; an underscore inside a word stays as it is.
    expect(md).toContain('Text with \\*stars\\*, \\[brackets\\], a_snake_case name and \\_underscores\\_ stays text.')
    // Inline siblings flow into one paragraph, as in the page's HTML.
    expect(md).toContain('\n\n[the rules](/docs/rules/) [elsewhere](https://example.org/elsewhere)\n\n')
    // A link that opens a new tab: no "opens in a new tab", no arrow (both are for the page).
    expect(md).not.toMatch(/new tab|↗/)
    expect(md).toContain('````turtle\nex:a a c:Button ;\n    c:label ```Go``` .\n````')
    expect(md).toContain('`c:Button`')
    expect(md).toMatch(/> \*\*Careful\*\*\n>\n> It says what to watch\./)
    expect(md).toContain('\n\n---\n\n')
    expect(md).toContain('## # Not a heading of its own')
    expect(md).not.toContain('A control, not content')
  })

  it('sends links where the reader of the Markdown should go', () => {
    const md = markdown('sparql', { link: (href) => (href === '/docs/rules/' ? 'https://example.org/rules.md' : href.startsWith('https:') ? undefined : href) })
    // No link: the text alone.
    expect(md).toContain('\n\n[the rules](https://example.org/rules.md) elsewhere\n\n')
  })

  it('escapes text that would read as Markdown', () => {
    expect(markdownText('a [b] *c* `d` <e> f_g _h_')).toBe('a \\[b\\] \\*c\\* \\`d\\` \\<e> f_g \\_h\\_')
  })
})
