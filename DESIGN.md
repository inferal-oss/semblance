# The Semblance design system

One vocabulary for how things look, one for what they are, one per
cross-cutting concern. A component never hard-codes a color, size or
behaviour that a layer or the theme can describe.

## 1. Foundations (`ontology/theme/foundations.ttl`)

Every value is a `sty:Token` on a named scale, emitted as `--sem-<slug>`.

| scale | tokens | notes |
|---|---|---|
| **Neutral** | `gray-1` … `gray-12` | 12-step ramp (Radix-style roles): 1–2 backgrounds, 3–5 component fills, 6–8 borders, 9–10 solid, 11–12 text. `light-dark()` pairs. |
| **Accent** | `accent-1` … `accent-12` | Same roles as neutral, in the brand hue (violet). |
| **Status** | `info-*`, `success-*`, `warning-*`, `danger-*` | Steps 3 (soft fill), 6 (border), 9 (solid), 11 (text). Reserved for state; never series colors. |
| **Roles** | `canvas`, `surface`, `surface-sunken`, `surface-overlay`, `text`, `muted`, `faint`, `border`, `border-strong`, `ring` | What components use. Defined from the ramps, so a theme swaps ramps and roles follow. |
| **Type** | `text-xs` 11 · `text-sm` 13 · `text-md` 15 · `text-lg` 17 · `text-xl` 20 · `text-2xl` 24 · `text-3xl` 30 | Plus `font`, `font-mono`, `leading-tight/normal`. |
| **Space** | `space-1` … `space-8` (4 → 48px) | Densities re-value these per subtree. |
| **Radius** | `radius-sm` 6 · `radius-md` 10 · `radius-lg` 14 · `radius-xl` 20 · `radius-full` | |
| **Size** | `control-sm` 28 · `control-md` 36 · `control-lg` 44 | Height of every control at each size. |
| **Elevation** | `shadow-1` … `shadow-4` | Flat, raised, overlay, floating. |
| **Motion** | `duration-fast` 120ms · `duration` 180ms · `duration-slow` 320ms · `ease` / `ease-out` / `spring` | The motion layer can zero these. |

## 2. Variation axes (style layer)

Components vary along a few shared, orthogonal axes. Each is an object
property with a `sty:hookAttribute`, so it becomes a `data-sem-*` attribute
and the theme styles it once for every component that has it.

- **`sty:tone`** — *what it means*: `sty:Neutral`, `sty:Accent`, `sty:Info`,
  `sty:Success`, `sty:Warning`, `sty:Danger`. A tone sets five custom properties
  on its element: `--tone-solid`, `--tone-solid-hover`, `--tone-soft`,
  `--tone-border`, `--tone-text`, `--tone-on-solid`. (`sty:intent` Primary /
  Secondary / Danger stays as a shorthand: Primary = Accent + Solid.)
- **`sty:emphasis`** — *how loud*: `sty:Solid`, `sty:Soft`, `sty:Outline`,
  `sty:Ghost`. An emphasis maps the tone properties to `background`,
  `border-color` and `color`. Tone × emphasis = 24 looks from 10 rules, for every
  toned component (button, badge, tag, alert, chip, icon button, toast).
- **`sty:size`** — `sty:Small`, `sty:Medium`, `sty:Large`: sets `--control-h`,
  the font size and the padding.
- **`sty:textStyle`** — `sty:Display`, `sty:Title`, `sty:Subtitle`, `sty:Body`,
  `sty:Caption`, `sty:Overline`, `sty:Mono`: the type scale, for any component.
- **`sty:density`**, **`sty:elevation`**, **`sty:colorScheme`** as before.
- **Width classes** — most layout adapts intrinsically (rows that wrap, `minmax(min(100%, …))`
  tracks, content that scrolls inside itself). What cannot says where it applies: a style rule
  with `sty:atWidth sty:CompactWidth` (a phone held upright, ≤ 640px) or `sty:RegularWidth` is
  compiled inside that `sty:WidthClass`'s media condition, after its layer's other rules. On a
  compact screen the app bar is one row and folds its `c:moreActions` behind a More button
  (open while the bar is `c:expanded`), a segmented control or nav list with
  `c:compactAs c:Picker` becomes a native select of its options, the status bar is one
  scrolling line, a split view stacks and a bottom-docked frame keeps to half the screen.

## 3. Components

Thin vocabularies. Every component
- is a subclass of `sem:Component` with a `sem:slug` (its `data-sem-c`);
- reuses the shared properties (`c:label`, `c:value`, `c:help`, `c:disabled`,
  `c:icon`, `c:children`, `c:of`, …) before inventing one;
- renders Screen and Text modalities (text is a sketch, not a screen dump);
- takes its state from the graph and changes it only through reactions;
- is styled only by theme `sty:StyleRule`s on its class and parts.

| group | components |
|---|---|
| **Layout** | Stack · Grid · Surface · Divider · Spacer · Card · Specimen · Swatches |
| **Type** | Heading · Text · Link · Kbd · Code · Blockquote · Walkthrough (WalkthroughStep, Mention) |
| **Actions** | Button · IconButton · ButtonGroup · Menu / MenuItem (+ Pressable, Setter mixins) |
| **Inputs** | TextField · TextArea · Checkbox · RadioGroup · ToggleSwitch · Slider · Field · Choice · Segmented · Chips |
| **Feedback** | Alert · Badge · Tag · Spinner · Skeleton · Progress · Toast · ToastRegion · EmptyState |
| **Data** | List · Table · DescriptionList · Stat · Metrics · Money · Avatar · AvatarGroup · MessageList · Timeline · Tree · Board · charts |
| **Navigation** | Tabs · NavList · Breadcrumbs · Pagination · Stepper · AppBar |
| **Overlays** | Dialog · Drawer · Popover · Window · Palette · Taskbar · Tooltip (layer) |
| **Disclosure** | Accordion / AccordionItem · Flippable |
| **Inspection** | DataGrid (GridColumn, filters) · TimeAxis · SplitView · DockPanel · JsonTree · HexView · BodyViewer · Toolbar · SearchField · Legend · LiveIndicator · CountBadge (+ Unsetter mixin) |

Any component that shows a `c:value` may take it from a query instead: `c:valueQuery` names a
`sem:View` whose first row's `?value` (and `?tone`) it shows, re-run when its `c:dataset` changes
(`ontology/components/formula.ttl`).

A **walkthrough** (`ontology/components/walkthrough.ttl`) is an explanation in steps whose phrases
are `c:Mention`s of resources (`c:mentions`): beside the steps it draws a diagram of what they
mention and the graph's links among it, in bands by the step that first mentions each, and stays
in view while the steps scroll. The step being read is graph state (`c:current`, reported by the
host as an unrecorded `c:StepInView` as the page scrolls, or by focus); a rule above the rendering
derives each mark's `c:Salience` from it, and the host draws curved arrows from the current step's
mentions to their nodes (`src/web/walkthrough.ts`: the graph says what, the host only where).
Activating a mention shows its statement in the walkthrough's `c:sourceView` (`c:highlightsSubject`;
the host records each statement's lines as a `c:SourceSpan`), or, with `c:to`, goes to the term's
page. Every example on the Examples page explains itself with one.

(`c:Switch` is the case switcher that picks one child by a property's value;
the on/off control is `c:ToggleSwitch`.)

The **Inspection** group is what in-app inspectors, log viewers, event browsers and trace
viewers are made of. A `c:DataGrid` shows a collection's members (an LDES stream by default)
under declared columns; its sort, selection, column widths and visibility, and its window
(following the newest member, or pinned; older / newer) are graph state, and filters are nodes
it is `c:filteredBy` (`c:TextFilter`, `c:ValueFilter`, `c:FlagFilter`) that ordinary controls
edit. A waterfall column draws spans on the window's time scale, which a `c:TimeAxis` ticks. Detail
views follow a selection through `c:bindFrom` / `c:bindProperty`. Separators (a split's divider,
a column's edge, a dock panel's free edge) are one-axis size handles: dragged, or moved with the
arrow keys, they commit one `beh:Size` event. The Examples page's network inspector
(`demo/gallery/_network.ttl`) is composed only of these parts.

Floating frames get their abilities from capability classes an instance opts
into: `c:Draggable`, `c:Resizable`, `c:Raisable`, `c:Minimizable`,
`c:Maximizable`, `c:Dockable`. A `c:Window` has them all; a `c:Palette` docks.
Their state is two hookable axes, `c:windowState` (normal, minimized,
maximized) and `c:attachedTo` (floating or a viewport edge), plus stacking
order (`c:z`) as graph state. A move docks to the edge where its release lands,
carried `c:throwTime` along its velocity, so a frame thrown at an edge docks
there. The capabilities are not only for frames: the desktop's `c:Taskbar` is
also `c:Draggable` and `c:Dockable`, so its grip (or the arrow keys) moves it,
and docked it lies along its edge while the page keeps that edge clear.

## 4. Layers

A layer is a vocabulary plus rules in a stratum above the components, toggled
per projection. New ones:

| layer | vocabulary | effect |
|---|---|---|
| **Validation** (`val:`) | SHACL: `c:validates` a `sh:PropertyShape` on the data | Each field shows the shape's `sh:message` (and `aria-invalid`) while the value violates `sh:minLength`, `sh:maxLength`, `sh:pattern`, `sh:minInclusive`/`sh:maxInclusive`, `sh:minCount`. A form's submit is disabled while any of its fields is invalid. |
| **Keyboard** (`key:`) | `key:shortcut "mod+k"` on any component | `aria-keyshortcuts` and a `<kbd>` hint on the element; the key press becomes a `beh:Shortcut` event addressed to that component, which runs its click reactions. `c:ShortcutList` lists them all (SPARQL). |
| **Motion** (`mot:`) | `mot:preference` Full / Reduced / None on a subtree | Re-values the duration and easing tokens every transition and animation uses (shared `sty:Keyframes` in the foundations). |
| **Localization** (`l10n:`) | `l10n:language` on the app; language-tagged `rdfs:label` / `c:label` | Components read labels through the layer: the app language wins, then English, then untagged. Languages with `l10n:direction l10n:RTL` set `dir="rtl"` on the shell. |
| **Announcements** (`ann:`) | `ann:announces "…"` (and `ann:tone`) on a reaction | A `c:ToastRegion` with `ann:from` a change log shows the newest announcing events as toasts, reading the log from its head. |
| **Drag and drop** (`dnd:`) | `dnd:Draggable` (`dnd:carries`), `dnd:DropTarget` / `dnd:Sortable` (`dnd:accepts` shapes, `dnd:memberOf` / `dnd:members`, `dnd:orderBy`) | Draggables are handles (pointer, long press, Space); while one is carried every zone is marked accepting or refusing (with the violated shape's `sh:message`), the hovered position shows an insertion line, and a drop is a recorded `dnd:Drop` for the target's reactions, with a fractional `dnd:rank` between its neighbours. Refused drops are announced, never applied. |
| **Status** (`st:`) | `st:busy true` on a component | `aria-busy`; the theme dims it under a shimmer. |
| **Contrast** | `sty:contrast sty:HighContrast` on a subtree | Re-values the role tokens for stronger text and visible borders. |

Also built: **component shapes** (SHACL on the components themselves),
**privacy** (`prv:concealed` / `prv:sensitive`, masked or blurred), **docs**
(each specimen's ontology as Turtle), **themes** (`sty:theme`: Semblance, Paper,
Terminal, Blueprint, Sunset), **persistence** (`per:Policy`, PERSISTENCE.md)
and **warmth** (`sem:warm`: what idle time may evaluate).

Existing: modality, style, position, a11y, behaviour, provenance, tooltip,
source, debug.

## 5. Demo

A third page, **Components**: a navigation list of the groups (Foundations,
Layout, Type, Actions, Inputs, Feedback, Data, Navigation, Overlays, Disclosure,
Layers) and a page per group (`demo/gallery/<group>.ttl`). Each specimen is a
flippable card whose back shows the rules that made it. Beside the navigation,
display settings — language, contrast, motion, density — are controls over
the shell's properties. The Layers page demonstrates each layer working:
a SHACL-validated form, shortcuts with their list, a busy state, the
language switch (RTL for Arabic), and the display axes. Layers are switched
on and off in the Playground's layer chips.
