// A small design system of the example's own: five React components, its own class names and
// stylesheet (design-system.css), and one React context. Semblance's graph says what is shown and
// what happens; these components draw it (bindings.ttl says which draws which class).
//
// Each component spreads `root` on its root element (the projection's attributes and the ref that
// tells Semblance which element it is) and puts `children`, what Semblance projected, inside.
import { createContext, createElement, type ReactNode, useContext } from 'react'
import type { HostProps } from '@inferal-oss/semblance-react'

type Density = 'compact' | 'comfortable'
/** How roomy what is inside is: a Stack with a density sets it for every component under it. */
const DensityContext = createContext<Density>('comfortable')

const cx = (...names: unknown[]) => names.filter((n) => typeof n === 'string' && n).join(' ')

export function Stack({ root, children, direction, density }: HostProps & { direction?: string; density?: Density }) {
  const inherited = useContext(DensityContext)
  const own = density ?? inherited
  const box = createElement('div', { ...root, className: cx(root.className, 'ds-stack', direction === 'row' && 'ds-stack--row', `ds-density--${own}`) }, children)
  return density ? createElement(DensityContext.Provider, { value: density }, box) : box
}

export function Heading({ root, children, level }: HostProps & { level?: number }) {
  const tag = `h${Math.min(Math.max(level ?? 2, 1), 6)}`
  return createElement(tag, { ...root, className: cx(root.className, 'ds-heading') }, children)
}

export function Button({ root, children, intent }: HostProps & { intent?: string }) {
  const density = useContext(DensityContext)
  return createElement('button', { type: 'button', ...root, className: cx(root.className, 'ds-button', `ds-button--${intent ?? 'secondary'}`, density === 'compact' && 'ds-button--small') }, children)
}

export function Field({ root, children, invalid }: HostProps & { invalid?: string }) {
  return createElement('div', { ...root, className: cx(root.className, 'ds-field', invalid && 'ds-field--invalid') }, children)
}

export function List({ root, children }: HostProps) {
  return createElement('ul', { ...root, className: cx(root.className, 'ds-list') }, children as ReactNode)
}

/** The components by the names bindings.ttl gives. */
export const components = { Stack, Heading, Button, Field, List }
