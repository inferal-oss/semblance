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
- **`sty:density`**, **`sty:elevation`**, **`sty:colorScheme`** as before.

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
| **Layout** | Stack · Grid · Surface · Divider · Card · Columns |
| **Type** | Heading · Text · Link · Kbd · Code |
| **Actions** | Button · IconButton · ButtonGroup · Menu |
| **Inputs** | TextField · TextArea · Checkbox · RadioGroup · Switch · Slider · Select (Choice) · Segmented · Chips |
| **Feedback** | Alert · Badge · Tag · Spinner · Skeleton · Progress · Toast region · EmptyState |
| **Data** | List · Table · DescriptionList · Stat (Metrics) · Avatar · Timeline · Tree · charts |
| **Navigation** | Tabs · Breadcrumbs · Pagination · Stepper · NavList · AppBar |
| **Overlays** | Dialog · Drawer · Popover · Window · Tooltip (layer) |
| **Disclosure** | Accordion · Flippable |

## 4. Layers

A layer is a vocabulary plus rules in a stratum above the components, toggled
per projection. New ones:

| layer | vocabulary | effect |
|---|---|---|
| **Validation** (`val:`) | SHACL: `c:validates` a `sh:PropertyShape` on the data | Each field shows the shape's `sh:message` (and `aria-invalid`) while the value violates `sh:minLength`, `sh:maxLength`, `sh:pattern`, `sh:minInclusive`/`sh:maxInclusive`, `sh:minCount`. A form's submit is disabled while any of its fields is invalid. |
| **Keyboard** (`key:`) | `key:shortcut "mod+k"` on any component | `aria-keyshortcuts` and a `<kbd>` hint on the element; the key press becomes a `beh:Shortcut` event addressed to that component, which runs its click reactions. `c:ShortcutList` lists them all (SPARQL). |
| **Motion** (`mot:`) | `mot:enter mot:Rise` / `mot:Fade` / `mot:Scale` on components; `mot:preference` Full / Reduced / None on the app | Enter animations by attribute; the preference re-values the duration tokens (Reduced = opacity only, None = 0ms). |
| **Localization** (`l10n:`) | `l10n:language` on the app; language-tagged `rdfs:label` / `c:label` | Components read labels through the layer: the app language wins, then English, then untagged. Languages with `l10n:direction l10n:RTL` set `dir="rtl"` on the shell. |
| **Announcements** (`ann:`) | `ann:announces "…"` on a reaction | Each recorded event whose reaction announces something becomes a toast in a `c:ToastRegion` (an `aria-live` region), from the change log. |
| **Status** (`st:`) | `st:busy true` on a component | `aria-busy` and a skeleton or spinner instead of the content while busy. |
| **Contrast** | `sty:HighContrast` color scheme | Re-values the role tokens for 7:1 text and visible borders. |

Existing: modality, style, position, a11y, behaviour, provenance, tooltip,
source, debug.

## 5. Demo

A third page, **Components**: a navigation list of the groups and a page per
group. Each specimen is a flippable card (its back shows the rules), with
every variant laid out (tone × emphasis, sizes, states). The toolbar has
the layer toggles: theme, contrast, density, motion, language, and validation
and keyboard on or off.
