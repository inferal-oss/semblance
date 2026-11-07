# Block documents

Design of the block editor (#290). A document is a tree of blocks in DoCo and the Pattern Ontology; the
editor (`c:BlockEditor`) edits it in place. Everything below is graph state, rules and reactions; the
host only maps the browser's text positions to the graph's and back.

## Vocabulary

What the established vocabularies say, used as they are:

| need | term |
|---|---|
| what a block is (structurally) | Pattern Ontology (`po:` = `http://www.essepuntato.it/2008/12/pattern#`): `po:Block` (text and inline elements), `po:Container` (blocks only), `po:HeadedContainer`, `po:Atom`, `po:Milestone`, `po:Table` |
| what a block is (rhetorically) | DoCo (`doco:` = `http://purl.org/spar/doco/`): `doco:Paragraph`, `doco:SectionTitle`, `doco:List`, `doco:BlockQuotation`, `doco:TextBox`, `doco:Formula`, `doco:Figure`, `doco:Table`, `doco:TableOfContents`, `doco:BodyMatter` |
| containment | `po:contains` (a container to each block in it); a toggle's line is its header (`po:containsAsHeader` is not needed: its text is its own) |
| order of siblings | the Collections Ontology's `co:nextItem` (`co:` = `http://purl.org/co/`): a block to the next block in the same container. A linked chain, so inserting, removing and moving cost what they touch; the last block has none. Not `ord:`: that is the rendered output's placement, which the engine never follows as data |
| text | `rdf:value`: a block's plain text (an `xsd:string`) |
| inline ranges | Web Annotation (`oa:` = `http://www.w3.org/ns/oa#`): every mark is an `oa:TextPositionSelector` with `oa:start` and `oa:end` (offsets into `rdf:value`) |
| media and embeds | schema.org: `schema:contentUrl`, `schema:url`, `schema:name`, `schema:caption`, `schema:encodingFormat`, `schema:programmingLanguage`, `schema:contentSize` |
| a link, a mention | `schema:url` on a link mark; `oa:hasBody` on a mention (the resource it names) |

DoCo and the Pattern Ontology are vendored in `ontology/vendor/` for reference (CC BY 4.0, by their
authors; `ontology/vendor/SPAR-LICENSE.md`).

What Semblance adds (`blk:` = `https://semblance.dev/ns/block#`), only where none of them says it:

- `blk:Block` (`rdfs:subClassOf sem:Component`): anything the editor shows as a block. A block is a
  component, so a block type is a class with a rendering, like every other component.
- `blk:TextBlock` (a `po:Block`): a block whose content is its `rdf:value` with marks;
  `blk:Container`: a block holding others (`po:contains`); `blk:nests`: on a class, whether a block of
  it may hold blocks (a list item, a toggle, a column, a callout).
- The block types, each a subclass of its DoCo/`po:` class and `blk:Block`:
  `blk:Document` (`doco:BodyMatter`), `blk:Paragraph` (`doco:Paragraph`), `blk:Heading1`–`3`
  (`doco:SectionTitle`, `blk:level`), `blk:BulletedList` / `blk:NumberedList` / `blk:TodoList`
  (`doco:List`) of `blk:ListItem` / `blk:TodoItem` (`blk:checked`), `blk:Toggle`
  (`po:HeadedContainer`, `c:expanded`), `blk:Quote` (`doco:BlockQuotation`), `blk:Callout`
  (`doco:TextBox`, `c:icon`, `sty:tone`), `blk:Divider` (`po:Milestone`), `blk:Code` (`po:Block`,
  `schema:programmingLanguage`, edited by `c:CodeEditor`), `blk:Table` (`doco:Table`) of `blk:Row`
  of `blk:Cell` (cells are text blocks), `blk:Image` (`doco:Figure`; `schema:contentUrl`,
  `schema:caption`), `blk:File` (`schema:MediaObject`), `blk:Bookmark` (`schema:url`, `schema:name`),
  `blk:Embed`, `blk:Math` (`doco:Formula`, TeX in `rdf:value`), `blk:Columns` of `blk:Column`,
  `blk:DocumentLink` (`schema:url` or `blk:target`, another document), `blk:Contents`
  (`doco:TableOfContents`, derived from the document's headings).
- Marks: `blk:Mark` (`rdfs:subClassOf oa:TextPositionSelector`) and its kinds `blk:Strong`,
  `blk:Emphasis`, `blk:InlineCode`, `blk:Strike`, `blk:Link` (`schema:url`), `blk:Mention`
  (`oa:hasBody`); a block names its marks with `blk:mark`.
- The `/` menu entry of a type, on the class: `rdfs:label` and `rdfs:comment` in `@en`, `@uk`,
  `@de`, `@ar`, `c:icon`, `blk:keyword` (more words it is found by), `blk:menuOrder`, and
  `blk:template` (a node whose statements a new block of the type starts with: a heading's level,
  a to-do's `blk:checked false`). Every class with a `blk:menuOrder` is offered.
- The editor's state, all view state (`beh:viewState true`, so undo leaves it alone): the selection
  `c:anchorBlock` / `c:anchorOffset` / `c:focusBlock` / `c:focusOffset`, the marks the next typed
  text takes (`c:pendingMark`), the open menu (`c:menuFrom`: where its `/` is, `c:activeOption`).

```turtle
ex:notes a c:BlockEditor ; c:label "Notes" ; c:of ex:doc ; c:editable true .
ex:doc a blk:Document ; po:contains ex:h , ex:p , ex:list .
ex:h a blk:Heading1 ; rdf:value "Plans" ; co:nextItem ex:p .
ex:p a blk:Paragraph ; rdf:value "Ship the editor first." ; co:nextItem ex:list ;
    blk:mark ex:p-m1 .
ex:p-m1 a blk:Strong ; oa:start 5 ; oa:end 15 .
ex:list a blk:BulletedList ; po:contains ex:i1 , ex:i2 .
ex:i1 a blk:ListItem ; rdf:value "Model" ; co:nextItem ex:i2 .
ex:i2 a blk:ListItem ; rdf:value "Rendering" .
```

## Text, marks, caret and selection

- A text block's text is one `rdf:value` string. Offsets count characters as SPARQL does (code
  points, not UTF-16 units); the host converts the browser's offsets.
- Marks are standoff ranges, not nested nodes: `oa:start` inclusive, `oa:end` exclusive. They may
  overlap. Rendering splits the text at every mark boundary into runs; each run is wrapped in the
  elements of the marks covering it, in a fixed order (link, strong, em, s, code), so the same marks
  always make the same HTML. A run node is minted from its block and start offset
  (`<block>/~run-12`), so typing inside a run rewrites one text node.
- Editing shifts marks: text inserted at a mark's end extends it (bold continues as you type), at
  its start does not; a link does not extend at either end. A mark left empty is removed. A mark is
  minted from the event that made it (`<block>/~mark-<event>`), never a blank node.
- The selection is on the editor as two points (anchor and focus, each a block and an offset), as
  the DOM's Selection says them. A selection the person makes is an unrecorded event
  (`c:BlockSelect`, like a hover); an edit's reaction writes where the caret goes next. The editor's
  rendering puts the selection on its root (`data-sem-selection`), and the host places the browser's
  selection there after every flush.

## Every edit is one reaction and one change

The editor's region is `contenteditable`. The browser does not edit it: the bus records each
`beforeinput` as an event and cancels it. The event carries:

- `beh:inputType` (the InputEvent's type) and `beh:text` (its data);
- the range it acts on, from `getTargetRanges()`, as `beh:startBlock`/`beh:startOffset` and
  `beh:endBlock`/`beh:endOffset`, and `beh:covers` for every block wholly inside it. The browser
  decides what a key deletes (a character, a word, a line, the boundary between two blocks), in the
  writing direction; the graph decides what that means.

Event classes are chosen by input type, the way key events are chosen by key (`beh:inputType` on the
class, as `beh:key`): `c:InsertText` (`insertText`, `insertReplacementText`, `insertLineBreak`),
`c:DeleteText` (every `delete…` type), `c:SplitBlock` (`insertParagraph`), `c:HistoryStep`
(`historyUndo`, `historyRedo`), `c:FormatText` (`formatBold` …), and, for paste, `c:InsertFromPaste`.
Keys that are not input are `c:BlockEditorKey` presses (`tab`, `shift+tab`, `alt+arrowup`/`down`,
`mod+b`/`i`/`e`/`k`, `mod+shift+s`, `escape`, and the menu's arrows and Enter), carrying the selection.

Each event is handled by exactly one reaction (they filter one another out), every one `beh:undoable`
with a SPARQL pair and a function twin:

| event | reaction |
|---|---|
| text typed into one block | splice `rdf:value`, shift marks, add the pending marks |
| text typed that completes a Markdown shortcut at the start of a block (`# `, `## `, `### `, `- `, `* `, `1. `, `[] `, `> `, ```` ``` ````, `---`) | turn the block into that type (a list item into a list: joined to the list before it, else a new one). The shortcuts are data (`blk:BlockShortcut`: a trigger character, a pattern over the text before the caret, the class it makes), so a site adds its own |
| text typed that closes an inline shortcut (`**a**`, `_a_`, `` `a` ``, `~~a~~`) | drop the markers, mark what they enclosed (`blk:InlineShortcut`, data too) |
| a deletion inside one block | splice, shift marks |
| a deletion across blocks | the start block keeps its text before the range and takes the end block's after it (with its marks, shifted); covered blocks and the end block go (the end block's children join the start block, or follow it); the chains are relinked |
| Backspace at the start of a list item, heading, quote, callout | it becomes a paragraph (out of its list) |
| Enter | split the block at the caret (the new block is minted from the event); at the end of a heading, a paragraph follows; in an empty list item, it leaves the list (or goes up a level) |
| Shift+Enter | a line break in the text |
| Tab / Shift+Tab | into the previous sibling's children (when its class `blk:nests`; a list item into a nested list of its kind) / out to follow its parent |
| Alt+Up / Alt+Down, a drop | move the block in its chain (the `dnd:` layer for the pointer and its keyboard drag) |
| Mod+B, I, E, Shift+S, K | toggle a mark over the selection (or the pending marks at a caret); K asks for a link's address |
| undo / redo | Mod+Z, Mod+Shift+Z (or the browser's own history) activate the editor's `c:undoer` (a `beh:Undoer`) and `c:redoer` (a `beh:Redoer`, beside `beh:UndoLatest`: `beh:RedoLatest` applies again the change undone last). Typing in one breath is one step: a character typed where the last one went (or a Backspace or Delete where the last one deleted), within its event class's `beh:joinWithin` (a second), continues that step (`c:ContinueTyping` says `$event beh:continues ?member`, and the bus records the change on that member); a pause, a moved caret, another kind of edit or a Markdown shortcut starts a new one |

Composition (IME, many phone keyboards) cannot be cancelled. Then the browser edits the block, and on
`compositionend` (or an `input` whose `beforeinput` was not cancellable) the host reads that block's
text back and records the difference as an ordinary `c:InsertText` over the range it replaced; the
renderer then reconciles that block's subtree with the graph (`DomRenderer.resync`), so whatever the
browser put there is replaced by what the rules render.

## Typing re-renders only its block

- A block's renderings read its own triples and its marks (`sem:follows blk:mark`), nothing of its
  siblings or of the editor.
- Containers place their blocks member-wise (`sem:forEach po:contains`): the member rule reads the
  member's type and `co:nextItem`, not its text. A new block runs one member rule and
  relinks one neighbour.
- The selection's effects (the empty block's placeholder, the menu's anchor) are decorations a rule on
  the editor writes onto the two blocks involved, so moving the caret touches two blocks, not all.
- The `/` menu follows the block it was opened in (`sem:follows c:menuBlock`) and nothing else.
- A cost test types into a document of thousands of blocks and requires the same rule runs, triples
  and DOM operations as in a document of three.

## The `/` menu

Typing `/` in a text block opens the menu at the caret (`c:menuFrom`); the text between the `/` and the
caret filters it (folded as `c:Typeahead` folds, against labels and `blk:keyword`s in the viewer's
language). It is a `c:Typeahead` (combobox over a listbox; the region keeps the focus and names the
active option with `aria-activedescendant`): Up/Down move, Enter or a click picks, Escape or a space
after no match closes. Its options are minted from the block type classes, so a site's own type is
offered like a built-in one. Picking replaces the `/query` text and turns the block into the type (an
empty block, by the conversion to it), or inserts a block of the type after it, with its `blk:template`.
In a block with text the menu also offers what the block can turn into ("Turn into Heading 1"), first.

## Mentions

An editor that names classes it mentions (`blk:mentionable`, e.g. `ex:notes blk:mentionable schema:Person`)
opens the same menu at an `@` typed at the start of a text block or after a space (`c:OpenMentionMenu`;
the menu's `c:menuTrigger` is then `"@"`, else `"/"`). Its options are the instances of those classes, by
name (their least label, then their IRI), labelled in the viewer's language and filtered as one types; the
menu is named "Mentions" and says "No one by that name" when nothing matches. Picking one (Enter, Tab, a
click; `c:PickMention`) replaces the `@` and the query with its name, marked as a `blk:Mention` of it
(`oa:hasBody`, minted from the event), and a space: one undoable change. A mention renders as a link and
reads as `[name](iri)` in Markdown.

## Handles: moving, turning into, duplicating, deleting

Each block but a table's rows and cells and a layout's columns has a handle at its leading edge (`blk:BlockHandle`,
minted by its container's placement rule, inside a list's item): a `dnd:Draggable` carrying the block. It shows on
hover, on focus and while the block is entered, and always at phone width. Dragging it (a long press on touch;
Space, the arrows and Space from the keyboard) moves the block, with what it holds, to another place: every
container is an ordered drop target (`dnd:orderBy co:nextItem`) whose zone is the region its blocks are in, and a
container's shapes object (`dnd:Objection`) to a block they do not allow, or one that would go inside itself.
`blk:DropBlock` splices the chain in one undoable change, as Alt+Up and Alt+Down do; the drag layer draws the
line where it would land, scrolls near the edges and says where it is going.

A click on the handle or Enter opens its menu (the WAI-ARIA menu button pattern; `c:handleMenuBlock`): what the
block can turn into, Duplicate (also Mod+D on the caret's block: a copy of the block and what it holds, every
node minted from its original and the event) and Delete. The focus goes back to the handle when it closes.

## Sources show while their block is entered

A block an editor's caret is in (`c:focusBlock`) is entered (`data-sem-entered`); the theme shows sources only
then: a typeset formula's TeX (folded out of sight otherwise, but still where the arrows and a click reach),
an atom's address field and upload button once it shows something, a code block's language field (its label
otherwise). An atom with an address is not editable text: a click, or focusing its handle, enters it.

## Conversions: the contract

Turning a block of one type into another is a term of its own, one per direction: a `blk:Conversion`, which is
a reaction (`beh:Reaction`) whose source class (`beh:sourceClass`) is the type it converts from and whose
`blk:to` is the type it makes. Its queries rewrite the block (`$this`), reading the target type as
`$event a ?conversion . ?conversion blk:to ?to` (a conversion is raised on a block by its IRI:
`?block beh:raise ?conversion`). What a block can turn into is the conversions whose source class it has
(the most specific one per target type); the `/` menu, the handle's menu and the Markdown shortcuts all raise
them, and a raised conversion is one change with what raised it, undone in one step.

```turtle
ex:KeyPointToQuote a blk:Conversion ; beh:sourceClass ex:KeyPoint ; blk:to blk:Quote ; beh:like blk:Retype .
ex:QuoteToKeyPoint a blk:Conversion ; beh:sourceClass blk:Quote ; blk:to ex:KeyPoint ; beh:undoable true ;
    beh:deletes """CONSTRUCT { $this a ?old } WHERE { $this a ?old . ?old rdfs:subClassOf* blk:Block }""" ;
    beh:inserts """CONSTRUCT { $this a ?to } WHERE { $event a ?c . ?c blk:to ?to }""" .
```

A conversion keeps the block's identity, and its place where it can. It has its own queries (and, if it likes,
a `sem:function` twin), or takes them from one of four kinds (`beh:like`), each with a function twin:
`blk:Retype` (the text and marks kept, a plain text type dropping marks, what only the old type had dropped,
the new type's template applied, blocks it held following it when the new type holds none), `blk:Wrap` (the
block becomes the item of a list of the type: joining the list before or after it when that is one), `blk:Unwrap`
(an item leaves its list in its place, splitting it when in the middle) and `blk:Relist` (a list, or an item's
list, becomes another kind). The built-in ones convert between the text types, to and from code and math, into
and out of lists, and between list kinds; every one with a reverse round-trips (`test/block-editor.test.ts`).

## Custom block types: the contract

A site adds a block type with Turtle only:

```turtle
ex:Recipe a owl:Class ; rdfs:subClassOf blk:TextBlock , doco:TextBox ;
    sem:slug "ex-recipe" ;
    rdfs:label "Recipe"@en , "Рецепт"@uk , "Rezept"@de , "وصفة"@ar ;
    rdfs:comment "A dish with its servings."@en ;
    c:icon "utensils" ; blk:keyword "cook"@en ; blk:menuOrder 900 ;
    blk:template [ ex:servings 2 ] .
ex:RecipeRendering a sem:Rendering ; sem:targets ex:Recipe ; sem:stratum 0 .
ex:RecipeRendering-sparql a sem:Rule ; sem:implements ex:RecipeRendering ; sem:construct """…""" .
ex:RecipeShape a sh:NodeShape ; sh:targetClass ex:Recipe ; sh:property [ sh:path ex:servings ; sh:minCount 1 ] .
```

1. **The class**: a subclass of `blk:TextBlock` (it has text, edited like a paragraph), `blk:Container`
   (it holds blocks) or `blk:Block` (an atom), and of the DoCo or `po:` class it is.
2. **Its rendering**: one `sem:renders $this` root; a text block places `<block>/~text` (the runs,
   rendered by the shared text rule) where its text goes, a container places `<block>/~children`.
   Screen and Text, SPARQL first.
3. **Its shape**: what a block of it must say; the shapes layer shows violations inline.
4. **Its `/` entry**: label, description, icon, keywords, `blk:menuOrder`, `blk:template`.

Editing, the menu, moving, nesting, undo, copy and paste come from the superclass; there is no host code.
A type can bring its own Markdown shortcut too (a `blk:BlockShortcut`), and its own conversions (above): those
of its superclass apply to it already, and one from it is preferred to its superclass's. The Documents page of
the site has one: `ui:KeyPoint` (`demo/gallery/documents.ttl`), a paragraph that is an aside, with its style,
its shape, its `/` entry, the shortcut `! ` and conversions to and from a quote.

## Server rendering and the Text modality

A document renders as plain semantic HTML (`h1`, `p`, `ul`/`ol`/`li`, `blockquote`, `figure`,
`table`, `pre`, `hr`), with marks as `strong`, `em`, `code`, `s`, `a`, so it reads before the client
takes over; the editor's region is `contenteditable` only once `c:editable` is true, and the
selection is written only after an event, so the server's HTML and the client's first render agree and
`adopt` takes it over. In the Text modality a document is Markdown: `#` headings, `-`, `1.`, `[ ]` and
`[x]` items indented by depth, `>` quotes, fenced code, `---`, `**`/`_`/`` ` ``/`~~` marks and
`[text](url)` links; that text is also what "copy as Markdown" copies.

## Copy and paste

Copy (and cut) writes three formats of the selected blocks: HTML (the Screen rendering), Markdown (the
Text modality) and Turtle (the blocks' triples). A `copy` or `cut` is an event (`c:BlockCopy`, unrecorded;
`c:BlockCut`, which also deletes the range as a deletion does, one undoable step) carrying the range and
every block wholly inside it (`beh:within`: the components whose rendered root lies between the range's
first and last text). `c:CopyBlocks` replaces the editor's clipboard document (`c:clipboard`,
`<editor>/~clip`) with a copy of the blocks the selection takes, clipped to it, and of the blocks holding
them, each minted from its original (`<block>/~clip`, `<mark>/~clip`), in their order; what renderings state
about a block (`ord:`, `dnd:`, …) is not copied. The editor renders that document out of sight
(`c:BlockEditorClipboard`, before its body; no handles, no drop zones) with a `c:TriplesView` of its nodes,
and the host writes the clipboard from those renderings: `text/html` (the document as the screen renders
it), `text/plain` and `text/markdown` (its Text modality, from a projection of its own) and `text/turtle`.
A collapsed selection copies nothing, and the browser's own copy goes ahead.

Paste is a `c:InsertFromPaste` event. The host does only the
mechanical part: the clipboard's HTML, parsed by the browser, is attached to the event in the RDF/HTML
vocabulary (elements, attributes, text, as nodes minted from the event); plain text is its `beh:text`.
Reactions map that to blocks in SPARQL (`p`, `h1`–`h3`, `ul`/`ol`/`li`, `blockquote`, `pre`, `hr`,
`img`, `table`; `strong`/`b`, `em`/`i`, `code`, `s`, `a` to marks; everything else to its text), and
Markdown text line by line (`sx:matches`), minting blocks from the event and splicing them in at the
caret, one undoable change.

## Where it stands

Done: the model, shapes and every primitive's rendering (Screen and Text); editing within and across
blocks, marks, Markdown shortcuts, undo and redo, composition; the `/` menu and templates; nesting by Tab
and Shift+Tab (where the shapes allow it), moving by Alt+Up and Alt+Down; plain text pasted; site block
types in Turtle; a selection toolbar with marks and links (Mod+K, an editable address); tables whose
rows and columns are added and removed (the table toolbar, with the caret in a cell) and whose columns
are resized by their edges (dragged, or the arrow keys on a first-row edge; every cell of the column
carries its `c:width`, `blk:ResizeColumn`); layout columns added and removed (the columns toolbar, with
the caret in a column; removing one of the last two leaves the other's blocks in the columns' place,
`c:DissolveColumns`); every atom's address in a field; images and files uploaded
(kept in the browser, `blk:Uploads`), dropped, or pasted into the editor as new blocks (the editor is a
`file:Receiver`); formulas typeset, their TeX shown only while the caret is in them (it is folded,
`data-sem-folded`, but stays where the caret can go: a typeset island is not editable, and a caret put
on it goes into the TeX); a code block's language typed or picked from its class's `blk:languageOption`.

To come:
- dragging a block by a handle: the drag-and-drop layer makes a draggable's whole root its handle, which
  in an editable region would turn every text selection into a drag; it needs a handle part of its own;
- HTML or Markdown pasted as blocks (the event's HTML in RDF/HTML, mapped by reactions), as designed above;
- the Examples page's walkthrough of a site block type.
