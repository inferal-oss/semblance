// Function rules of the site's complete examples (demo/gallery/_ex-*.ttl): each example's
// own derivations (prices, unsaved changes...) have a SPARQL rule in its graph and a
// function twin here, so the examples also run where SPARQL can't. The host registers
// them with its projections, as it registers the todo example's reactions with the bus.
import type { FnRule } from '../engine/context.ts'
import { checkoutFunctions } from './checkout.ts'
import { chatFunctions } from './chat.ts'
import { settingsFunctions } from './settings.ts'

export const exampleFunctions: Record<string, FnRule> = {
  ...checkoutFunctions,
  ...chatFunctions,
  ...settingsFunctions,
}
