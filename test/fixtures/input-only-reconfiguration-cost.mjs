import { expect, it } from 'vitest';
import { createStore } from '../../src/node/load.ts';
import { Engine } from '../../src/engine/engine.ts';
import { Watchdog } from '../../src/engine/watchdog.ts';
import { MOD, NS } from '../../src/ns.ts';

const EX = 'https://example.org/input-reconfiguration-cost#';

function collectionVisits(run, observe) {
  let visits = 0;
  const undo = [];
  try {
    for (const prototype of [Map.prototype, Set.prototype]) {
      for (const name of [Symbol.iterator, 'keys', 'values', 'entries']) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        const original = descriptor.value;
        Object.defineProperty(prototype, name, {
          ...descriptor,
          value: function* (...args) {
            for (const value of original.apply(this, args)) {
              visits++;
              observe?.(this, value, name);
              yield value;
            }
          },
        });
        undo.push(() => Object.defineProperty(prototype, name, descriptor));
      }
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'forEach');
      const original = descriptor.value;
      Object.defineProperty(prototype, 'forEach', {
        ...descriptor,
        value: function (callback, receiver) {
          return original.call(this, (value, key, collection) => {
            visits++;
            observe?.(this, [key, value], 'entries');
            callback.call(receiver, value, key, collection);
          });
        },
      });
      undo.push(() => Object.defineProperty(prototype, 'forEach', descriptor));
    }
    run();
    return visits;
  } finally {
    for (const restore of undo.reverse()) restore();
  }
}


function fixture(n, { exact, keptInputOnly = true, goneInputOnly = true, mixed = false }) {
  const slot = (name, target, inputOnly, layered, predicate) => `
ex:${name} a sem:Rendering ; sem:targets ex:${target} ; sem:forEach ex:entry ; sem:bulk false ; sem:stratum 0 ${inputOnly ? '; sem:inputOnly true' : ''} ${layered ? '; sem:layer ex:Audit' : ''} .
ex:${name}-sparql a sem:Rule ; sem:implements ex:${name} ; sem:construct """
PREFIX ex: <${EX}>
CONSTRUCT { $this ex:${predicate} ?value . }
WHERE { $this ex:entry $member . $member ex:value ?value . FILTER(?value = "invalid") }""" .`;
  const source = `
@prefix ex: <${EX}> . @prefix sem: <${NS.sem}> . @prefix owl: <${NS.owl}> .
ex:KeepOwner a owl:Class . ex:GoneOwner a owl:Class .
${slot('Keep', 'KeepOwner', keptInputOnly, false, 'kept-result')}
${slot('Gone', 'GoneOwner', goneInputOnly, true, 'gone-result')}
${mixed ? slot('Legacy', 'GoneOwner', false, true, 'legacy-result') : ''}
${Array.from({ length: n }, (_, i) => `ex:keep-${i} a ex:KeepOwner ; ex:entry ex:member-${i} . ex:member-${i} ex:value "valid" .`).join('\n')}
ex:gone a ex:GoneOwner ; ex:entry ex:gone-member . ex:gone-member ex:value "valid" .`;
  const store = createStore('wat'); store.loadTurtle(source);
  const f = store.factory, nn = name => f.namedNode(EX + name), dg = f.defaultGraph();
  const engine = new Engine(store, { modality: MOD.Screen, layers: [EX + 'Audit'], prefer: 'sparql', exactDependencies: exact });
  function change(member, value) {
    const delta = { remove: store.match(nn(member), nn('value'), null, dg), add: [f.quad(nn(member), nn('value'), f.literal(value), dg)] };
    for (const q of delta.remove) store.delete(q);
    for (const q of delta.add) store.add(q);
    engine.process(delta);
  }
  const result = (owner, predicate) => store.match(nn(owner), nn(predicate), null, engine.graph);
  function dispose() { engine.dispose(); store.dispose?.(); }
  return { engine, store, change, result, dispose };
}

/** Instrument the real removal phase of an ordinary reconfigure call.
 * Selection, activation, reindexing, and evaluation are outside this counter:
 * the whole reconfigure operation intentionally retains its upstream app scan.
 */
function removalVisits(engine, action) {
  const original = Reflect.get(engine, 'dropRules'), visits = [];
  const descriptor = Object.getOwnPropertyDescriptor(engine, 'dropRules');
  const members = Reflect.get(engine, 'memberReaders');
  const unrelatedMembers = new Set(), unrelatedContainers = new Set();
  for (const [member, byRule] of members) if (member.startsWith(EX + 'member-')) {
    unrelatedMembers.add(member);
    unrelatedContainers.add(byRule);
    for (const keys of byRule.values()) unrelatedContainers.add(keys);
  }
  Reflect.set(engine, 'dropRules', function (kept) {
    let result, unrelated = 0;
    const total = collectionVisits(() => { result = original.call(this, kept); }, (container, value, method) => {
      if (unrelatedContainers.has(container)) unrelated++;
      else if (container === members) {
        if (method === 'values' ? unrelatedContainers.has(value) : unrelatedMembers.has(method === 'keys' ? value : value[0])) unrelated++;
      }
    });
    visits.push({ total, unrelated });
    return result;
  });
  try { action(); } finally {
    if (descriptor) Object.defineProperty(engine, 'dropRules', descriptor);
    else Reflect.deleteProperty(engine, 'dropRules');
  }
  expect(visits).toHaveLength(1);
  return visits[0];
}

for (const keptInputOnly of [false, true]) for (const exact of [false, true]) {
  it(`input-only removal cleanup does not visit unrelated kept member-reader registrations (kept inputOnly=${keptInputOnly}, exact=${exact})`, () => {
    function measure(n) {
      const h = fixture(n, { exact, keptInputOnly });
      try {
        h.engine.start();
        expect(h.engine.footprint().memberReaders).toBe(n + 1);
        const goneRule = h.engine.activeRules.find(rule => rule.slot === EX + 'Gone');
        expect(goneRule).toBeDefined();
        const before = h.engine.stats.queries;
        const work = removalVisits(h.engine, () => h.engine.reconfigure({ layers: new Set() }));
        expect(work.unrelated).toBe(0);
        expect(h.engine.stats.queries).toBe(before);
        expect(h.engine.footprint().memberReaders).toBe(n);
        expect(h.engine.footprint().inputPairs).toBe(keptInputOnly ? n : 0);
        expect(h.engine.footprint().inputPairRules).toBe(keptInputOnly ? 1 : 0);
        expect(h.engine.activeRules).not.toContain(goneRule);
        for (const name of ['outputs', 'memberKeys', 'inputPairsByRule', 'dirty', 'held', 'stopped', 'pristine']) {
          if (name === 'dirty' || name === 'held') {
            for (const byRule of Reflect.get(h.engine, name).values()) expect(byRule.has(goneRule)).toBe(false);
          } else expect(Reflect.get(h.engine, name).has(goneRule)).toBe(false);
        }
        for (const byRule of Reflect.get(h.engine, 'memberReaders').values()) expect(byRule.has(goneRule)).toBe(false);
        expect(h.engine.heldCount).toBe(0);
        expect(h.engine.stoppedCount).toBe(0);
        expect(h.engine.footprint().deferred).toBe(0);
        // Removed work stays absent; retained zero-output pairs still hear edits.
        h.change('gone-member', 'invalid');
        expect(h.engine.stats.queries).toBe(before);
        expect(h.result('gone', 'gone-result')).toHaveLength(0);
        h.change('member-0', 'invalid');
        expect(h.engine.stats.queries).toBe(before + 1);
        expect(h.result('keep-0', 'kept-result')).toHaveLength(1);
        expect(h.result('keep-1', 'kept-result')).toHaveLength(0);
        expect(h.engine.footprint().memberReaders).toBe(n);
        return work;
      } finally { h.dispose(); }
    }
    const small = measure(4), large = measure(256);
    expect(small.total).toBeGreaterThan(0);
    expect(large).toEqual(small);
  });
}

for (const mixed of [false, true]) for (const exact of [false, true]) {
  it(`non-input-only removal retains legacy cleanup and kept registrations (mixed=${mixed}, exact=${exact})`, () => {
    const n = 16, h = fixture(n, { exact, goneInputOnly: mixed, mixed });
    try {
      h.engine.start();
      expect(h.engine.footprint().memberReaders).toBe(n + (mixed ? 2 : 1));
      const before = h.engine.stats.queries;
      h.engine.reconfigure({ layers: new Set() });
      expect(h.engine.stats.queries).toBe(before);
      expect(h.engine.footprint().memberReaders).toBe(n);
      expect(h.engine.footprint().inputPairs).toBe(n);
      h.change('gone-member', 'invalid');
      expect(h.engine.stats.queries).toBe(before);
      expect(h.result('gone', 'gone-result')).toHaveLength(0);
      expect(h.result('gone', 'legacy-result')).toHaveLength(0);
      h.change('member-0', 'invalid');
      expect(h.engine.stats.queries).toBe(before + 1);
      expect(h.result('keep-0', 'kept-result')).toHaveLength(1);
      expect(h.engine.footprint().memberReaders).toBe(n);
    } finally { h.dispose(); }
  });
}

for (const exact of [false, true]) {
  it(`input-only removal cleanup preserves a retained rule's held work (exact=${exact})`, () => {
    const n = 8, h = fixture(n, { exact });
    const wd = new Watchdog(); let tick = 0;
    wd.clock = () => ++tick; wd.budgetMs = 0; h.engine.watchdog = wd;
    try {
      h.engine.start();
      expect(h.engine.heldCount).toBe(n + 1);
      expect(h.engine.stats.queries).toBe(0);
      h.engine.reconfigure({ layers: new Set() });
      expect(h.engine.heldCount).toBe(n);
      expect(wd.held).toBe(n);
      expect(h.engine.footprint().inputPairs).toBe(n);
      expect(h.engine.stats.queries).toBe(0);
      wd.budgetMs = Infinity;
      expect(h.engine.continueHeld()).toBe(false);
      expect(h.engine.heldCount).toBe(0);
      expect(wd.held).toBe(0);
      expect(h.engine.stats.queries).toBe(n);
      expect(h.engine.footprint().memberReaders).toBe(n);
      h.change('member-0', 'invalid');
      expect(h.result('keep-0', 'kept-result')).toHaveLength(1);
    } finally { h.dispose(); }
  });
}
