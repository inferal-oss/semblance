// Function rules and reactions for the data components (ontology/components/data.ttl).
import type { ReactionFn } from '../behaviour/events.ts'
import type { FnRule } from '../engine/context.ts'

export const functions: Record<string, FnRule> = {}

export const reactions: Record<string, ReactionFn> = {}
