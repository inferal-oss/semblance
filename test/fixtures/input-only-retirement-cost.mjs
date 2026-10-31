import { expect, it } from 'vitest';
import { createStore } from '../../src/node/load.ts';
import { Engine } from '../../src/engine/engine.ts';
import { Parked } from '../../src/engine/parked.ts';
import { Watchdog } from '../../src/engine/watchdog.ts';
import { MOD, NS } from '../../src/ns.ts';

const EX = 'https://example.org/input-retirement-cost#';

/** Count real collection visits during an interaction, including JS-side cache scans.
 * Store-call counts alone miss a linear scan of otherwise idle registrations.
 * Restore prototypes before assertions; no timing thresholds or production counters.
 */
function collectionVisits(run) {
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

function fixture(n, kind, exact, { seed = true, sleep = true, layer = false, enabled = true } = {}) {
  const owners = Array.from({ length: n }, (_, i) => EX + 'o' + i);
  const source = `
@prefix ex: <${EX}> . @prefix sem: <${NS.sem}> . @prefix owl: <${NS.owl}> . @prefix rdfs: <${NS.rdfs}> .
ex:Owner a owl:Class . ex:Other a owl:Class . ex:Seed a owl:Class .
ex:DerivedOwner a owl:Class ; rdfs:subClassOf ex:Owner .
ex:Guarded a sem:Rendering ; sem:targets ex:Owner ; sem:forEach ex:entry ; sem:inputOnly true ; sem:bulk false ; sem:stratum 0 ${kind === 'follower' ? '; sem:refresh sem:NextFrame' : ''} ${layer ? '; sem:layer ex:Audit' : ''} .
ex:Guarded-fn a sem:Rule ; sem:implements ex:Guarded ; sem:function "fixture:guarded" .
ex:Guarded-sparql a sem:Rule ; sem:implements ex:Guarded ; sem:construct """
PREFIX ex: <${EX}>
CONSTRUCT { $this ex:result ?value . ex:shared ex:support "kept" . }
WHERE { $this ex:entry $member . $member ex:value ?value . FILTER(?value = "invalid") }""" .
ex:Mint a sem:Rendering ; sem:targets ex:Seed ; sem:stratum -1 .
ex:Mint-fn a sem:Rule ; sem:implements ex:Mint ; sem:function "fixture:mint" .
ex:Mint-sparql a sem:Rule ; sem:implements ex:Mint ; sem:construct """
PREFIX ex: <${EX}>
CONSTRUCT { ex:o0 a ex:DerivedOwner . } WHERE {}""" .
${seed ? 'ex:seed a ex:Seed .' : ''}
ex:untracked a ex:Other .
${owners.map((owner, i) => `<${owner}> a ex:Owner ; ex:entry ex:m${i} . ex:m${i} ex:value "valid" .`).join('\n')}
${sleep ? 'ex:sleep a ex:Owner ; ex:entry ex:sleep-member . ex:sleep-member ex:value "valid" .' : ''}`;
  const store = createStore('wat');
  store.loadTurtle(source);
  const f = store.factory, nn = iri => f.namedNode(iri), dg = f.defaultGraph();
  const shown = new Set([...owners, EX + 'seed']);
  const engine = new Engine(store, {
    modality: MOD.Screen, layers: layer && enabled ? [EX + 'Audit'] : [], prefer: kind === 'member' ? 'sparql' : 'function', exactDependencies: exact,
    functions: {
      'fixture:guarded': (ctx, owner, member) => {
        if (kind === 'empty') return [];
        if (ctx.object(owner, EX + 'skip')?.value === 'true') return [];
        if (kind === 'follower') ctx.select(`SELECT ?v WHERE { <${member.value}> <${EX}value> ?v }`, { follow: true });
        else {
          const value = ctx.object(member, EX + 'value');
          if (kind === 'output' && value) return ctx.out(owner).t(owner, EX + 'result', value).t(ctx.nn(EX + 'shared'), EX + 'support', 'kept').quads;
        }
        return [];
      },
      'fixture:mint': (ctx, owner) => ctx.out(owner).t(ctx.nn(EX + 'o0'), NS.rdf + 'type', ctx.nn(EX + 'DerivedOwner')).quads,
    },
  });
  engine.demand = owner => shown.has(owner);
  const type = owner => f.quad(nn(owner), nn(NS.rdf + 'type'), nn(EX + 'Owner'), dg);
  const link = (owner, member) => f.quad(nn(owner), nn(EX + 'entry'), nn(member), dg);
  function apply({ remove = [], add = [] }) {
    const delta = { remove: [], add: [] };
    for (const q of remove) if (store.has(q)) { store.delete(q); delta.remove.push(q); }
    for (const q of add) if (!store.has(q)) { store.add(q); delta.add.push(q); }
    engine.process(delta);
  }
  const retire = (owner, member) => apply({ remove: [type(owner), link(owner, member)] });
  const calls = () => engine.stats.fnCalls + engine.stats.queries;
  const index = () => ({ owners: engine.footprint().inputPairOwners, pairs: engine.footprint().inputPairs });
  function dispose() {
    engine.dispose();
    expect(index()).toEqual({ owners: 0, pairs: 0 });
    const footprint = engine.footprint();
    for (const field of ['inputPairRules', 'outputs', 'readers', 'readsOf', 'following', 'memberReaders', 'members', 'deferred', 'stale']) expect(footprint[field], field).toBe(0);
    expect(engine.heldCount).toBe(0);
    expect(engine.stoppedCount).toBe(0);
    store.dispose?.();
  }
  return { store, engine, shown, owners, nn, dg, type, link, apply, retire, calls, index, dispose };
}

/** A removed rule can remain in the immutable definition catalog, but not in
 * active dependency/work/index caches. Inspect references, not only counters:
 * empty metadata maps can otherwise hide a removed-rule retention leak.
 */
function expectRuleReleased(engine, rule) {
  for (const name of ['outputs', 'readsOf', 'queryFollowers', 'memberKeys', 'inputPairsByRule', 'running', 'stopped', 'evaluations', 'pristine', 'checked']) {
    expect(Reflect.get(engine, name).has(rule), name).toBe(false);
  }
  for (const name of ['dirty', 'held', 'readers', 'memberReaders', 'inputPairs']) {
    for (const byRule of Reflect.get(engine, name).values()) expect(byRule.has(rule), name).toBe(false);
  }
  for (const followers of Reflect.get(engine, 'queryFollowersByPredicate').values()) {
    for (const follower of followers) expect(follower.rule).not.toBe(rule);
  }
  for (const follower of Reflect.get(engine, 'stale')) expect(follower.rule).not.toBe(rule);
  const parked = Reflect.get(engine, 'deferred');
  for (const name of ['byRule', 'rank']) expect(Reflect.get(parked, name).has(rule), 'parked.' + name).toBe(false);
}

for (const kind of ['reader', 'follower', 'member', 'output']) for (const exact of [false, true]) {
  it(`type withdrawal visits changed-owner state, not unrelated registrations (${kind}, exact=${exact})`, () => {
    function measure(n) {
      const h = fixture(n, kind, exact);
      try {
        h.engine.start();
        expect(h.index()).toEqual({ owners: n, pairs: n });
        expect(h.engine.footprint().deferred).toBe(1);
        const before = h.calls();
        h.shown.delete(h.owners[0]);
        const visits = [collectionVisits(() => h.retire(h.owners[0], EX + 'm0'))];
        expect(h.calls()).toBe(before);
        expect(h.index()).toEqual({ owners: n - 1, pairs: n - 1 });
        // Even a type with no selected rule must not scan the application's caches.
        visits.push(collectionVisits(() => h.apply({ remove: h.store.match(h.nn(EX + 'untracked'), h.nn(NS.rdf + 'type'), null, h.dg) })));
        // A never-evaluated, parked-only pair uses its existing owner index.
        visits.push(collectionVisits(() => h.retire(EX + 'sleep', EX + 'sleep-member')));
        expect(h.engine.footprint().deferred).toBe(0);
        expect(h.index()).toEqual({ owners: n - 1, pairs: n - 1 });
        expect(h.calls()).toBe(before);
        if (kind === 'output') expect(h.store.match(h.nn(EX + 'shared'), h.nn(EX + 'support'), null, h.engine.graph)).toHaveLength(1);
        return visits;
      } finally { h.dispose(); }
    }
    const small = measure(4), large = measure(256);
    expect(small[0]).toBeGreaterThan(0);
    expect(large).toEqual(small);
  });

  it(`input-pair index tracks live state across deletion, fresh identities, demand and disposal (${kind}, exact=${exact})`, () => {
    const n = 12, h = fixture(n, kind, exact);
    try {
      h.engine.start();
      expect(h.index()).toEqual({ owners: n, pairs: n });
      h.shown.delete(h.owners[0]);
      h.retire(h.owners[0], EX + 'm0');
      expect(h.index()).toEqual({ owners: n - 1, pairs: n - 1 });
      for (let cycle = 0; cycle < 16; cycle++) {
        const owner = EX + 'fresh-' + cycle, member = EX + 'fresh-member-' + cycle;
        h.apply({ add: [h.type(owner), h.link(owner, member), h.store.factory.quad(h.nn(member), h.nn(EX + 'value'), h.store.factory.literal('valid'), h.dg)] });
        // Parking alone does not create a second cache/history of all seen owners.
        expect(h.index()).toEqual({ owners: n - 1, pairs: n - 1 });
        h.shown.add(owner);
        h.engine.resume();
        expect(h.index()).toEqual({ owners: n, pairs: n });
        if (kind === 'follower') {
          h.apply({ add: [h.store.factory.quad(h.nn(member), h.nn(EX + 'value'), h.store.factory.literal('valid-again'), h.dg)] });
          expect(h.engine.footprint().stale).toBe(1);
        }
        const before = h.calls();
        h.shown.delete(owner);
        h.retire(owner, member);
        expect(h.index()).toEqual({ owners: n - 1, pairs: n - 1 });
        expect(h.engine.footprint().stale).toBe(0);
        h.engine.refresh();
        expect(h.calls()).toBe(before);
      }
      for (let i = 1; i < n; i++) { h.shown.delete(h.owners[i]); h.retire(h.owners[i], EX + 'm' + i); }
      h.retire(EX + 'sleep', EX + 'sleep-member');
      expect(h.index()).toEqual({ owners: 0, pairs: 0 });
      expect(h.engine.footprint().deferred).toBe(0);
    } finally { h.dispose(); }
  });
}

for (const mode of ['held', 'stopped']) for (const exact of [false, true]) {
  it(`pending-only ${mode} pairs retire without dispatch and leave no index history (exact=${exact})`, () => {
    const n = 16, h = fixture(n, 'empty', exact, { seed: false, sleep: false });
    const wd = new Watchdog();
    let tick = 0;
    wd.clock = () => ++tick;
    wd.budgetMs = 0;
    h.engine.watchdog = wd;
    try {
      h.engine.start();
      expect(h.engine.heldCount).toBe(n);
      expect(h.calls()).toBe(0);
      expect(h.index()).toEqual({ owners: n, pairs: n });
      if (mode === 'stopped') {
        expect(h.engine.stopHeld()).toBe(n);
        expect(h.engine.heldCount).toBe(0);
        expect(h.engine.stoppedCount).toBe(n);
      }
      wd.budgetMs = Infinity;
      h.shown.delete(h.owners[0]);
      h.retire(h.owners[0], EX + 'm0');
      expect(h.calls()).toBe(0);
      expect(h.index()).toEqual({ owners: n - 1, pairs: n - 1 });
      expect(mode === 'held' ? h.engine.heldCount : h.engine.stoppedCount).toBe(n - 1);
      if (mode === 'held') expect(h.engine.continueHeld()).toBe(false);
      else h.engine.retryStopped();
      expect(h.engine.heldCount).toBe(0);
      expect(h.engine.stoppedCount).toBe(0);
      expect(h.calls()).toBe(n - 1);
      // Empty, read-free evaluations retain no state or owner-index entry.
      expect(h.index()).toEqual({ owners: 0, pairs: 0 });
    } finally { h.dispose(); }
  });
}

for (const exact of [false, true]) {
  it(`replacing the last retained read with a read-free result drops the index entry (exact=${exact})`, () => {
    const h = fixture(4, 'reader', exact, { seed: false, sleep: false });
    try {
      h.engine.start();
      expect(h.index()).toEqual({ owners: 4, pairs: 4 });
      const skip = h.store.factory.quad(h.nn(h.owners[0]), h.nn(EX + 'skip'), h.store.factory.literal('true'), h.dg);
      h.apply({ add: [skip] });
      expect(h.index()).toEqual({ owners: 3, pairs: 3 });
      h.apply({ remove: [skip] });
      expect(h.index()).toEqual({ owners: 4, pairs: 4 });
      // Losing a membership link also retires state without losing the owner type.
      h.apply({ remove: [h.link(h.owners[0], EX + 'm0')] });
      expect(h.index()).toEqual({ owners: 3, pairs: 3 });
      const before = h.calls();
      h.apply({ remove: [h.type(h.owners[0])] });
      expect(h.calls()).toBe(before);
      expect(h.index()).toEqual({ owners: 3, pairs: 3 });
    } finally { h.dispose(); }
  });

  it(`retiring one owner visits and drops all of its member keys without disturbing other owners (exact=${exact})`, () => {
    const h = fixture(32, 'member', exact);
    try {
      h.engine.start();
      const owner = h.owners[0], members = [EX + 'm0', EX + 'extra-a', EX + 'extra-b'];
      h.apply({ add: members.slice(1).flatMap(member => [h.link(owner, member), h.store.factory.quad(h.nn(member), h.nn(EX + 'value'), h.store.factory.literal('valid'), h.dg)]) });
      expect(h.index()).toEqual({ owners: 32, pairs: 34 });
      h.apply({ remove: [h.link(owner, members[1])] });
      expect(h.index()).toEqual({ owners: 32, pairs: 33 });
      h.apply({ add: [h.link(owner, members[1])] });
      expect(h.index()).toEqual({ owners: 32, pairs: 34 });
      const before = h.calls();
      h.shown.delete(owner);
      h.apply({ remove: [h.type(owner), ...members.map(member => h.link(owner, member))] });
      expect(h.index()).toEqual({ owners: 31, pairs: 31 });
      expect(h.engine.footprint().memberReaders).toBe(31);
      expect(h.calls()).toBe(before);
    } finally { h.dispose(); }
  });
}

for (const state of ['evaluated', 'parked', 'held', 'stopped']) {
  it(`dispose clears the retirement index with ${state} work`, () => {
    const h = fixture(4, state === 'evaluated' ? 'reader' : 'empty', false, { seed: false, sleep: false });
    if (state === 'parked') h.shown.clear();
    if (state === 'held' || state === 'stopped') {
      const wd = new Watchdog(); let tick = 0;
      wd.clock = () => ++tick; wd.budgetMs = 0; h.engine.watchdog = wd;
    }
    try {
      h.engine.start();
      if (state === 'stopped') h.engine.stopHeld();
      expect(h.index().pairs).toBe(state === 'parked' ? 0 : 4);
    } finally { h.dispose(); }
  });
}

for (const kind of ['reader', 'follower', 'member', 'output']) for (const exact of [false, true]) {
  it(`installing, disabling and reinstalling an input-only layer releases rule caches (${kind}, exact=${exact})`, () => {
    const n = 8, h = fixture(n, kind, exact, { seed: false, sleep: false, layer: true, enabled: false });
    try {
      h.engine.start();
      expect(h.index()).toEqual({ owners: 0, pairs: 0 });
      for (let cycle = 0; cycle < 12; cycle++) {
        h.engine.reconfigure({ layers: new Set([EX + 'Audit']) });
        const rule = h.engine.activeRules.find(rule => rule.inputOnly);
        expect(rule).toBeDefined();
        expect(h.index()).toEqual({ owners: n, pairs: n });
        expect(h.engine.footprint().inputPairRules).toBe(1);
        if (kind === 'follower') {
          const member = h.nn(EX + 'm0');
          h.apply({ remove: h.store.match(member, h.nn(EX + 'value'), null, h.dg), add: [h.store.factory.quad(member, h.nn(EX + 'value'), h.store.factory.literal('change-' + cycle), h.dg)] });
          expect(h.engine.footprint().stale).toBe(1);
        }
        h.engine.reconfigure({ layers: new Set() });
        expect(h.engine.activeRules).not.toContain(rule);
        expectRuleReleased(h.engine, rule);
        expect(h.index()).toEqual({ owners: 0, pairs: 0 });
        expect(h.engine.footprint().inputPairRules).toBe(0);
        const before = h.calls(), member = h.nn(EX + 'm1');
        h.apply({ remove: h.store.match(member, h.nn(EX + 'value'), null, h.dg), add: [h.store.factory.quad(member, h.nn(EX + 'value'), h.store.factory.literal('disabled-' + cycle), h.dg)] });
        h.engine.refresh(); h.engine.resume(); h.engine.retryStopped(); h.engine.continueHeld();
        expect(h.calls()).toBe(before);
        expectRuleReleased(h.engine, rule);
      }
      // Removing/recreating component input while the rule is absent grants no evaluation.
      const before = h.calls();
      h.retire(h.owners[0], EX + 'm0');
      h.apply({ add: [h.type(h.owners[0]), h.link(h.owners[0], EX + 'm0')] });
      expect(h.calls()).toBe(before);
      h.engine.reconfigure({ layers: new Set([EX + 'Audit']) });
      expect(h.index()).toEqual({ owners: n, pairs: n });
    } finally { h.dispose(); }
  });
}

for (const state of ['parked', 'held', 'stopped']) for (const exact of [false, true]) {
  it(`removing a layer releases ${state} pairs and rule-order metadata (exact=${exact})`, () => {
    const n = 8, h = fixture(n, 'reader', exact, { seed: false, sleep: false, layer: true });
    if (state === 'parked') h.shown.clear();
    const wd = new Watchdog(); let tick = 0;
    wd.clock = () => ++tick; wd.budgetMs = state === 'parked' ? Infinity : 0; h.engine.watchdog = wd;
    try {
      h.engine.start();
      const rule = h.engine.activeRules.find(rule => rule.inputOnly);
      expect(rule).toBeDefined();
      if (state === 'stopped') expect(h.engine.stopHeld()).toBe(n);
      expect(h.calls()).toBe(0);
      expect(state === 'parked' ? h.engine.footprint().deferred : state === 'held' ? h.engine.heldCount : h.engine.stoppedCount).toBe(n);
      h.engine.reconfigure({ layers: new Set() });
      expectRuleReleased(h.engine, rule);
      expect(h.index()).toEqual({ owners: 0, pairs: 0 });
      expect(h.engine.footprint().inputPairRules).toBe(0);
      expect(h.engine.footprint().deferred).toBe(0);
      expect(h.engine.heldCount).toBe(0);
      expect(h.engine.stoppedCount).toBe(0);
      expect(wd.held).toBe(0);
      h.engine.refresh(); h.engine.resume(); h.engine.retryStopped(); h.engine.continueHeld();
      expect(h.calls()).toBe(0);
      wd.budgetMs = Infinity;
      for (const owner of h.owners) h.shown.add(owner);
      h.engine.reconfigure({ layers: new Set([EX + 'Audit']) });
      expect(h.calls()).toBe(n);
      expect(h.index()).toEqual({ owners: n, pairs: n });
    } finally { h.dispose(); }
  });
}

it('parked rule teardown removes all owned keys and metadata while keeping surviving rule order', () => {
  const parked = new Parked(key => key.split(' ')[0]);
  const first = {}, second = {}, third = {}, fourth = {};
  parked.add(first, 'a one'); parked.add(first, 'b two');
  parked.add(second, 'c three'); parked.add(third, 'd four');
  parked.deleteRule(first);
  expect(parked.size).toBe(2);
  expect(parked.hasFocus('a')).toBe(false);
  expect(parked.hasFocus('b')).toBe(false);
  expect(Reflect.get(parked, 'byRule').has(first)).toBe(false);
  expect(Reflect.get(parked, 'rank').has(first)).toBe(false);
  parked.add(fourth, 'e five');
  const rows = [...parked.take('e'), ...parked.take('d'), ...parked.take('c')].sort((a, b) => a[2] - b[2] || a[3] - b[3]);
  expect(rows.map(row => row[0])).toEqual([second, third, fourth]);
  expect(rows.map(row => row[2])).toEqual([1, 2, 3]);
  parked.add(first, 'f six');
  expect(parked.take('f')[0][2]).toBe(4);
  parked.add(second, 'g seven'); parked.clear();
  expect(parked.size).toBe(0);
  expect([...parked.foci()]).toEqual([]);
  expect([...parked]).toEqual([]);
  expect(Reflect.get(parked, 'rank').size).toBe(0);
});

for (const exact of [false, true]) {
  it(`a pristine input-only rule acquires state only when an input owner appears (exact=${exact})`, () => {
    const h = fixture(0, 'reader', exact, { seed: false, sleep: false, layer: true, enabled: false });
    try {
      h.engine.start();
      h.engine.reconfigure({ layers: new Set([EX + 'Audit']) });
      const rule = h.engine.activeRules.find(rule => rule.inputOnly);
      expect(Reflect.get(h.engine, 'pristine').has(rule)).toBe(exact);
      expect(h.index()).toEqual({ owners: 0, pairs: 0 });
      const owner = EX + 'late-owner', member = EX + 'late-member';
      h.shown.add(owner);
      h.apply({ add: [h.type(owner), h.link(owner, member), h.store.factory.quad(h.nn(member), h.nn(EX + 'value'), h.store.factory.literal('valid'), h.dg)] });
      expect(h.index()).toEqual({ owners: 1, pairs: 1 });
      expect(Reflect.get(h.engine, 'pristine').has(rule)).toBe(false);
      h.engine.reconfigure({ layers: new Set() });
      expectRuleReleased(h.engine, rule);
      expect(h.index()).toEqual({ owners: 0, pairs: 0 });
    } finally { h.dispose(); }
  });
}
