import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { contract, cyclicGroups, evaluateDeclaredLoads, parseImportGateArguments } from './check-import-initialization.mjs';

// Superseded B/e7 and its original62 verdicts remain immutable in the C legacy
// manifest. These are declared-loads-v2 tests, never a claimed B pass.
function truth(result) {
  assert.equal(result.contract, 'declared-loads-v2');
  assert.equal(result.causalInitializationProof, 'NOT_PERFORMED');
  assert.ok(!Object.hasOwn(result.counts, 'initializationCycleGroups'));
  assert.ok(!Object.hasOwn(result, 'initializationGraph'));
  for (const edge of result.fullInventory.edges) {
    assert.ok(!['deferred', 'deferred-safe', 'initialization-dynamic'].includes(edge.kind));
    assert.ok(!Object.hasOwn(edge, 'initializationOrigins'));
  }
  if (result.verdict === 'PASS') {
    assert.ok(Object.values(result.completeness).every(Boolean), JSON.stringify(result));
    assert.equal(result.declaredGraph.zeroCycleResult, 'PASS');
    assert.deepEqual(result.declaredGraph.cycles, []);
  }
}
const edges = (result) => result.fullInventory.edges;
const blocked = (result) => assert.equal(result.verdict, 'BLOCK', JSON.stringify(result));
const passed = (result) => assert.equal(result.verdict, 'PASS', JSON.stringify(result.problems));
// Whole-file scoped discriminator suite. Real Madge, installed TS emission and
// callable resolution; no app imports, install, network or runtime/Redis state.
async function fixture(files, verify, config = {}, evaluationOptions = {}) {
  const directory = fs.mkdtempSync(path.join(process.env.BATSHIT_IMPORT_TEST_ROOT ?? os.tmpdir(), 'import-contract-'));
  const previous = process.cwd();
  try {
    fs.mkdirSync(path.join(directory, 'src/lib'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
      include: ['src/**/*'], exclude: ['node_modules/**', '**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],
      compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', verbatimModuleSyntax: true, allowJs: true, paths: { '$lib/*': ['./src/lib/*'] }, ...config }
    }));
    for (const [name, source] of Object.entries(files)) {
      if (name.startsWith('src/') && /\.[cm]?[jt]s$/.test(name)) assert.equal(ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true).parseDiagnostics.length, 0, `Invalid discriminator syntax: ${name}`);
      fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
      fs.writeFileSync(path.join(directory, name), source);
    }
    process.chdir(directory);
    const result = await evaluateDeclaredLoads({ appRoot: directory, ...evaluationOptions });
    truth(result);
    await verify(result);
  } finally {
    process.chdir(previous);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}


test('report identity, full inventory and iterative SCC include self-edges', async () => {
  assert.equal(contract, 'declared-loads-v2');
  assert.deepEqual(cyclicGroups({a:['a'], b:['c'], c:['b']}), [['b','c'],['a']]);
  const chain=Object.fromEntries(Array.from({length:12000},(_,i)=>[String(i),i===11999?[]:[String(i+1)]]));
  assert.deepEqual(cyclicGroups(chain), []);
  await fixture({'src/a.ts':'export const value = 1;'}, (result) => {
    passed(result);assert.equal(result.fullInventory.complete,true);assert.equal(result.scope.analysisComplete,true);
    assert.equal(result.scope.workLimit,100000000);assert.equal(result.scope.fullWorkLimit,100000000);
    assert.ok(!Object.hasOwn(result.scope,'summaryMemo'));assert.ok(!Object.hasOwn(result.scope,'bindingWitness'));
  });
  await fixture({'src/a.ts':'void import("./a");'}, (result) => {blocked(result);assert.deepEqual(result.declaredGraph.cycles,[['src/a.ts']]);});
});

test('alias/reexport and generated value cycles remain declared zero-budget failures', async () => {
  for(const files of [
    {'src/lib/a.ts':'export {value} from "$lib/b";','src/lib/b.ts':'import "$lib/a"; export const value=1;'},
    {'src/a.ts':'import "./generated";','src/generated.ts':'export {value} from "./a";'}
  ]) await fixture(files, (result)=>{blocked(result);assert.equal(result.counts.declaredLoadCycleGroups,1);});
});

test('actual TS erasure differs from emitted empty, mixed and side-effect imports', async () => {
  await fixture({'src/a.ts':'import type {T} from "./types"; export const value=1;','src/types.d.ts':'import type {value} from "./a"; export type T=typeof value;'}, (result)=>{passed(result);assert.ok(edges(result).filter((edge)=>edge.kind==='erased').length>=2);assert.ok(result.fullInventory.cycles.length>0);});
  for(const source of ['import {type T} from "./b";','import {type T,value} from "./b";','import "./b";','export {value} from "./b";']) await fixture({'src/a.ts':source,'src/b.ts':'import "./a"; export const value=1; export type T=string;'},blocked);
});

for(const [name,source] of [
  ['unawaited module load','void import("./b");'],
  ['awaited module load','await import("./b"); export {};'],
  ['conditional module expression','if (false) void import("./b");'],
  ['class static field','class X { static value=import("./b"); }'],
  ['class static block','class X { static { void import("./b"); } }'],
  ['class computed method name','class X { [import("./b") as any]() {} }'],
  ['class computed instance name','class X { [import("./b") as any] = 1; }'],
  ['class heritage expression','class X extends (await import("./b")).Base {}'],
  ['direct function IIFE','(function(){ void import("./b"); })();'],
  ['direct arrow IIFE','(() => import("./b"))();'],
  ['direct async IIFE','void (async()=>{await import("./b");})();'],
  ['IIFE argument','((value)=>value)(import("./b"));'],
  ['IIFE default','((value=import("./b"))=>value)();'],
  ['IIFE binding default','(({value=import("./b")}={})=>value)();'],
  ['IIFE nested class definition','(()=>{class X {static value=import("./b");}})();'],
  ['direct function constructor','new (function(value=import("./b")){void value;})();'],
  ['direct class constructor','new (class {constructor(value=import("./b")){void value;}})();'],
  ['direct class own instance field','new (class {field=import("./b");})();'],
  ['direct class own body','new (class {constructor(){void import("./b");}})();']
]) test(`declared syntax includes ${name}`, async()=>{
  await fixture({'src/a.ts':source,'src/b.ts':'import "./a"; export class Base {}'},(result)=>{blocked(result);assert.ok(edges(result).some((edge)=>edge.kind==='declared-dynamic-load'&&edge.to==='src/b.ts'));});
});

for(const [name,source] of [
  ['named call','function run(){return import("./b");} run();'],
  ['aliased call','const run=()=>import("./b"); const alias=run; alias();'],
  ['ordinary class constructor','class X {constructor(){void import("./b");}} new X();'],
  ['ordinary instance field','class X {field=import("./b");} new X();'],
  ['ordinary getter','const box={get value(){return import("./b");}}; box.value;'],
  ['direct IIFE callback argument','((callback)=>callback())(()=>import("./b"));'],
  ['direct IIFE function-valued default','((callback=()=>import("./b"))=>callback())();'],
  ['direct literal class ordinary method','new (class {run(){return import("./b");} constructor(){this.run();}})();'],
  ['named inherited constructor','class Parent {constructor(){void import("./b");}} new (class extends Parent {})();'],
  ['class inside ordinary body','function later(){class X {static value=import("./b");}} later();']
]) test(`timing remains unproved for ${name}`,async()=>{
  await fixture({'src/a.ts':source,'src/b.ts':'import "./a";'},(result)=>{passed(result);const edge=edges(result).find((edge)=>edge.to==='src/b.ts'&&edge.kind==='dynamic-timing-unproved');assert.ok(edge);assert.ok(edge.lexicalOwner);assert.ok(result.fullInventory.cycles.length>0);});
});

test('direct literal syntax never traverses ordinary method bodies and rejects unsupported shapes',async()=>{
  for(const source of ['(function*(){yield import("./b");})();','namespace Runtime { export const value=import("./b"); }','new (()=>import("./b"))();','(function(){return import("./b");})`value`;']) await fixture({'src/a.ts':source,'src/b.ts':'import "./a";'},(result)=>{blocked(result);assert.ok(result.problems.some((problem)=>/Unsupported declared-load syntax/.test(problem.reason)));assert.equal(result.declaredGraph.zeroCycleResult,'NOT_PROVEN');});
});

test('CommonJS and finite createRequire edges are declared even in ordinary bodies',async()=>{
  for(const [filename,source] of [
    ['src/a.cjs','function later(){require("./b");}'],
    ['src/a.cjs','const load=require; function later(){load("./b");}'],
    ['src/a.cjs','class X {field=require("./b");}'],
    ['src/a.cjs','function later(){module.require("./b");}'],
    ['src/a.ts','import {createRequire as make} from "node:module"; const req=make(import.meta.url); export function later(){req("./b");}'],
    ['src/a.ts','import * as modules from "node:module"; const req=modules.createRequire(import.meta.url); const load=req; function later(){load("./b");}']
  ]) await fixture({[filename]:source,'src/b.ts':`import "./${filename.endsWith('.cjs')?'a.cjs':'a'}";`},(result)=>{blocked(result);assert.ok(edges(result).some((edge)=>edge.kind==='declared-commonjs-load'&&edge.to==='src/b.ts'));});
  await fixture({'src/a.ts':'function require(value:string){return value;} require("./missing");'},passed);
  await fixture({'src/a.cjs':'const module={require(value){return value;}}; module.require("./missing");'},passed);
});

test('unknown targets, loader origins and loader capability escapes remain failures',async()=>{
  for(const [filename,source] of [
    ['src/a.ts','export function later(target:string){return import(target);}'],
    ['src/a.ts','void import("./missing");'],
    ['src/a.ts','import {createRequire} from "node:module"; const req=createRequire(location.href); req("./b");'],
    ['src/a.ts','import {createRequire} from "node:module"; const req=createRequire(import.meta.url); function hide(){return req;} const load=hide(); load("./b");'],
    ['src/a.ts','import {createRequire} from "node:module"; const req=createRequire(import.meta.url); function hide(value:any){return value;} hide(req);'],
    ['src/a.ts','import * as modules from "node:module"; const {createRequire:make}=modules; make(import.meta.url)("./b");'],
    ['src/a.cjs','function hide(value){value.require("./b");} hide(module);'],
    ['src/a.ts','require("./b");'],
    ['src/a.ts','void import("./b", {with:{type:"json"}});']
  ]) await fixture({[filename]:source,'src/b.ts':'export {};'},blocked);
});

test('loader/codegen exports cannot escape while erased namespace types remain supported',async()=>{
  await fixture({'src/a.ts':'export {type Module} from "node:module"; export type {Script} from "node:vm";'},passed);
  for(const source of ['export {createRequire} from "node:module";','import {createRequire} from "node:module"; export const req=createRequire(import.meta.url);','import {createRequire} from "node:module"; const req=createRequire(import.meta.url); const registry={load:req};']) await fixture({'src/a.ts':source},blocked);
  await fixture({'src/a.cjs':'module.require = function(){return 1;}; module.require("./b");','src/b.ts':'export {};'},blocked);
});

test('sensitive dynamic namespaces cannot hide loader or code-generation consumption',async()=>{
  for(const source of [
    'const {createRequire}=await import("node:module"); const req=createRequire(import.meta.url); req("./b");',
    'const modules=await import("module"); const make=modules.createRequire; make(import.meta.url)("./b");',
    'import("node:vm").then(({runInThisContext})=>runInThisContext("import(\\"./b\\")"));',
    'const {runInNewContext}=await import("vm"); runInNewContext("import(\\"./b\\")");',
    'const target=Math.random()?"node:module":"node:vm"; const namespace=await import(target);',
    'const {default:process}=await import("node:process"); process.getBuiltinModule("module").createRequire(import.meta.url)("./b");',
    'void import("process");'
  ]) await fixture({'src/a.ts':source,'src/b.ts':'export {};'},(result)=>{
    blocked(result);assert.ok(result.problems.some((problem)=>/Unsupported dynamic loader\/code-generation namespace/.test(problem.reason)));
    assert.ok(edges(result).some((edge)=>['module','node:module','vm','node:vm','process','node:process'].includes(edge.specifier)));
  });
});

test('qualified require.resolve results and inert process reads are data without hiding capability escapes',async()=>{
  const packages={'node_modules/outside/package.json':JSON.stringify({name:'outside',version:'fixture',exports:'./index.js'}),'node_modules/outside/index.js':'export const value=1;'};
  await fixture({...packages,'src/a.ts':'import {createRequire} from "node:module"; import path from "node:path"; const req=createRequire(import.meta.url); const resolved=req.resolve("outside"); path.dirname(resolved); path.dirname(req["resolve"]("outside"));'},passed);
  await fixture({'src/a.ts':'if(typeof process!=="undefined") {const currentProcess=(process as any)!; const value=(currentProcess as any).env?.NODE_ENV;} const value=(process as any).getuid;'},passed);
  for(const source of [
    'import {createRequire} from "node:module"; const req=createRequire(import.meta.url); sink(req.resolve);',
    'import {createRequire} from "node:module"; const req=createRequire(import.meta.url); req.resolve=(()=>"outside") as any;',
    'sink((process as any)!);',
    'const value=(process as any).getBuiltinModule; sink(value);'
  ]) await fixture({'src/a.ts':source},blocked);
});

test('finite const, conditional and unredirected Buffer targets retain exact requests',async()=>{
  const packages={'node_modules/outside/package.json':JSON.stringify({name:'outside',version:'fixture',exports:'./index.js'}),'node_modules/outside/index.js':'export const value=1;'};
  await fixture({...packages,'src/a.ts':'const part="./"; const name=Math.random()?"b":"c"; export function later(){return import(part+name);} const encoded="b3V0c2lkZQ=="; const target=Buffer.from(encoded,"base64").toString("utf8"); export function load(){return import(target);}','src/b.ts':'export {};','src/c.ts':'export {};'},(result)=>{passed(result);assert.ok(edges(result).some((edge)=>edge.specifier==='outside'&&edge.kind==='dynamic-timing-unproved'));assert.equal(edges(result).filter((edge)=>['./b','./c'].includes(edge.specifier)).length,2);});
  for(const prefix of [
    'const Buffer={from(){return {toString(){return "outside";}}}};',
    '(globalThis as any).Buffer={};',
    'Object.defineProperty(globalThis,"Buffer",{value:{}});',
    'Object.assign(globalThis,{Buffer:{}});',
    'const globals=globalThis; const define=Object.defineProperty; define(globals,"Buffer",{value:{}});',
    'Buffer.from=(()=>({toString(){return "outside";}})) as any;'
  ]) await fixture({...packages,'src/a.ts':prefix+' const target=Buffer.from("b3V0c2lkZQ==","base64").toString("utf8"); export function later(){return import(target);}'},blocked);
});

const symbolRegistryPackages={'node_modules/outside/package.json':JSON.stringify({name:'outside',version:'fixture',exports:'./index.js'}),'node_modules/outside/index.js':'export const value=1;'};
const foldedSymbolTarget='const target=Buffer.from("b3V0c2lkZQ==","base64").toString("utf8"); export function later(){return import(target);}';
const symbolRegistryRead='const key=Symbol.for("registry"); const current=Reflect.get(globalThis,key); Reflect.set(globalThis,key,current??{});';
test('verified Symbol registry reads/writes preserve folded requests without causal claims',async()=>{
  for (const source of [
    symbolRegistryRead,
    'const symbols=Symbol; const make=symbols["for"]; const key=make("registry"); const alias=key; const reflection=Reflect; const get=reflection.get; const set=reflection["set"]; const globals=globalThis; const current=get((globals as any)!,alias); set(globals,alias,current??{});',
    'const key=globalThis.Symbol.for("registry"); globalThis.Reflect.set(globalThis,key,globalThis.Reflect.get(globalThis,key)??{});',
    ...['eval','Function','Buffer','process'].map((key)=>`const key=Symbol.for(${JSON.stringify(key)}); const current=Reflect.get(globalThis,key); Reflect.set(globalThis,key,current??{});`)
  ]) await fixture({...symbolRegistryPackages,'src/a.ts':source+foldedSymbolTarget},(result)=>{
    passed(result);assert.ok(edges(result).some((edge)=>edge.specifier==='outside'&&edge.kind==='dynamic-timing-unproved'));
    assert.equal(result.causalInitializationProof,'NOT_PERFORMED');assert.ok(result.limitations.some((text)=>text.includes('getters')));
  });
});

test('diagnostic-only native identity damage does not poison the possible runtime closure',async()=>{
  await fixture({...symbolRegistryPackages,'src/a.ts':symbolRegistryRead+foldedSymbolTarget,'src/damage.test.ts':'Symbol.for=(()=>"eval") as any;'},passed);
  await fixture({...symbolRegistryPackages,'src/a.ts':symbolRegistryRead+foldedSymbolTarget+' export function loadDamage(){return import("./damage.test");}','src/damage.test.ts':'Symbol.for=(()=>"eval") as any;'},blocked);
});

test('native identity damage reports bounded runtime source witnesses without changing refusal policy',async()=>{
  await fixture({'src/a.ts':'const globals=globalThis;\nsink(globals);\n'+symbolRegistryRead,'src/damage.test.ts':'sink(Reflect);'},(result)=>{
    blocked(result);const integrity=result.nativeIdentityIntegrity;
    assert.equal(integrity.complete,true);assert.equal(integrity.runtimeDamageCount,1);assert.equal(integrity.diagnosticDamageCount,1);
    assert.equal(integrity.omittedRuntimeDamageWitnesses,0);
    assert.deepEqual(integrity.runtimeDamageWitnesses,[{identity:'global',nativeUseReason:'native identity passed to an unqualified call argument',file:'src/a.ts',line:2,column:6,coordinateSpace:'source',context:'sink(globals)'}]);
    assert.doesNotThrow(()=>JSON.stringify(result));assert.ok(!JSON.stringify(integrity).includes('"node"'));
  });
  await fixture({'src/a.ts':Array.from({length:70},()=> 'sink(globalThis);').join('\n')+'\n'+symbolRegistryRead},(result)=>{
    blocked(result);const integrity=result.nativeIdentityIntegrity;
    assert.equal(integrity.runtimeDamageCount,70);assert.equal(integrity.runtimeDamageWitnesses.length,64);assert.equal(integrity.witnessLimit,64);assert.equal(integrity.omittedRuntimeDamageWitnesses,6);
    assert.ok(integrity.runtimeDamageWitnesses.every((witness)=>witness.context.length<=240));
  });
});

test('direct immutable global Symbol keys retain distinct read/write/delete and late damage proofs',async()=>{
  for (const source of [
    'const key=Symbol.for("registry"); const globals=globalThis; const current=globals[key]; globals[key]=current??{}; delete globals[key];',
    'const key=Symbol.for("Buffer"); const alias=key; const globals=globalThis; globals[alias]??={}; void globals[alias];',
    'const key="ordinary"; const globals=globalThis; globals[key]={}; delete globals[key];'
  ]) await fixture({...symbolRegistryPackages,'src/a.ts':source+foldedSymbolTarget},passed);
  for (const damage of ['Symbol.for=(()=>"eval") as any;','sink(globalThis);','const name=unknownName(); (globalThis as any)[name]={};']) {
    await fixture({'src/a.ts':'const key=Symbol.for("registry"); const globals=globalThis; void globals[key]; globals[key]={}; delete globals[key];'+damage},(result)=>{
      blocked(result);assert.ok(result.problems.some((problem)=>/native identity mutation\/escape/.test(problem.reason)));
    });
  }
  await fixture({...symbolRegistryPackages,'src/a.ts':'const key="Buffer"; (globalThis as any)[key]={};'+foldedSymbolTarget},blocked);
  for (const source of [
    'const key="eval"; const execute=(globalThis as any)[key]; execute(\'import("./b")\');',
    'const key=unknownKey(); const execute=(globalThis as any)[key]; execute(\'import("./b")\');',
    'const field="globalThis"; const globals=(globalThis as any)[field]; const key=unknownKey(); const execute=globals[key]; execute(\'import("./b")\');'
  ]) await fixture({'src/a.ts':source,'src/b.ts':'export {};'},blocked);
});

test('exact native Object Symbol descriptors retain target identity and inspect descriptor data',async()=>{
  for (const source of [
    'const key=Symbol.for("registry"); const prior=Object.getOwnPropertyDescriptor(globalThis,key); if(!prior) Object.defineProperty(globalThis,key,{value:{ready:true},writable:false,configurable:false});',
    'const object=Object; const get=object.getOwnPropertyDescriptor; const define=object["defineProperty"]; const globals=globalThis; const key=Symbol.for("registry"); const alias=key; const value={}; const descriptor={value,writable:false}; const prior=get(globals,alias); const definedGlobal=define(globals,alias,descriptor); void definedGlobal[alias];',
    'const key=Symbol.for("registry"); void Object.defineProperty(globalThis,key,{get:()=>1,set:(value)=>void value,enumerable:false});',
    'const key=Symbol.for("registry"); Object.defineProperty(globalThis,key,{value:{}}); Reflect.get(globalThis,key);',
    'const name="Object"; const object=globalThis[name]; const method="defineProperty"; const define=object[method]; const key=Symbol.for("registry"); define(globalThis,key,{value:{}});'
  ]) await fixture({...symbolRegistryPackages,'src/a.ts':source+foldedSymbolTarget},passed);
  // An Object-only mutation is irrelevant to a direct Symbol-key operation.
  await fixture({'src/a.ts':'const key=Symbol.for("registry"); void (globalThis as any)[key]; sink(Object);'},passed);
});

test('Object descriptor identities and returned global namespace cannot escape finite proofs',async()=>{
  for (const damage of [
    'Object.defineProperty=(()=>globalThis) as any;',
    'Object.getOwnPropertyDescriptor=(()=>({value:eval})) as any;',
    'const object=Object; object.defineProperty=(()=>globalThis) as any;',
    'const define=Object.defineProperty; sink(define);',
    'sink(Object);',
    '(globalThis as any).Object={};',
    'Object.defineProperty.prototype={};',
    'Object.prototype.constructor={};',
    '(Object as any).__defineGetter__("defineProperty",()=>()=>{});',
    'const member="__define"+"Setter__"; (Object as any)[member]("getOwnPropertyDescriptor",()=>{});'
  ]) await fixture({'src/a.ts':'const key=Symbol.for("registry"); Object.getOwnPropertyDescriptor(globalThis,key); Object.defineProperty(globalThis,key,{value:{}});'+damage},(result)=>{
    blocked(result);assert.ok(result.problems.some((problem)=>/native identity mutation\/escape/.test(problem.reason)));
  });
  for (const consume of ['sink(target);','export {target};','function escape(){return target;}']) {
    await fixture({'src/a.ts':'const key=Symbol.for("registry"); const target=Object.defineProperty(globalThis,key,{value:{}});'+consume},(result)=>{
      blocked(result);assert.ok(result.nativeIdentityIntegrity.runtimeDamageWitnesses.some((witness)=>witness.identity==='global'));
    });
  }
});

test('unsupported Object descriptor keys/forms and nested namespace or loader values remain blocking',async()=>{
  for (const source of [
    'const key="Buffer"; Object.defineProperty(globalThis,key,{value:{}});',
    'const key=unknownKey(); Object.getOwnPropertyDescriptor(globalThis,key);',
    'const key=Symbol.for("registry"); Object.getOwnPropertyDescriptor(globalThis,key,globalThis);',
    'const key=Symbol.for("registry"); Object.defineProperty(globalThis,key,{value:{}},globalThis);',
    'const key=Symbol.for("registry"); Object.defineProperty.call(null,globalThis,key,{value:{}});',
    'const key=Symbol.for("registry"); Object.defineProperty(globalThis,...[key,{value:{}}]);',
    'const Object={defineProperty(){}}; const key=Symbol.for("registry"); Object.defineProperty(globalThis,key,{value:{}});',
    'const key=Symbol.for("registry"); Object.defineProperty(globalThis,key,unknownDescriptor());',
    'const key=Symbol.for("registry"); Object.defineProperty(globalThis,key,{...unknownDescriptor()});',
    'const key=Symbol.for("registry"); Object.defineProperty(globalThis,key,{get value(){return {};}});',
    'const key=Symbol.for("registry"); Object.defineProperty(globalThis,key,{__proto__:{value:{}}});',
    'const key=Symbol.for("registry"); Object.defineProperty(globalThis,key,{value:eval});',
    'import {createRequire} from "node:module"; const req=createRequire(import.meta.url); const key=Symbol.for("registry"); Object.defineProperty(globalThis,key,{value:{nested:req}});',
    'const key=Symbol.for("registry"); Object.defineProperty(globalThis,key,{value:{nested:globalThis}});',
    'const key=Symbol.for("registry"); const payload={nested:[Buffer]}; const descriptor={value:payload}; Object.defineProperty(globalThis,key,descriptor);'
  ]) await fixture({...symbolRegistryPackages,'src/a.ts':source+foldedSymbolTarget},blocked);
});

test('descriptor shorthand resolves global and native value bindings without a folded target',async()=>{
  for (const source of [
    'const payload={globalThis};',
    'const globals=globalThis; const payload={globals};',
    'const nativeAlias=Object; const payload={nativeAlias};',
    'const nativeAlias=Reflect; const payload={nativeAlias};',
    'const nativeAlias=Symbol; const payload={nativeAlias};'
  ]) await fixture({'src/a.ts':'const key=Symbol.for("registry"); '+source+' Object.defineProperty(globalThis,key,{value:payload}); Reflect.get(globalThis,key);'},(result)=>{
    blocked(result);assert.ok(result.problems.some((problem)=>/native identity mutation\/escape/.test(problem.reason)));
    assert.ok(result.nativeIdentityIntegrity.runtimeDamageWitnesses.some((witness)=>['globalThis','globals','nativeAlias'].includes(witness.context)));
  });
});

test('descriptor shorthand cannot hide loader/codegen values or folded Buffer namespace escape',async()=>{
  for (const source of [
    'const payload={eval};',
    'const execute=eval; const payload={execute};',
    'import {createRequire} from "node:module"; const req=createRequire(import.meta.url); const payload={req};',
    'import {createRequire} from "node:module"; const req=createRequire(import.meta.url); const load=req; const payload={load};'
  ]) await fixture({'src/a.ts':'const key=Symbol.for("registry"); '+source+' Object.defineProperty(globalThis,key,{value:payload});'},(result)=>{
    blocked(result);assert.ok(result.problems.some((problem)=>/loader\/code-generation capability escape/.test(problem.reason)));
  });
  for (const source of ['const payload={Buffer};','const bytes=Buffer; const payload={bytes};']) {
    await fixture({...symbolRegistryPackages,'src/a.ts':'const key=Symbol.for("registry"); '+source+' Object.defineProperty(globalThis,key,{value:payload});'+foldedSymbolTarget},(result)=>{
      blocked(result);assert.ok(result.problems.some((problem)=>/Node Buffer is redirected\/escaped/.test(problem.reason)));
    });
  }
});

for (const [name,damage] of [
  ['Symbol.for replacement','Symbol.for=(()=>"eval") as any;'],
  ['Symbol alias mutation','const symbols=Symbol; symbols.for=(()=>"Buffer") as any;'],
  ['Symbol method alias escape','const make=Symbol.for; sink(make);'],
  ['Symbol namespace escape','sink(Symbol);'],
  ['Symbol mutable alias','let symbols=Symbol;'],
  ['Reflect.get replacement','Reflect.get=(()=>eval) as any;'],
  ['Reflect.set replacement','Reflect.set=(()=>true) as any;'],
  ['Reflect alias mutation','const reflection=Reflect; reflection["get"]=(()=>eval) as any;'],
  ['Reflect method alias escape','const get=Reflect.get; sink(get);'],
  ['Reflect namespace escape','sink(Reflect);'],
  ['global Symbol replacement','(globalThis as any).Symbol={for:()=>"eval"};'],
  ['global Reflect replacement','(globalThis as any).Reflect={get:()=>eval};'],
  ['global namespace escape','const globals=globalThis; sink(globals);'],
  ['unknown global property mutation','const field=unknownKey(); (globalThis as any)[field]={};'],
  ['reflective Symbol mutation','Reflect.set(Symbol,"for",()=>"eval");'],
  ['native object mutation','Object.assign(Reflect,{get:()=>eval});'],
  ['native method property mutation','Reflect.get.prototype={};'],
  ['global legacy getter','(globalThis as any).__defineGetter__("Symbol",()=>({for:()=>"eval"}));'],
  ['global legacy setter','(globalThis as any)["__defineSetter__"]("Reflect",()=>{});'],
  ['Symbol legacy getter','(Symbol as any).__defineGetter__("for",()=>()=>"eval");'],
  ['Symbol legacy setter alias','const symbols=Symbol; (symbols as any)["__defineSetter__"]("for",()=>{});'],
  ['Reflect legacy getter alias','const reflection=Reflect; (reflection as any).__defineGetter__("get",()=>()=>{});'],
  ['Reflect legacy setter','(Reflect as any)["__defineSetter__"]("set",()=>{});'],
  ['native alias export','const reflection=Reflect; export {reflection};']
]) test(`Symbol registry identity damage remains blocking: ${name}`,async()=>{
  // Damage deliberately follows the proof site: no source-order safety guess.
  await fixture({...symbolRegistryPackages,'src/a.ts':symbolRegistryRead+damage+foldedSymbolTarget},(result)=>{
    blocked(result);assert.ok(result.problems.some((problem)=>/native identity mutation\/escape/.test(problem.reason)));
    assert.ok(result.problems.some((problem)=>/Node Buffer is redirected\/escaped/.test(problem.reason)));
  });
});

test('legacy accessor mutators cannot disguise String eval as a Symbol registry key',async()=>{
  for (const redirect of [
    '(globalThis as any).__defineGetter__("Symbol",()=>({for:()=>"eval"}));',
    'const globals=globalThis; (globals as any)["__defineGetter__"]("Symbol",()=>({for:()=>"eval"}));',
    'const globals=globalThis; const redirect=(globals as any).__defineGetter__; redirect.call(globals,"Symbol",()=>({for:()=>"eval"}));',
    '(Symbol as any)["__defineGetter__"]("for",()=>()=>"eval");',
    'const symbols=Symbol; const redirect=(symbols as any)["__defineGetter__"]; redirect.call(symbols,"for",()=>()=>"eval");',
    '(Reflect as any).__defineGetter__("get",()=>()=>{});',
    'const reflection=Reflect; const redirect=(reflection as any)["__defineSetter__"]; redirect.call(reflection,"get",()=>{});'
  ]) await fixture({'src/a.ts':redirect+' const key=Symbol.for("x"); const execute=Reflect.get(globalThis,key); execute(\'import("./b")\');','src/b.ts':'export {};'},(result)=>{
    blocked(result);assert.ok(result.problems.some((problem)=>/native identity mutation\/escape/.test(problem.reason)));
  });
});

test('finite and unknown computed native members cannot hide legacy identity mutation',async()=>{
  for (const redirect of [
    'const member="__defineGetter__"; (globalThis as any)[member]("Symbol",()=>({for:()=>"eval"}));',
    'const name="__defineGetter__"; const member=name; const globals=globalThis; (globals as any)[member]("Symbol",()=>({for:()=>"eval"}));',
    'const prefix="__define"; const member=prefix+"Getter__"; (Symbol as any)[member]("for",()=>()=>"eval");',
    'const member=Math.random()?"__defineGetter__":"toString"; (Reflect as any)[member]("get",()=>()=>{});',
    'const member=unknownName(); (globalThis as any)[member]("Symbol",()=>({for:()=>"eval"}));',
    'const member=unknownName(); const reflection=Reflect; const redirect=(reflection as any)[member]; redirect("get",()=>()=>{});'
  ]) await fixture({'src/a.ts':redirect+' const key=Symbol.for("x"); const execute=Reflect.get(globalThis,key); execute(\'import("./b")\');','src/b.ts':'export {};'},(result)=>{
    blocked(result);assert.ok(result.problems.some((problem)=>/native identity mutation\/escape/.test(problem.reason)));
  });
});

test('only exact native Reflect arity and immutable Symbol.for literal keys qualify',async()=>{
  for (const source of [
    'const key="eval"; Reflect.get(globalThis,key);',
    'const key="Buffer"; Reflect.set(globalThis,key,{});',
    'const key=unknownKey(); Reflect.get(globalThis,key);',
    'let key=Symbol.for("registry"); Reflect.get(globalThis,key);',
    'const key=Symbol.for(unknownKey()); Reflect.get(globalThis,key);',
    'const Symbol={for:()=>"eval"}; const key=Symbol.for("registry"); Reflect.get(globalThis,key);',
    'const Reflect={get:()=>eval}; const key=Symbol.for("registry"); Reflect.get(globalThis,key);',
    'const key=Symbol.for("registry"); Reflect.get(globalThis,key,globalThis);',
    'const key=Symbol.for("registry"); Reflect.set(globalThis,key,{},globalThis);',
    'const key=Symbol.for("registry"); Reflect.get.call(null,globalThis,key);',
    'const key=Symbol.for("registry"); Reflect.set.apply(null,[globalThis,key,{}]);',
    'const key=Symbol.for("registry"); Reflect.get(globalThis,...[key]);'
  ]) await fixture({...symbolRegistryPackages,'src/a.ts':source+foldedSymbolTarget},blocked);
});

test('Symbol registry target exemption does not exempt loader/key/value capabilities or Buffer writes',async()=>{
  for (const source of [
    'const key=Symbol.for("registry"); Reflect.set(globalThis,key,eval);',
    'const key=Symbol.for("registry"); Reflect.set(globalThis,key,process);',
    'import {createRequire} from "node:module"; const req=createRequire(import.meta.url); const key=Symbol.for("registry"); Reflect.set(globalThis,key,req);',
    'const key=Symbol.for("registry"); Reflect.set(globalThis,key,globalThis);',
    'const key=Symbol.for("registry"); Reflect.set(globalThis,key,Buffer);',
    'const key=Symbol.for("registry"); Reflect.get(globalThis,(sink(eval),key));',
    symbolRegistryRead+' (globalThis as any).Buffer={};'
  ]) await fixture({...symbolRegistryPackages,'src/a.ts':source+foldedSymbolTarget},blocked);
});

test('JS/VM/module code-generation ownership is separate from ordinary eval methods',async()=>{
  await fixture({'src/a.ts':'const redis={eval(value:string){return value;}}; redis.eval("return 1");'},passed);
  await fixture({'src/a.ts':'import {Script} from "node:vm"; new Script("import(\\"./b\\")");','src/b.ts':'export {};'},passed);
  for(const source of [
    'const execute=eval; execute("import(\\"./b\\")");',
    'globalThis.eval("import(\\"./b\\")");',
    'const pick=Reflect.get; const execute=pick(globalThis,"eval"); execute("import(\\"./b\\")");',
    'const registry={execute:eval}; registry.execute("import(\\"./b\\")");',
    'import {runInThisContext as execute} from "node:vm"; execute("import(\\"./b\\")");',
    'import {Script} from "node:vm"; const script=new Script("import(\\"./b\\")"); script.runInThisContext();',
    'import * as modules from "node:module"; modules.register("./b");',
    'const get=process.getBuiltinModule; get("module").createRequire(import.meta.url)("./b");'
  ]) await fixture({'src/a.ts':source,'src/b.ts':'export {};'},blocked);
});

test('installed package runtime exports, assets and declaration-only boundaries remain explicit',async()=>{
  const files={'node_modules/outside/package.json':JSON.stringify({name:'outside',version:'fixture',exports:{'.':{types:'./index.d.ts',import:'./index.mjs'},'./types':{types:'./index.d.ts'}}}),'node_modules/outside/index.d.ts':'export type T=string;','node_modules/outside/index.mjs':'export const value=1;','src/data.txt':'asset'};
  await fixture({...files,'src/a.ts':'import "outside"; import type {T} from "outside/types"; import text from "./data.txt?raw";'},(result)=>{passed(result);assert.ok(edges(result).some((edge)=>edge.resolution.owner==='outside@fixture'));assert.ok(edges(result).some((edge)=>edge.resolution.kind==='asset'));});
  await fixture({...files,'src/a.ts':'import "outside/types";'},blocked);
  await fixture({'src/a.ts':'import "./missing.txt?raw";'},blocked);
  await fixture({'node_modules/outside/package.json':JSON.stringify({name:'outside',version:'fixture',main:'./index.d.ts'}),'node_modules/outside/index.d.ts':'export type T=string;','src/a.ts':'import "outside";'},blocked);
  await fixture({'src/a.ts':'import "$service-worker";'},blocked);
});

const sveltePackages={
  'node_modules/svelte/package.json':JSON.stringify({name:'svelte',version:'fixture',exports:{'./internal/*':'./internal/*.js'}}),
  'node_modules/svelte/internal/disclose-version.js':'export {};','node_modules/svelte/internal/flags/legacy.js':'export {};','node_modules/svelte/internal/client.js':'export {};'
};
test('actual Svelte client emission and source erasure retain their distinct coordinates',async()=>{
  await fixture({...sveltePackages,'src/a.ts':'import Component from "./Component.svelte"; export {Component};','src/Component.svelte':'<script>void import("./a");</script>'},(result)=>{passed(result);assert.ok(edges(result).some((edge)=>edge.kind==='dynamic-timing-unproved'&&edge.coordinateSpace==='Svelte client compiler output'));});
  await fixture({...sveltePackages,'src/a.ts':'import "./Component.svelte";','src/Component.svelte':'<script module>void import("./a");</script>'},blocked);
  await fixture({...sveltePackages,'src/a.ts':'import "./Component.svelte"; export type T=string;','src/Component.svelte':'<script lang="ts">import type {T} from "./a"; let value:T;</script>'},(result)=>{passed(result);assert.ok(edges(result).some((edge)=>edge.kind==='erased'&&edge.coordinateSpace==='source'));});
});

test('rune modules use installed Oxc then Svelte emission without universal callback proof',async()=>{
  await fixture({...sveltePackages,'src/a.ts':'import "./state.svelte";','src/state.svelte.ts':'let value:number=$state(1); export function request(){return import("./a");}'},(result)=>{passed(result);assert.ok(edges(result).some((edge)=>edge.coordinateSpace==='Vite Oxc → Svelte compileModule client output'&&edge.kind==='dynamic-timing-unproved'));});
  await fixture({...sveltePackages,'src/a.ts':'import "./state.svelte";','src/state.svelte.ts':'let value:number=$state(1); void import("./a");'},blocked);
});

test('all-source diagnostic ownership and every possible value edge promote test helpers',async()=>{
  const files={'vitest.config.ts':'import {defineConfig} from "vitest/config"; export default defineConfig({test:{include:["src/**/*.test.ts"],setupFiles:["src/lib/test-utils/setup.ts"]}});','src/entry.ts':'export {};','src/lib/test-utils/setup.ts':'void import("../../b.test");','src/b.test.ts':'import "./lib/test-utils/setup";'};
  await fixture(files,(result)=>{passed(result);assert.ok(result.fullInventory.madge.graph['src/b.test.ts']);assert.ok(edges(result).some((edge)=>edge.moduleRole.startsWith('diagnostic-only')&&edge.kind==='declared-dynamic-load'));assert.equal(result.scope.runtimeFiles.length,1);});
  await fixture({...files,'src/entry.ts':'export function later(){return import("./lib/test-utils/setup");}'},(result)=>{blocked(result);assert.ok(result.scope.runtimeFiles.includes('src/b.test.ts'));assert.equal(result.scope.runtimeFiles.length,3);});
  await fixture({...files,'src/entry.ts':'export function later(){return import("./lib/test-utils/setup");}','src/lib/test-utils/setup.ts':'export function run(target:string){return import(target);}'},(result)=>{blocked(result);assert.ok(result.problems.some((problem)=>problem.disposition==='blocking'&&/module-loader target/.test(problem.reason)));});
});

test('unsupported config/emission/discovery cannot certify a subset',async()=>{
  for(const files of [
    {'src/a.ts':'export {};','vitest.config.ts':'import {defineConfig} from "vitest/config"; export default defineConfig({test:{include:getPatterns()}});'},
    {'src/a.ts':'export {};','build-scripts/sveltekit-options.mjs':'import {vitePreprocess} from "@sveltejs/vite-plugin-svelte"; export default {preprocess:vitePreprocess({script:true})};'},
    {'src/a.ts':'export {};','vite.config.ts':'import {defineConfig} from "vite"; export default defineConfig({oxc:{typescript:{onlyRemoveTypeImports:false}}});'},
    {'src/a.ts':'export {};','src/view.tsx':'export const value=<div/>;'}
  ]) await fixture(files,(result)=>{blocked(result);assert.equal(result.completeness.inputsQualified,false);});
});

test('empty discovery, unsupported emission and wrong cwd cannot become structural success',async()=>{
  await assert.rejects(fixture({},()=>assert.fail('Empty discovery must reject')),/no (?:inputs|files)/i);
  await assert.rejects(fixture({'src/a.ts':'export {};'},()=>assert.fail('Unsupported emission must reject'),{verbatimModuleSyntax:false}),/verbatimModuleSyntax/);
  await fixture({'src/a.ts':'export {};'},async()=>{
    const own=process.cwd();
    try { process.chdir(path.dirname(own)); await assert.rejects(evaluateDeclaredLoads({appRoot:own}),/actual app directory/); }
    finally { process.chdir(own); }
  });
});

test('qualified Kit wrappers retain config-to-entry edges, not a claimed validator invocation',async()=>{
  const require=createRequire(import.meta.url), directory=path.dirname(require.resolve('@sveltejs/kit/package.json'));
  const packages={'node_modules/@sveltejs/kit/package.json':fs.readFileSync(path.join(directory,'package.json'),'utf8'),'node_modules/esm-env/package.json':JSON.stringify({name:'esm-env',version:'fixture',exports:'./index.js'}),'node_modules/esm-env/index.js':'export const DEV=false;'};
  for(const name of ['src/exports/vite/index.js','src/core/env.js','src/utils/filesystem.js','src/core/config/options.js','src/runtime/env/static/private.js','src/runtime/app/env/private/index.js','src/runtime/app/env/public/index.js','src/runtime/app/env/public/server.js','src/runtime/app/env/public/client.js','src/messages/shared-warnings.js']) packages[`node_modules/@sveltejs/kit/${name}`]=fs.readFileSync(path.join(directory,name),'utf8');
  await fixture({...packages,'src/a.ts':'import "$env/static/private";','src/env/index.ts':'export const variables={X:{schema:{"~standard":{validate(){return import("../a");}}}}};'},(result)=>{passed(result);assert.ok(edges(result).some((edge)=>edge.from==='src/a.ts'&&edge.to==='src/env/index.ts'));assert.ok(edges(result).some((edge)=>edge.from==='src/env/index.ts'&&edge.kind==='dynamic-timing-unproved'));});
  await fixture({...packages,'src/a.ts':'import "$app/env/public";','src/env/index.ts':'import "../a"; export const variables={};'},blocked);
});

test('prior event writer and B-to-B callback cycle is explicitly outside causal proof',async()=>{
  await fixture({
    'src/store.ts':'export const box={start:()=>undefined};',
    'src/a.ts':'import {box} from "./store"; window.addEventListener("later",()=>{box.start=()=>import("./b");});',
    'src/b.ts':'import {box} from "./store"; box.start();'
  },(result)=>{passed(result);assert.equal(result.causalInitializationProof,'NOT_PERFORMED');assert.ok(result.limitations.some((text)=>text.includes('B-to-B')));const edge=edges(result).find((edge)=>edge.specifier==='./b');assert.equal(edge.kind,'dynamic-timing-unproved');assert.equal(edge.lexicalOwner.file,'src/a.ts');assert.ok(!Object.hasOwn(edge,'initializationOrigins'));assert.ok(!result.declaredGraph.graph['src/b.ts'].includes('src/b.ts'));});
});

test('retired callback-member refusal grants no native or SDK safety certificate',async()=>{
  await fixture({'src/a.ts':'(globalThis as any).registry={run:()=>import("./b")};','src/b.ts':'import "./a";'},(result)=>{passed(result);assert.ok(!result.problems.some((problem)=>/callable publication/.test(problem.reason)));assert.ok(result.limitations.some((text)=>text.includes('Native/SDK')));});
});

test('normal100M and lower-only CLI/API remain finite; exhaustion never proves zero',async()=>{
  assert.deepEqual(parseImportGateArguments(['--report','result.json']),{reportPath:'result.json',diagnosticWorkLimit:undefined});
  assert.deepEqual(parseImportGateArguments(['--report','result.json','--diagnostic-work-limit','100000000']),{reportPath:'result.json',diagnosticWorkLimit:100000000});
  for(const value of ['0','-1','1.5','NaN','Infinity','100000001','9007199254740992']) assert.throws(()=>parseImportGateArguments(['--report','result.json','--diagnostic-work-limit',value]));
  for(const diagnosticWorkLimit of [0,-1,1.5,NaN,Infinity,100000001,'1000']) await assert.rejects(evaluateDeclaredLoads({diagnosticWorkLimit}),/diagnosticWorkLimit/);
  await fixture({'src/a.ts':'void import("./b");','src/b.ts':'import "./a";'},(result)=>{blocked(result);assert.equal(result.scope.workOperations,1);assert.equal(result.scope.analysisComplete,false);assert.equal(result.declaredGraph.zeroCycleResult,'NOT_PROVEN');assert.equal(result.counts.declaredLoadCycleGroups,null);assert.ok(Object.values(result.completeness).some((value)=>value===false));},{},{diagnosticWorkLimit:1});
});

test('work refusal after discovered edges still emits a truthful serializable report',async()=>{
  await fixture({'src/a.ts':'import "./b"; void import("./b");','src/b.ts':'import "./a";'},(result)=>{
    blocked(result);assert.equal(result.scope.analysisComplete,false);assert.equal(result.scope.workOperations,40);
    assert.ok(edges(result).length>0);assert.ok(edges(result).every((edge)=>!Object.hasOwn(edge,'node')));
    assert.doesNotThrow(()=>JSON.stringify(result));assert.equal(result.declaredGraph.zeroCycleResult,'NOT_PROVEN');assert.equal(result.counts.declaredLoadCycleGroups,null);
  },{},{diagnosticWorkLimit:40});
});
