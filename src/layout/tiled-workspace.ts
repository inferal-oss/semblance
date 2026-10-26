import type { BlankNode, DefaultGraph, NamedNode, Quad } from '@rdfjs/types'
import { C, NS, RDF_FIRST, RDF_NIL, RDF_REST, RDF_TYPE } from '../ns.ts'
import { mint, type Delta } from '../rdf.ts'
import type { GraphStore } from '../store/types.ts'

type Graph = NamedNode | DefaultGraph
type ListCell = NamedNode | BlankNode
type Edge = { parent: NamedNode; property: string }

/** Graph edits for a c:TiledWorkspace. Apply each returned delta in one Runtime tick. */
export class TiledWorkspace {
  readonly graph: Graph

  constructor(readonly store: GraphStore, readonly workspace: NamedNode, graph?: Graph) {
    this.graph = graph ?? store.factory.defaultGraph()
  }

  private nn(iri: string): NamedNode { return this.store.factory.namedNode(iri) }
  private facts(subject: ListCell, predicate: string): Quad[] {
    return this.store.match(subject, this.nn(predicate), null, this.graph)
  }
  private object(subject: NamedNode, predicate: string): NamedNode | undefined {
    const term = this.facts(subject, predicate)[0]?.object
    return term?.termType === 'NamedNode' ? term : undefined
  }
  private quad(subject: NamedNode, predicate: string, object: NamedNode): Quad {
    return this.store.factory.quad(subject, this.nn(predicate), object, this.graph)
  }
  private root(): NamedNode {
    const root = this.object(this.workspace, C.rootTile)
    if (!root) throw new Error('Tiled workspace has no root tile')
    return root
  }
  private isSplit(node: NamedNode): boolean {
    return this.store.has(this.quad(node, RDF_TYPE, this.nn(NS.c + 'SplitView')))
  }
  private edgeTo(target: NamedNode): Edge | undefined {
    const seen = new Set<string>()
    const visit = (node: NamedNode, edge?: Edge): Edge | undefined => {
      if (node.equals(target)) return edge
      if (seen.has(node.value)) throw new Error('Tiled workspace contains a cycle')
      seen.add(node.value)
      if (!this.isSplit(node)) return undefined
      for (const property of [NS.c + 'primary', NS.c + 'secondary']) {
        const child = this.object(node, property)
        if (child) {
          const found = visit(child, { parent: node, property })
          if (found) return found
        }
      }
      return undefined
    }
    const root = this.root()
    if (root.equals(target)) return { parent: this.workspace, property: C.rootTile }
    return visit(root)
  }
  private replace(edge: Edge, old: NamedNode, next: NamedNode): Delta {
    if (!this.object(edge.parent, edge.property)?.equals(old)) throw new Error('Tile edge changed')
    return { remove: this.facts(edge.parent, edge.property), add: [this.quad(edge.parent, edge.property, next)] }
  }

  /** Insert a stable split around a leaf. 'column' stacks its children top to bottom. */
  split(target: NamedNode, added: NamedNode, direction: 'row' | 'column' = 'row', side: 'after' | 'before' = 'after'): Delta {
    const edge = this.edgeTo(target)
    if (!edge) throw new Error('Target is not in this tiled workspace')
    if (target.equals(added) || this.edgeTo(added)) throw new Error('New tile is already in this workspace')
    const split = this.nn(mint(this.workspace.value, 'split-' + encodeURIComponent(added.value)))
    if (this.store.match(split, null, null, this.graph).length) throw new Error('Split IRI is already in use')
    const primary = side === 'before' ? added : target
    const secondary = side === 'before' ? target : added
    const link = this.replace(edge, target, split)
    const add = [
      ...link.add,
      this.quad(split, RDF_TYPE, this.nn(NS.c + 'SplitView')),
      this.quad(split, NS.c + 'primary', primary),
      this.quad(split, NS.c + 'secondary', secondary),
    ]
    if (direction === 'column') add.push(this.quad(split, NS.pos + 'direction', this.nn(NS.pos + 'Column')))
    return { remove: link.remove, add }
  }

  /** Remove a tile and promote its sibling. The removed tile's own data is retained. */
  close(target: NamedNode): Delta {
    const edge = this.edgeTo(target)
    if (!edge) throw new Error('Target is not in this tiled workspace')
    if (edge.parent.equals(this.workspace)) throw new Error('Cannot close the last tile')
    const parent = edge.parent
    const siblingProperty = edge.property === NS.c + 'primary' ? NS.c + 'secondary' : NS.c + 'primary'
    const sibling = this.object(parent, siblingProperty)
    const outer = this.edgeTo(parent)
    if (!sibling || !outer) throw new Error('Split tree is incomplete')
    const link = this.replace(outer, parent, sibling)
    return { remove: [...link.remove, ...this.store.match(parent, null, null, this.graph)], add: link.add }
  }

  private list(owner: NamedNode): { tabs: NamedNode[]; remove: Quad[] } {
    const heads = this.facts(owner, C.tabs)
    if (heads.length !== 1) throw new Error('Tab group must have one tab list')
    const remove = [...heads]
    const tabs: NamedNode[] = []
    const head = heads[0]?.object
    if (head?.termType !== 'NamedNode' && head?.termType !== 'BlankNode') throw new Error('Tab list head is invalid')
    let cell: ListCell = head
    const seen = new Set<string>()
    while (cell.value !== RDF_NIL) {
      const key = `${cell.termType}:${cell.value}`
      if (seen.has(key)) throw new Error('Tab list contains a cycle')
      seen.add(key)
      const first = this.facts(cell, RDF_FIRST)
      const rest = this.facts(cell, RDF_REST)
      if (first.length !== 1 || rest.length !== 1 || first[0]?.object.termType !== 'NamedNode' || (rest[0]?.object.termType !== 'NamedNode' && rest[0]?.object.termType !== 'BlankNode')) {
        throw new Error('Tab list is incomplete')
      }
      tabs.push(first[0].object as NamedNode)
      remove.push(...first, ...rest)
      cell = rest[0].object as ListCell
    }
    return { tabs, remove }
  }
  private listQuads(owner: NamedNode, tabs: NamedNode[]): Quad[] {
    const cells = tabs.map((tab) => this.nn(mint(owner.value, 'item-' + encodeURIComponent(tab.value))))
    const quads = [this.quad(owner, C.tabs, cells[0] ?? this.nn(RDF_NIL))]
    for (let i = 0; i < tabs.length; i++) {
      quads.push(this.quad(cells[i]!, RDF_FIRST, tabs[i]!))
      quads.push(this.quad(cells[i]!, RDF_REST, cells[i + 1] ?? this.nn(RDF_NIL)))
    }
    return quads
  }

  /** Move one tab between c:Tabs leaves, keeping its IRI, content and host slot unchanged. */
  moveTab(tab: NamedNode, from: NamedNode, to: NamedNode, at?: number): Delta {
    if (!this.edgeTo(from) || !this.edgeTo(to)) throw new Error('Both tab groups must be in this workspace')
    const source = this.list(from)
    if (!source.tabs.some((item) => item.equals(tab))) throw new Error('Source does not contain tab')
    const destination = from.equals(to) ? source : this.list(to)
    if (!from.equals(to) && destination.tabs.some((item) => item.equals(tab))) throw new Error('Destination already contains tab')
    const without = source.tabs.filter((item) => !item.equals(tab))
    const target = from.equals(to) ? without : destination.tabs
    const index = at === undefined ? target.length : Math.max(0, Math.min(target.length, Math.trunc(at)))
    const inserted = [...target.slice(0, index), tab, ...target.slice(index)]
    const add = from.equals(to)
      ? this.listQuads(from, inserted)
      : [...this.listQuads(from, without), ...this.listQuads(to, inserted)]
    const remove = from.equals(to) ? [...source.remove] : [...source.remove, ...destination.remove]
    if (!from.equals(to)) {
      const selected = this.object(from, C.selected)
      if (selected?.equals(tab)) {
        remove.push(...this.facts(from, C.selected))
        if (without[0]) add.push(this.quad(from, C.selected, without[0]))
      }
      remove.push(...this.facts(to, C.selected))
      add.push(this.quad(to, C.selected, tab))
    }
    return { remove, add }
  }
}
