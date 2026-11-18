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

// A page with controls and what they hold: a code editor, tabs, a mention in running text, fields.
const controls = `@prefix ex: <${EX}> . @prefix c: <${NS.c}> .
ex:page a c:Stack ; c:children ( ex:h ex:editor ex:tabs ex:said ex:name ex:agree ex:go ) .
ex:h a c:Heading ; c:level 1 ; c:label "Controls" .
ex:editor a c:CodeEditor ; c:label "app.ttl" ; c:language "Turtle" ; c:value """ex:a a c:Button ;
    c:label "Go" .""" .
ex:tabs a c:Tabs ; c:tabs ( ex:t1 ex:t2 ) .
ex:t1 a c:Tab ; c:label "First" ; c:content ex:p1 .
ex:t2 a c:Tab ; c:label "Second" ; c:content ex:p2 .
ex:p1 a c:Text ; c:label "In the first tab." .
ex:p2 a c:Text ; c:label "In the second tab." .
ex:said a c:Text ; c:children ( "A card such as " ex:m " is data." ) .
ex:m a c:Mention ; c:label "kb:c4" ; c:mentions ex:c4 .
ex:name a c:TextField ; c:label "Your name" ; c:value "Ada" .
ex:agree a c:Checkbox ; c:label "I agree" ; c:checked true .
ex:go a c:Button ; c:label "Go" .`

function controlsMarkdown(prefer: 'sparql' | 'function', opts?: MarkdownOptions, hidden: 'wait' | 'render' = 'render') {
  const runtime = new Runtime(loadStore('wat', controls))
  live.push(runtime)
  const screen = runtime.project({ modality: MOD.Screen, layers: DEFAULT_LAYERS, roots: [EX + 'page'], prefer, hidden })
  return toMarkdown(screen.index, EX + 'page', opts)
}

describe('Markdown of a page with controls', () => {
  it('is the same by SPARQL and by function', () => {
    expect(controlsMarkdown('sparql')).toBe(controlsMarkdown('function'))
    expect(controlsMarkdown('sparql', { controls: true })).toBe(controlsMarkdown('function', { controls: true }))
  })

  it('reads a code editor as a code block in its language, without its keys hint', () => {
    const md = controlsMarkdown('sparql')
    expect(md).toContain('\n\n```turtle\nex:a a c:Button ;\n    c:label "Go" .\n```')
    expect(md).not.toMatch(/accepts a suggestion/)
  })

  it('reads every tab panel under its tab, the hidden ones too, when the projection renders what is hidden', () => {
    const md = controlsMarkdown('sparql')
    expect(md).toContain('**First**\n\nIn the first tab.')
    expect(md).toContain('**Second**\n\nIn the second tab.')
    // A projection that parks what is hidden has nothing in the other panel yet.
    expect(controlsMarkdown('sparql', {}, 'wait')).not.toContain('In the second tab.')
  })

  it('keeps a mention in running text as its words, and leaves controls and their labels out', () => {
    const md = controlsMarkdown('sparql')
    expect(md).toContain('A card such as kb:c4 is data.')
    // After the code block: no field, no label, no button.
    expect(md.split('```').at(-1)).not.toMatch(/Your name|Ada|I agree|\bGo\b/)
  })

  it('reads controls as their words when they are what a page shows', () => {
    const md = controlsMarkdown('sparql', { controls: true })
    expect(md).toContain('Your name')
    expect(md).toContain('Ada')
    expect(md).toContain('☑ I agree')
    expect(md).toMatch(/\n\nGo$/)
  })

  it('moves headings under the page that holds them', () => {
    expect(controlsMarkdown('sparql', { headings: 3 })).toMatch(/^### Controls\n\n/)
    expect(controlsMarkdown('sparql', { headings: 1 })).toMatch(/^# Controls\n\n/)
  })
})
