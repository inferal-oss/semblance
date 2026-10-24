// Function twins of the checkout example's rules (demo/gallery/_ex-checkout.ttl). Each
// writes the same triples as its SPARQL sibling, so either can price the order.
import type { NamedNode, Term } from '@rdfjs/types'
import type { FnRule } from '../engine/context.ts'
import { C, NS, RDF_TYPE, XSD_BOOLEAN } from '../ns.ts'

const UI = 'https://semblance.dev/demo#'
const CO = 'https://semblance.dev/demo/checkout#'
const RDFS_LABEL = NS.rdfs + 'label'

const named = (t: Term | undefined): t is NamedNode => t?.termType === 'NamedNode'
/** A decimal as whole cents (the SPARQL rule's xsd:integer(ROUND(?x * 100))). */
const cents = (t: Term | undefined) => Math.round(Number(t?.value ?? 0) * 100)
/** Cents as "$12.50". */
const money = (n: number) => `$${Math.floor(n / 100)}.${String(n - Math.floor(n / 100) * 100).padStart(2, '0')}`

/** co:Pricing: every figure of the order, from its lines (see the SPARQL rule for what it writes). */
const pricing: FnRule = (ctx, focus) => {
  if (!ctx.match(focus, RDF_TYPE, CO + 'Order').length) return []
  const speed = ctx.object(focus, CO + 'speed')
  const rate = ctx.object(focus, CO + 'taxRate')
  const threshold = ctx.object(CO + 'Standard', CO + 'freeFrom')
  if (!named(speed) || !rate || !threshold) return []
  const cost = ctx.object(speed, CO + 'cost')
  if (!cost) return []
  const speedFree = ctx.object(speed, CO + 'freeFrom')
  const lines = ctx
    .objects(focus, CO + 'line')
    .filter(named)
    .filter((l) => ctx.object(l, CO + 'status')?.value === CO + 'InCart')
    .flatMap((line) => {
      const q = ctx.object(line, CO + 'quantity')
      const price = ctx.object(line, CO + 'unitPrice')
      return q && price ? [{ line, q: Number(q.value), cents: Number(q.value) * cents(price) }] : []
    })
  const sub = lines.reduce((s, l) => s + l.cents, 0)
  const count = lines.reduce((s, l) => s + l.q, 0)
  const freeCents = cents(threshold)
  const ship = count === 0 || (speedFree && sub >= cents(speedFree)) ? 0 : cents(cost)
  const tax = Math.round(sub * Number(rate.value))
  const total = sub + ship + tax

  const o = ctx.out(focus)
  const yes = ctx.f.literal('true', ctx.nn(XSD_BOOLEAN))
  const at = (iri: string) => ctx.nn(iri)
  o.t(at(UI + 'co-sum-items'), C.value, `${count}${count === 1 ? ' item' : ' items'}`)
  o.t(at(UI + 'co-sum-subtotal'), C.value, money(sub))
  o.t(at(UI + 'co-sum-shipping'), C.value, ship === 0 ? 'Free' : money(ship))
  o.t(at(UI + 'co-sum-tax'), C.value, money(tax))
  o.t(at(UI + 'co-sum-total'), C.value, money(total))
  o.t(focus, CO + 'totalDue', money(total))
  for (const { line, q, cents: lineCents } of lines) {
    const qtyText = ctx.object(line, CO + 'quantityText')
    const totalText = ctx.object(line, CO + 'totalText')
    const fewer = ctx.object(line, CO + 'fewer')
    const more = ctx.object(line, CO + 'more')
    const max = ctx.object(line, CO + 'maxQuantity')
    const name = ctx.object(line, RDFS_LABEL)
    if (named(qtyText)) o.t(qtyText, C.label, String(q))
    if (named(totalText)) o.t(totalText, C.label, money(lineCents))
    o.t(line, CO + 'amount', money(lineCents))
    if (name) o.t(line, CO + 'caption', `${name.value} × ${q}`)
    o.t(focus, CO + 'reviewLine', line)
    if (named(fewer) && q <= 1) o.t(fewer, C.disabled, yes)
    if (named(more) && max && q >= Number(max.value)) o.t(more, C.disabled, yes)
  }
  const hint = at(UI + 'co-free-hint')
  if (count === 0) o.t(hint, C.label, 'Your cart is empty.')
  else if (sub >= freeCents) o.t(hint, C.label, 'Standard shipping is free on this order.')
  else o.t(hint, C.label, `Add ${money(freeCents - sub)} more for free standard shipping.`)
  if (count === 0) o.t(at(UI + 'co-to-shipping'), C.disabled, yes)
  return o.quads
}

export const checkoutFunctions: Record<string, FnRule> = { 'checkout:pricing': pricing }
