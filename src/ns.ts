// Namespaces. The semblance.dev namespaces are placeholders until we pick a
// permanent home for the vocabularies.
export const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  prov: 'http://www.w3.org/ns/prov#',
  rdfhtml: 'https://ia2.dev/spec/rdf-html#',
  ord: 'https://ontology.inferal.com/modules/ordering/',
  sem: 'https://semblance.dev/ns/core#',
  c: 'https://semblance.dev/ns/component#',
  mod: 'https://semblance.dev/ns/modality#',
  sty: 'https://semblance.dev/ns/style#',
  tok: 'https://semblance.dev/ns/token#',
  pos: 'https://semblance.dev/ns/position#',
  beh: 'https://semblance.dev/ns/behaviour#',
  a11y: 'https://semblance.dev/ns/a11y#',
  ldes: 'https://w3id.org/ldes#',
  svg: 'https://semblance.dev/ns/svg#',
  tree: 'https://w3id.org/tree#',
  sh: 'http://www.w3.org/ns/shacl#',
  mot: 'https://semblance.dev/ns/motion#',
  val: 'https://semblance.dev/ns/validation#',
  key: 'https://semblance.dev/ns/keyboard#',
  l10n: 'https://semblance.dev/ns/l10n#',
  ann: 'https://semblance.dev/ns/announce#',
  st: 'https://semblance.dev/ns/status#',
  per: 'https://semblance.dev/ns/persistence#',
} as const

/** Prepended to every SPARQL rule body. */
export const SPARQL_PREFIXES = Object.entries(NS)
  .map(([prefix, iri]) => `PREFIX ${prefix}: <${iri}>`)
  .join('\n')



const { rdf, rdfs, xsd, prov, rdfhtml, ord, sem, c, mod, sty, beh } = NS

export const RDF_TYPE = rdf + 'type'
export const RDF_FIRST = rdf + 'first'
export const RDF_REST = rdf + 'rest'
export const RDF_NIL = rdf + 'nil'
export const RDFS_SUBCLASS = rdfs + 'subClassOf'
export const RDFS_RANGE = rdfs + 'range'
export const XSD_BOOLEAN = xsd + 'boolean'
export const XSD_INTEGER = xsd + 'integer'
export const PROV = {
  Activity: prov + 'Activity',
  Association: prov + 'Association',
  SoftwareAgent: prov + 'SoftwareAgent',
  wasGeneratedBy: prov + 'wasGeneratedBy',
  wasInfluencedBy: prov + 'wasInfluencedBy',
  used: prov + 'used',
  wasAssociatedWith: prov + 'wasAssociatedWith',
  qualifiedAssociation: prov + 'qualifiedAssociation',
  agent: prov + 'agent',
  hadPlan: prov + 'hadPlan',
} as const

export const H = {
  ns: rdfhtml,
  Attribute: rdfhtml + 'Attribute',
  Text: rdfhtml + 'Text',
  hasChild: rdfhtml + 'hasChild',
  childOf: rdfhtml + 'childOf',
  data: rdfhtml + 'data',
  attribute: rdfhtml + 'attribute',
  attributeName: rdfhtml + 'attributeName',
  attributeValue: rdfhtml + 'attributeValue',
} as const

export const ORD = {
  precedes: ord + 'precedes',
  follows: ord + 'follows',
  immediatelyPrecedes: ord + 'immediatelyPrecedes',
  immediatelyFollows: ord + 'immediatelyFollows',
} as const

export const SEM = {
  Component: sem + 'Component',
  Rule: sem + 'Rule',
  targets: sem + 'targets',
  modality: sem + 'modality',
  stratum: sem + 'stratum',
  layer: sem + 'layer',
  implements: sem + 'implements',
  construct: sem + 'construct',
  function: sem + 'function',
  follows: sem + 'follows',
  watches: sem + 'watches',
  renders: sem + 'renders',
  slug: sem + 'slug',
  slot: sem + 'slot',
  symbol: sem + 'symbol',
  tooltip: sem + 'tooltip',
  readsMinted: sem + 'readsMinted',
  forEach: sem + 'forEach',
  inputOnly: sem + 'inputOnly',
  TooltipLayer: sem + 'TooltipLayer',
  Layer: sem + 'Layer',
  DocsLayer: sem + 'DocsLayer',
  warm: sem + 'warm',
  Eager: sem + 'Eager',
  Lazy: sem + 'Lazy',
  select: sem + 'select',
  text: sem + 'text',
  verdict: sem + 'verdict',
  sortKey: sem + 'sortKey',
  orderKey: sem + 'orderKey',
  orderBy: sem + 'orderBy',
  descending: sem + 'descending',
  order: sem + 'order',
  DebugLayer: sem + 'DebugLayer',
  SourceLayer: sem + 'SourceLayer',
  enables: sem + 'enables',
} as const

export const MOD = { Screen: mod + 'Screen', Text: mod + 'Text' } as const

export const C = {
  Stack: c + 'Stack',
  Heading: c + 'Heading',
  StreamStats: c + 'StreamStats',
  Tabs: c + 'Tabs',
  tabs: c + 'tabs',
  selected: c + 'selected',
  selects: c + 'selects',
  content: c + 'content',
  slot: c + 'slot',
  Segmented: c + 'Segmented',
  Choice: c + 'Choice',
  Chips: c + 'Chips',
  options: c + 'options',
  Flippable: c + 'Flippable',
  Window: c + 'Window',
  StreamMembers: c + 'StreamMembers',
  TriplesView: c + 'TriplesView',
  limit: c + 'limit',
  Desktop: c + 'Desktop',
  hosts: c + 'hosts',
  windowsOn: c + 'windowsOn',
  Switch: c + 'Switch',
  cases: c + 'cases',
  when: c + 'when',
  ProjectionView: c + 'ProjectionView',
  projectionGraph: c + 'projectionGraph',
  judgementClassOf: c + 'judgementClass',
  title: c + 'title',
  body: c + 'body',
  index: c + 'index',
  x: c + 'x',
  y: c + 'y',
  width: c + 'width',
  height: c + 'height',
  docks: c + 'docks',
  detachable: c + 'detachable',
  detached: c + 'detached',
  detaches: c + 'detaches',
  max: c + 'max',
  active: c + 'active',
  subtitle: c + 'subtitle',
  badge: c + 'badge',
  note: c + 'note',
  actions: c + 'actions',
  unit: c + 'unit',
  fields: c + 'fields',
  emphasis: c + 'emphasis',
  hideLabel: c + 'hideLabel',
  logo: c + 'logo',
  nodes: c + 'nodes',
  queries: c + 'queries',
  bindVariable: c + 'bindVariable',
  bindFrom: c + 'bindFrom',
  bindProperty: c + 'bindProperty',
  emptyText: c + 'emptyText',
  baseIri: c + 'baseIri',
  dataQuery: c + 'dataQuery',
  view: c + 'view',
  dataset: c + 'dataset',
  facetVariable: c + 'facetVariable',
  facetLabel: c + 'facetLabel',
  categoryVariable: c + 'categoryVariable',
  seriesVariable: c + 'seriesVariable',
  valueVariable: c + 'valueVariable',
  flagVariable: c + 'flagVariable',
  flagLabel: c + 'flagLabel',
  legend: c + 'legend',
  key: c + 'key',
  logScale: c + 'logScale',
  referenceLine: c + 'referenceLine',
  judgementClass: c + 'judgementClass',
  front: c + 'front',
  flipped: c + 'flipped',
  revealed: c + 'revealed',
  SourceBack: c + 'SourceBack',
  flips: c + 'flips',
  controls: c + 'controls',
  property: c + 'property',
  level: c + 'level',
  Button: c + 'Button',
  TextField: c + 'TextField',
  List: c + 'List',
  ListItem: c + 'ListItem',
  children: c + 'children',
  label: c + 'label',
  value: c + 'value',
  placeholder: c + 'placeholder',
  help: c + 'help',
  icon: c + 'icon',
  Toast: c + 'Toast',
  prefix: c + 'prefix',
  error: c + 'error',
  disabled: c + 'disabled',
  checked: c + 'checked',
  item: c + 'item',
  sortBy: c + 'sortBy',
  itemLabel: c + 'itemLabel',
  itemChecked: c + 'itemChecked',
  of: c + 'of',
  inList: c + 'inList',
  labelFrom: c + 'labelFrom',
  checkedFrom: c + 'checkedFrom',
} as const

export const STY = {
  Layer: sty + 'Layer',
  Token: sty + 'Token',
  Density: sty + 'Density',
  StyleRule: sty + 'StyleRule',
  value: sty + 'value',
  hookAttribute: sty + 'hookAttribute',
  overrides: sty + 'overrides',
  when: sty + 'when',
  Keyframes: sty + 'Keyframes',
  name: sty + 'name',
  step: sty + 'step',
  at: sty + 'at',
  tone: sty + 'tone',
  emphasis: sty + 'emphasis',
  size: sty + 'size',
  hookCssProperty: sty + 'hookCssProperty',
  tokenScale: sty + 'tokenScale',
  scale: sty + 'scale',
  declares: sty + 'declares',
  property: sty + 'property',
  token: sty + 'token',
  tokens: sty + 'tokens',
  raw: sty + 'raw',
  appliesTo: sty + 'appliesTo',
  intent: sty + 'intent',
  density: sty + 'density',
  colorScheme: sty + 'colorScheme',
  part: sty + 'part',
  state: sty + 'state',
  override: sty + 'override',
} as const

export const LDES = {
  timestampPath: NS.ldes + 'timestampPath',
  sequencePath: NS.ldes + 'sequencePath',
  retentionPolicy: NS.ldes + 'retentionPolicy',
  fullLogDuration: NS.ldes + 'fullLogDuration',
  DurationAgoPolicy: NS.ldes + 'DurationAgoPolicy',
  amount: NS.ldes + 'amount',
  member: NS.tree + 'member',
  view: NS.tree + 'view',
} as const

/** Named graph holding the change-log LDES and its members. */
export const EVENTS_GRAPH = 'urn:semblance:events'
/** Named graph holding performance observations. */
export const PERF_GRAPH = 'urn:semblance:perf'
/** What the persistence effect reports: per:StateLog and each policy's size and last write. */
export const PERSIST_GRAPH = 'urn:semblance:persistence'
export const SVG_NS = 'http://www.w3.org/2000/svg'

export const BEH = {
  ChangeLog: beh + 'ChangeLog',
  recorded: beh + 'recorded',
  Hover: beh + 'Hover',
  Move: beh + 'Move',
  Resize: beh + 'Resize',
  gesture: beh + 'gesture',
  node: beh + 'node',
  added: beh + 'added',
  removed: beh + 'removed',
  Event: beh + 'Event',
  Reaction: beh + 'Reaction',
  domEvent: beh + 'domEvent',
  target: beh + 'target',
  value: beh + 'value',
  checked: beh + 'checked',
  sequence: beh + 'sequence',
  at: beh + 'at',
  latest: beh + 'latest',
  previous: beh + 'previous',
  LatestMembersPolicy: beh + 'LatestMembersPolicy',
  handledBy: beh + 'handledBy',
  when: beh + 'when',
  source: beh + 'source',
  sourceClass: beh + 'sourceClass',
  deletes: beh + 'deletes',
  inserts: beh + 'inserts',
} as const

export const A11Y = { Layer: NS.a11y + 'Layer' } as const
export const POS = { Layer: NS.pos + 'Layer' } as const

export const MOT = { preference: NS.mot + 'preference' } as const
export const VAL = {
  Layer: NS.val + 'Layer',
  validates: NS.val + 'validates',
  requires: NS.val + 'requires',
  invalid: NS.val + 'invalid',
  violation: NS.val + 'violation',
  ShapesLayer: NS.val + 'ShapesLayer',
} as const
export const KEY = { Layer: NS.key + 'Layer', shortcut: NS.key + 'shortcut', Command: NS.key + 'Command', Press: NS.key + 'Press' } as const
export const L10N = { label: NS.l10n + 'label', language: NS.l10n + 'language', code: NS.l10n + 'code', direction: NS.l10n + 'direction', RTL: NS.l10n + 'RTL' } as const
export const ANN = { Layer: NS.ann + 'Layer', announces: NS.ann + 'announces', tone: NS.ann + 'tone', from: NS.ann + 'from' } as const
export const ST = { Layer: NS.st + 'Layer', busy: NS.st + 'busy' } as const
