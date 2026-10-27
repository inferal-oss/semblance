import {initWeb,loadStore,DomRenderer} from '../../../src/web/index.ts';
import {Runtime,MOD,compileStyles,EventBus} from '../../../src/index.ts';
import {DEFAULT_LAYERS} from '../../../src/ns.ts';
import {HtmlIndex} from '../../../src/render/html-index.ts';
import {Parser} from 'n3';
const UI='https://example.org/csp#',C='https://semblance.dev/ns/component#',STY='https://semblance.dev/ns/style#',H='https://ia2.dev/spec/rdf-html#';
const violations=[];document.addEventListener('securitypolicyviolation',event=>{violations.push({directive:event.effectiveDirective,blocked:event.blockedURI});report();});
await initWeb('wat');
const ttl=`@prefix ui:<${UI}>.@prefix c:<${C}>.@prefix sty:<${STY}>.@prefix pos:<https://semblance.dev/ns/position#>.@prefix tok:<https://semblance.dev/ns/token#>.@prefix sem:<https://semblance.dev/ns/core#>.
ui:before a c:Stack;sty:theme sty:Semblance;sty:colorScheme sty:Light;pos:direction pos:Column;pos:gap tok:space-4;c:children(ui:p0 ui:chart0).
ui:after a c:Stack;sty:theme sty:Semblance;sty:colorScheme sty:Light;pos:direction pos:Column;pos:gap tok:space-4;c:children(ui:p1 ui:chart1).
ui:p0 a c:Progress;c:active true;c:label "75 percent";c:value 75;c:max 100.
ui:p1 a c:Progress;c:active true;c:label "75 percent";c:value 75;c:max 100.
ui:chart0 a c:LineChart;c:label "Requests";c:view ui:query;c:categoryVariable "x";c:seriesVariable "series";c:valueVariable "value".
ui:chart1 a c:LineChart;c:label "Requests";c:view ui:query;c:categoryVariable "x";c:seriesVariable "series";c:valueVariable "value".
ui:query a sem:View;sem:select "SELECT ?x ?value ?series WHERE { VALUES (?x ?value ?series) { (0 1 1) (1 4 1) (2 3 1) } }".`;
const store=loadStore('wat',ttl),runtime=new Runtime(store),projection=runtime.project({modality:MOD.Screen,layers:DEFAULT_LAYERS,prefer:'sparql',roots:[UI+'before',UI+'after']});
const sheet=new CSSStyleSheet();sheet.replaceSync(compileStyles(store));document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];
// Only the baseline comparison overrides the just-added shared style helper.
class AttributeRenderer extends DomRenderer {syncStyle(el,value){el.setAttribute('style',value);return 1;}}
const declarationIndex=new HtmlIndex();let declarationStyle='width:70px; --quoted: "a;b:c"; color: rgb(0,255,0) !important';
const declarationSource=value=>new Parser().parse(`@prefix h:<${H}>. @prefix sem:<https://semblance.dev/ns/core#>. <${UI}probe> a h:Div;sem:renders <${UI}declarations> .`+(value?`<${UI}probe> h:style ${JSON.stringify(value)} .`:''));
declarationIndex.apply({remove:[],add:declarationSource(declarationStyle)});
const declarationRenderer=new DomRenderer(declarationIndex,document.getElementById('declarationProbe'),UI+'declarations');declarationRenderer.flush();
const before=new AttributeRenderer(projection.index,document.getElementById('before'),UI+'before'),after=new DomRenderer(projection.index,document.getElementById('after'),UI+'after');
const flush=()=>{before.flush();after.flush();report();};
const bus=new EventBus(runtime,projection);bus.attach(before,flush);bus.attach(after,flush);
function set(subject,predicate,value,iri=false){const f=store.factory,s=f.namedNode(subject),p=f.namedNode(predicate);runtime.apply({remove:store.match(s,p,null,f.defaultGraph()),add:value===undefined?[]:[f.quad(s,p,iri?f.namedNode(value):f.literal(String(value)),f.defaultGraph())]});}
function report(){const rows=['before','after'].map(id=>{const root=document.getElementById(id),progress=root.querySelector('[data-sem-c="progress"]'),fill=progress?.querySelector('.sem-fill'),path=root.querySelector('path.sem-line');return{id,progress:progress?getComputedStyle(progress).getPropertyValue('--sem-progress'):null,fillWidth:fill?getComputedStyle(fill).width:null,stroke:path?getComputedStyle(path).stroke:null,style:progress?.getAttribute('style')}});document.getElementById('results').textContent=JSON.stringify({rows,declarations:readDeclaration(),violations},null,2);}
function readDeclaration(){const el=document.getElementById('declarationProbe').firstElementChild;return el?{width:getComputedStyle(el).width,quoted:el.style.getPropertyValue('--quoted'),priority:el.style.getPropertyPriority('color'),color:getComputedStyle(el).color,attribute:el.getAttribute('style')}:null;}
let declarationStep=0;document.getElementById('declarations').addEventListener('click',()=>{const next=declarationStep++%2===0?'width:30px; --quoted: "updated;v:w"; color:rgb(0,0,255)':'';declarationIndex.apply({remove:declarationSource(declarationStyle),add:declarationSource(next)});declarationStyle=next;declarationRenderer.flush();report();});
document.getElementById('theme').addEventListener('change',event=>{runtime.transaction(()=>{for(const name of ['before','after'])set(UI+name,STY+'theme',STY+event.target.value,true);});flush();});
document.getElementById('scheme').addEventListener('change',event=>{runtime.transaction(()=>{for(const name of ['before','after'])set(UI+name,STY+'colorScheme',STY+event.target.value,true);});flush();});
document.getElementById('direction').addEventListener('change',event=>{document.documentElement.dir=event.target.value;report();});
document.getElementById('update').addEventListener('click',()=>{runtime.transaction(()=>{set(UI+'p0',C+'value',25);set(UI+'p1',C+'value',25);set(UI+'p0',C+'label','25 percent');set(UI+'p1',C+'label','25 percent');});flush();});
document.getElementById('clear').addEventListener('click',()=>{
  const f=store.factory,g=projection.engine.graph;
  const remove=[...store.match(null,f.namedNode(H+'style'),null,g)];
  // Both RDF/HTML spellings reach the same DOM style: direct properties on
  // Progress, and explicit Attribute nodes on the SVG chart marks.
  for(const attribute of store.match(null,f.namedNode(H+'attributeName'),f.literal('style'),g)){
    remove.push(...store.match(null,f.namedNode(H+'attribute'),attribute.subject,g));
    remove.push(...store.match(attribute.subject,null,null,g));
  }
  projection.index.apply({remove,add:[]});flush();
});
flush();
