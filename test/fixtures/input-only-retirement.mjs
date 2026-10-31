import {it,expect} from 'vitest';
import {createStore} from '../../src/node/load.ts';
import {Engine} from '../../src/engine/engine.ts';
import {MOD,NS} from '../../src/ns.ts';

const EX='https://example.org/input-only-retirement#';
const ONE=EX+'one',TWO=EX+'two',GHOST=EX+'derived-only',SEED=EX+'seed';

for(const prefer of ['sparql','function'])for(const members of [false,true])for(const exact of [false,true]){
 it(`input-only ${members?'member':'component'} output retires without evaluating an untyped hidden owner (${prefer}, exact=${exact})`,()=>{
  const access=members?`$this <${EX}entry> $member . $member <${EX}value> ?value .`:`$this <${EX}value> ?value .`;
  const ghostData=members?`<${GHOST}> <${EX}entry> <${EX}ghost-member> . <${EX}ghost-member> <${EX}value> "ghost" .`:`<${GHOST}> <${EX}value> "ghost" .`;
  const source=`
@prefix ex: <${EX}> . @prefix sem: <${NS.sem}> . @prefix owl: <${NS.owl}> . @prefix rdfs: <${NS.rdfs}> .
ex:Owner a owl:Class . ex:DerivedOwner a owl:Class ; rdfs:subClassOf ex:Owner . ex:Seed a owl:Class .
ex:Guarded a sem:Rendering ; sem:targets ex:Owner ; sem:stratum 0 ; sem:inputOnly true ; sem:bulk false ${members?'; sem:forEach ex:entry':''} .
ex:Guarded-fn a sem:Rule ; sem:implements ex:Guarded ; sem:function "fixture:guarded" .
ex:Guarded-sparql a sem:Rule ; sem:implements ex:Guarded ; sem:construct """
CONSTRUCT { $this <${EX}result> ?value . <${EX}shared> <${EX}support> "kept" . }
WHERE { ${access} }""" .
ex:Mint a sem:Rendering ; sem:targets ex:Seed ; sem:stratum -1 .
ex:Mint-fn a sem:Rule ; sem:implements ex:Mint ; sem:function "fixture:mint" .
ex:Mint-sparql a sem:Rule ; sem:implements ex:Mint ; sem:construct """
CONSTRUCT { <${GHOST}> a <${EX}Owner> . <${ONE}> a <${EX}DerivedOwner> . ${ghostData} } WHERE {}""" .
ex:seed a ex:Seed .
ex:one a ex:Owner ; ex:entry ex:member-one ; ex:value "first" .
ex:two a ex:Owner ; ex:entry ex:member-two ; ex:value "second" .
ex:member-one ex:value "first" . ex:member-two ex:value "second" .`;
  const store=createStore('wat');store.loadTurtle(source);
  const f=store.factory,nn=value=>f.namedNode(value),dg=f.defaultGraph();
  const fnCalls=[],queries=[];
  for(const method of ['construct','constructFor']){
   const original=store[method]?.bind(store);
   if(original)store[method]=(...args)=>{
    if(args[0].includes(`<${EX}result>`))queries.push({query:args[0],values:method==='constructFor'?args[2].map(v=>v.value):[]});
    return original(...args);
   };
  }
  const shown=new Set([ONE,TWO,GHOST,SEED]);
  const engine=new Engine(store,{modality:MOD.Screen,layers:[],prefer,exactDependencies:exact,functions:{
   'fixture:guarded':(ctx,owner,member)=>{
    fnCalls.push(owner.value);
    if(member&&!ctx.match(owner,EX+'entry',member).length)return [];
    const value=ctx.object(member??owner,EX+'value');
    if(!value)return [];
    const out=ctx.out(owner);
    out.t(owner,EX+'result',value).t(ctx.nn(EX+'shared'),EX+'support','kept');
    return out.quads;
   },
   'fixture:mint':(ctx,seed)=>{
    const out=ctx.out(seed),ghost=ctx.nn(GHOST);
    out.t(ghost,NS.rdf+'type',ctx.nn(EX+'Owner')).t(ctx.nn(ONE),NS.rdf+'type',ctx.nn(EX+'DerivedOwner'));
    if(members)out.t(ghost,EX+'entry',ctx.nn(EX+'ghost-member')).t(ctx.nn(EX+'ghost-member'),EX+'value','ghost');
    else out.t(ghost,EX+'value','ghost');
    return out.quads;
   },
  }});
  engine.demand=owner=>shown.has(owner);
  const result=owner=>store.match(nn(owner),nn(EX+'result'),null,engine.graph);
  const support=()=>store.match(nn(EX+'shared'),nn(EX+'support'),f.literal('kept'),engine.graph);
  const calls=()=>prefer==='function'?fnCalls.length:queries.length;
  // Match Runtime.apply's contract: mutate all input first, then process one delta.
  function apply({remove=[],add=[]}){
   const effective={remove:[],add:[]};
   for(const q of remove)if(store.has(q)){store.delete(q);effective.remove.push(q);}
   for(const q of add)if(!store.has(q)){store.add(q);effective.add.push(q);}
   engine.process(effective);
  }
  const type=owner=>f.quad(nn(owner),nn(NS.rdf+'type'),nn(EX+'Owner'),dg);
  try{
   engine.start();
   expect(engine.activeRules.some(r=>r.iri===EX+'Guarded-'+(prefer==='function'?'fn':'sparql')&&r.kind===prefer)).toBe(true);
   expect(result(ONE).map(q=>q.object.value)).toEqual(['first']);
   expect(result(TWO).map(q=>q.object.value)).toEqual(['second']);expect(support()).toHaveLength(1);
   // The derived component is demanded, but has never been typed in the input.
   expect(store.match(nn(GHOST),nn(NS.rdf+'type'),nn(EX+'Owner'),engine.graph)).toHaveLength(1);
   expect(store.match(nn(ONE),nn(NS.rdf+'type'),nn(EX+'DerivedOwner'),engine.graph)).toHaveLength(1);
   expect(result(GHOST)).toHaveLength(0);expect(fnCalls).not.toContain(GHOST);
   expect(queries.some(q=>q.query.includes(`<${GHOST}>`)||q.values.includes(GHOST))).toBe(false);
   const before=calls();expect(before).toBeGreaterThan(0);
   shown.clear(); // Retirement must work even after the owner ceases to be shown.
   apply({remove:[type(ONE)]});
   expect(store.match(nn(ONE),nn(NS.rdf+'type'),null,dg)).toHaveLength(0);
   expect(result(ONE)).toHaveLength(0);expect(result(TWO)).toHaveLength(1);expect(support()).toHaveLength(1);
   expect(calls()).toBe(before);
   const input=members?EX+'member-one':ONE;
   apply({remove:store.match(nn(input),nn(EX+'value'),null,dg),add:[f.quad(nn(input),nn(EX+'value'),f.literal('updated'),dg)]});
   expect(result(ONE)).toHaveLength(0);expect(calls()).toBe(before);
   expect(result(TWO)).toHaveLength(1);expect(support()).toHaveLength(1);
   // Retyping restores normal demand parking, then evaluates when shown again.
   apply({add:[type(ONE)]});expect(result(ONE)).toHaveLength(0);expect(calls()).toBe(before);
   shown.add(ONE);engine.resume();
   expect(result(ONE).map(q=>q.object.value)).toEqual(['updated']);expect(calls()).toBeGreaterThan(before);
   expect(result(TWO)).toHaveLength(1);expect(support()).toHaveLength(1);
   const resumed=calls();shown.clear();
   apply({remove:[type(ONE),type(TWO)]});
   expect(result(ONE)).toHaveLength(0);expect(result(TWO)).toHaveLength(0);expect(support()).toHaveLength(0);
   expect(result(GHOST)).toHaveLength(0);expect(calls()).toBe(resumed);
   // A different producer's derived type survives; retired member ownership does not.
   expect(store.match(nn(ONE),nn(NS.rdf+'type'),nn(EX+'DerivedOwner'),engine.graph)).toHaveLength(1);
   expect(engine.footprint().members).toBe(0);expect(engine.footprint().memberReaders).toBe(0);
  }finally{engine.dispose();store.dispose?.();}
 });
}

for(const kind of ['function-reader','function-follower','sparql-member'])for(const exact of [false,true]){
 it(`zero-output ${kind} registrations retire exactly after type and link removal (exact=${exact})`,()=>{
  const prefer=kind==='sparql-member'?'sparql':'function',SLEEP=EX+'sleep';
  const source=`
@prefix ex: <${EX}> . @prefix sem: <${NS.sem}> . @prefix owl: <${NS.owl}> . @prefix rdfs: <${NS.rdfs}> .
ex:Owner a owl:Class . ex:Other a owl:Class .
ex:DerivedOwner a owl:Class ; rdfs:subClassOf ex:Owner . ex:Seed a owl:Class .
ex:Zero a sem:Rendering ; sem:targets ex:Owner ; sem:forEach ex:entry ; sem:inputOnly true ; sem:bulk false ; sem:stratum 0 ${kind==='function-follower'?'; sem:refresh sem:NextFrame':''} .
ex:Zero-fn a sem:Rule ; sem:implements ex:Zero ; sem:function "fixture:zero" .
ex:Zero-sparql a sem:Rule ; sem:implements ex:Zero ; sem:construct """
CONSTRUCT { $this <${EX}unexpected> ?value . }
WHERE { $this <${EX}entry> $member . $member <${EX}value> ?value . FILTER(?value = "invalid") }""" .
ex:Mint a sem:Rendering ; sem:targets ex:Seed ; sem:stratum -1 .
ex:Mint-fn a sem:Rule ; sem:implements ex:Mint ; sem:function "fixture:mint-zero" .
ex:Mint-sparql a sem:Rule ; sem:implements ex:Mint ; sem:construct """
CONSTRUCT { <${ONE}> a <${EX}DerivedOwner> . <${GHOST}> a <${EX}Owner> ; <${EX}entry> <${EX}ghost-member> . <${EX}ghost-member> <${EX}value> "valid" . } WHERE {}""" .
ex:seed a ex:Seed .
ex:one a ex:Owner ; ex:entry ex:member-one . ex:member-one ex:value "valid" .
ex:two a ex:Owner ; ex:entry ex:member-two . ex:member-two ex:value "valid" .
ex:sleep a ex:Owner ; ex:entry ex:member-sleep . ex:member-sleep ex:value "valid" .`;
  const store=createStore('wat');store.loadTurtle(source);
  const f=store.factory,nn=value=>f.namedNode(value),dg=f.defaultGraph(),fnCalls=[],queries=[];
  for(const method of ['construct','constructFor']){
   const original=store[method]?.bind(store);
   if(original)store[method]=(...args)=>{
    if(args[0].includes(`<${EX}unexpected>`))queries.push({query:args[0],values:method==='constructFor'?args[2].map(v=>v.value):[]});
    return original(...args);
   };
  }
  const shown=new Set([ONE,TWO,GHOST,SEED]);
  const engine=new Engine(store,{modality:MOD.Screen,layers:[],prefer,exactDependencies:exact,functions:{
   'fixture:zero':(ctx,owner,member)=>{
    fnCalls.push(owner.value);
    if(kind==='function-follower')ctx.select(`SELECT ?value WHERE { <${member.value}> <${EX}value> ?value }`,{follow:true});
    else ctx.object(member,EX+'value');
    return [];
   },
   'fixture:mint-zero':(ctx,seed)=>{
    const out=ctx.out(seed);
    out.t(ctx.nn(ONE),NS.rdf+'type',ctx.nn(EX+'DerivedOwner'))
      .t(ctx.nn(GHOST),NS.rdf+'type',ctx.nn(EX+'Owner'))
      .t(ctx.nn(GHOST),EX+'entry',ctx.nn(EX+'ghost-member'))
      .t(ctx.nn(EX+'ghost-member'),EX+'value','valid');
    return out.quads;
   },
  }});
  engine.demand=owner=>shown.has(owner);
  const axis=kind==='function-reader'?'readsOf':kind==='function-follower'?'following':'memberReaders';
  const count=()=>engine.footprint()[axis],calls=()=>prefer==='function'?fnCalls.length:queries.length;
  const type=owner=>f.quad(nn(owner),nn(NS.rdf+'type'),nn(EX+'Owner'),dg);
  const link=(owner,member)=>f.quad(nn(owner),nn(EX+'entry'),nn(EX+member),dg);
  function apply({remove=[],add=[]}){
   const effective={remove:[],add:[]};
   for(const q of remove)if(store.has(q)){store.delete(q);effective.remove.push(q);}
   for(const q of add)if(!store.has(q)){store.add(q);effective.add.push(q);}
   engine.process(effective);
  }
  const change=(member,value)=>apply({remove:store.match(nn(EX+member),nn(EX+'value'),null,dg),add:[f.quad(nn(EX+member),nn(EX+'value'),f.literal(value),dg)]});
  try{
   engine.start();
   expect(engine.activeRules.some(r=>r.iri===EX+'Zero-'+(prefer==='function'?'fn':'sparql')&&r.kind===prefer)).toBe(true);
   expect(store.match(null,nn(EX+'unexpected'),null,engine.graph)).toHaveLength(0);
   expect(engine.footprint().members).toBe(0);expect(count()).toBe(2);
   expect(fnCalls).not.toContain(GHOST);expect(fnCalls).not.toContain(SLEEP);
   expect(queries.some(q=>q.query.includes(`<${GHOST}>`)||q.values.includes(GHOST)||q.query.includes(`<${SLEEP}>`)||q.values.includes(SLEEP))).toBe(false);
   expect(engine.footprint().deferred).toBe(1);
   const initial=calls();expect(initial).toBeGreaterThan(0);
   // A never-evaluated parked pair must also disappear without a new invocation.
   apply({remove:[type(SLEEP),link(SLEEP,'member-sleep')]});
   expect(engine.footprint().deferred).toBe(0);expect(count()).toBe(2);expect(calls()).toBe(initial);
   if(kind==='function-follower'){
    change('member-one','valid-again');
    expect(engine.footprint().stale).toBe(1);expect(calls()).toBe(initial);
   }
   shown.delete(ONE);
   // The source member remains; both the last input type and owner link are gone.
   apply({remove:[type(ONE),link(ONE,'member-one')]});
   expect(store.match(nn(ONE),nn(NS.rdf+'type'),null,dg)).toHaveLength(0);
   expect(store.match(nn(ONE),nn(EX+'entry'),null,dg)).toHaveLength(0);
   expect(store.match(nn(ONE),nn(NS.rdf+'type'),nn(EX+'DerivedOwner'),engine.graph)).toHaveLength(1);
   expect(count()).toBe(1);expect(engine.footprint().stale).toBe(0);expect(calls()).toBe(initial);
   change('member-one','still-valid');
   engine.refresh();expect(calls()).toBe(initial);expect(count()).toBe(1);
   // Recreate the valid input pair: hidden work parks, then registers on show.
   apply({add:[type(ONE),link(ONE,'member-one')]});
   expect(calls()).toBe(initial);expect(count()).toBe(1);expect(engine.hasDeferred).toBe(true);
   shown.add(ONE);engine.resume();
   expect(calls()).toBeGreaterThan(initial);expect(count()).toBe(2);
   const recreated=calls();shown.delete(ONE);
   apply({remove:[type(ONE),link(ONE,'member-one')]});
   expect(count()).toBe(1);expect(calls()).toBe(recreated);
   // The unrelated owner's registration is still live and receives its own edit.
   change('member-two','valid-again');engine.refresh();
   expect(calls()).toBeGreaterThan(recreated);expect(count()).toBe(1);
   const last=calls();shown.delete(TWO);
   const other=f.quad(nn(TWO),nn(NS.rdf+'type'),nn(EX+'Other'),dg);
   apply({add:[other]});const beforeRetire=calls();
   apply({remove:[type(TWO),link(TWO,'member-two')]});
   expect(store.match(nn(TWO),nn(NS.rdf+'type'),nn(EX+'Other'),dg)).toHaveLength(1);
   expect(count()).toBe(0);expect(calls()).toBe(beforeRetire);
   apply({remove:[other]});expect(calls()).toBe(beforeRetire);expect(beforeRetire).toBeGreaterThanOrEqual(last);
   const footprint=engine.footprint();
   expect(footprint.readsOf).toBe(0);expect(footprint.readers).toBe(0);
   expect(footprint.following).toBe(0);expect(footprint.stale).toBe(0);
   expect(footprint.memberReaders).toBe(0);expect(footprint.members).toBe(0);expect(footprint.deferred).toBe(0);
   expect(store.match(null,nn(EX+'unexpected'),null,engine.graph)).toHaveLength(0);
   expect(store.match(nn(ONE),nn(NS.rdf+'type'),nn(EX+'DerivedOwner'),engine.graph)).toHaveLength(1);
   expect(fnCalls).not.toContain(GHOST);
  }finally{engine.dispose();store.dispose?.();}
 });
}
