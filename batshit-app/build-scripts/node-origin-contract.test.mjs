import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve_origin } from '../node_modules/@sveltejs/adapter-node/src/origin.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const [name, origin] of [
  ['Mac', 'http://127.0.0.1:5620'], ['FirstRun', 'http://127.0.0.1:5640'],
  ['Native configuration', 'http://127.0.0.1:5621'], ['Pinokio', 'http://127.0.0.1:5650'],
  ['Docker published port', 'http://localhost:15620'], ['HTTPS proxy', 'https://batshit.example.test'],
  ['IPv6', 'http://[::1]:15620']
]) test(`${name} runtime origin is deployment-owned and relocatable`, () => {
  assert.equal(resolve_origin(undefined, origin, origin), origin);
});

test('truly absent configuration preserves upstream request-derived behavior', () => {
  assert.equal(resolve_origin(undefined, undefined, undefined), undefined);
});

test('equivalent valid origins normalize without splitting authority', () => {
  assert.equal(resolve_origin('https://example.test', 'HTTPS://EXAMPLE.TEST:443/', 'https://example.test/'), 'https://example.test');
  assert.equal(resolve_origin(undefined, 'http://[0:0:0:0:0:0:0:1]:15620/', undefined), 'http://[::1]:15620');
});

test('explicit build authority is retained and configuration conflicts refuse', () => {
  assert.equal(resolve_origin('https://example.test', undefined, undefined), 'https://example.test');
  assert.equal(resolve_origin('https://example.test', 'https://example.test', undefined), 'https://example.test');
  assert.throws(() => resolve_origin('https://example.test', 'http://example.test', undefined), /conflict/);
  assert.throws(() => resolve_origin('https://example.test', undefined, 'https://other.test'), /conflict/);
  assert.throws(() => resolve_origin(undefined, 'http://localhost:5650', 'http://127.0.0.1:5650'), /conflict/);
});

test('adapter-prefixed and application origin configuration cannot disagree', () => {
  assert.equal(resolve_origin(undefined, 'https://example.test:8443', undefined), 'https://example.test:8443');
  assert.equal(resolve_origin(undefined, undefined, 'https://example.test:8443'), 'https://example.test:8443');
  assert.throws(() => resolve_origin(undefined, 'https://example.test:8443', 'https://example.test'), /conflict/);
});

const invalid = ['', ' ', null, false, 0, '//example.test', 'example.test',
  'ftp://example.test', 'file:///tmp/example', 'http:///example.test',
  'http://user:password@example.test', 'http://@example.test', 'http://example.test/path',
  'http://example.test/.', 'http://example.test/%2e', 'http://example.test//',
  'http://example.test?query', 'http://example.test#fragment', 'http://example.test:',
  'http://example.test:0', 'http://example.test:65536', 'http://example.test\\path',
  ' http://example.test', 'http://example.test ', 'http://example.test\n',
  'http://example.test\r\nforged', 'http://exa\tmple.test'];
for (const [i, value] of invalid.entries()) test(`invalid configured origin ${i + 1} fails closed`, () => {
  for (const position of [0, 1, 2]) {
    const inputs = [undefined, undefined, undefined]; inputs[position] = value;
    assert.throws(() => resolve_origin(...inputs), /must be an absolute HTTP\(S\) origin/);
  }
  assert.throws(() => resolve_origin('https://example.test', value, undefined));
});

test('configuration errors never echo credential-bearing inputs', () => {
  const value = 'http://operator:private-value@example.test';
  assert.throws(() => resolve_origin(undefined, value), (error) => {
    assert.ok(!error.message.includes(value)); assert.ok(!error.message.includes('private-value')); return true;
  });
});

test('pinned patch binds configuration before app initialization and preserves envPrefix', () => {
  const vendor = path.join(root, 'node_modules/@sveltejs/adapter-node');
  assert.equal(JSON.parse(fs.readFileSync(path.join(vendor, 'package.json'), 'utf8')).version, '6.0.1');
  const handler = fs.readFileSync(path.join(vendor, 'src/handler.js'), 'utf8');
  const env = fs.readFileSync(path.join(vendor, 'src/env.js'), 'utf8');
  const initialization = handler.indexOf('await server.init(');
  assert.ok(initialization >= 0, 'The actual Kit initialization boundary must exist');
  for (const needle of ["resolve_origin(origin, env('ORIGIN'), process.env.ORIGIN)", 'process.env.ORIGIN = configured_origin']) {
    const binding = handler.indexOf(needle);
    assert.ok(binding >= 0, `Required deployment-origin binding is absent: ${needle}`);
    assert.ok(binding < initialization, 'The deployment origin must be bound before Kit initializes');
  }
  assert.match(handler, /let request_origin = configured_origin;/);
  assert.match(handler, /request_origin = get_origin\(req.headers\)/);
  assert.match(env, /'ORIGIN'/);
  assert.match(env, /const prefix = expected_unprefixed.has\(name\) \? '' : env_prefix;/);
  assert.match(env, /return prefixed in process.env \? process.env\[prefixed\] : fallback;/);
});

test('actual patched handler and env execute prefixed/build origin binding before Kit initialization', () => {
  // Compile-time variants cannot be changed in one portable built artifact.
  // Execute the exact installed production sources with controlled virtual
  // adapter exports; only Kit server/HTTP/static dependencies are stubs here.
  const script = String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import vm from 'node:vm';
    import path from 'node:path';
    const directory=path.join(process.argv[2],'node_modules/@sveltejs/adapter-node/src');
    const cases=[
      {name:'prefix only',prefix:'DEPLOY_',env:{DEPLOY_ORIGIN:'https://example.test'},expected:'https://example.test'},
      {name:'prefix/global equivalent',prefix:'DEPLOY_',env:{DEPLOY_ORIGIN:'HTTPS://EXAMPLE.TEST:443/',ORIGIN:'https://example.test/'},expected:'https://example.test'},
      {name:'build only',build:'https://example.test',env:{},expected:'https://example.test'},
      {name:'build/runtime match',build:'https://example.test',env:{ORIGIN:'https://example.test'},expected:'https://example.test'},
      {name:'prefix/global conflict',prefix:'DEPLOY_',env:{DEPLOY_ORIGIN:'https://example.test',ORIGIN:'http://example.test'},reject:/conflict/},
      {name:'build/runtime conflict',build:'https://example.test',env:{ORIGIN:'http://example.test'},reject:/conflict/},
      {name:'empty prefix origin',prefix:'DEPLOY_',env:{DEPLOY_ORIGIN:''},reject:/absolute HTTP/},
      {name:'invalid build origin',build:'https://example.test/path',env:{},reject:/absolute HTTP/},
      {name:'all absent',env:{},expected:undefined,request:'https://internal.example.test:3000'}
    ];
    for(const item of cases){
      const observed={initializations:[],requests:[]};
      const localProcess={env:{...item.env}};
      const context=vm.createContext({console,URL});
      const synthetic=(values)=>new vm.SyntheticModule(Object.keys(values),function(){for(const [name,value] of Object.entries(values))this.setExport(name,value);},{context});
      const server={init:async({env})=>observed.initializations.push({...env}),respond:async(request)=>{observed.requests.push(request.url.origin);return {headers:new Map()};}};
      const modules=new Map([
        ['node:process',synthetic({default:localProcess})],
        ['#@sveltejs/adapter-node',synthetic({server,dir:'/synthetic',env_prefix:item.prefix??'',base:'',app_path:'_app',origin:item.build,mime_types:{},assets:new Set(),prerendered_assets:new Set()})],
        ['@sveltejs/kit/node',synthetic({getRequest:({base,request})=>({url:new URL(request.url,base)}),setResponse:()=>{},createReadableStream:()=>{throw new Error('No fixture asset read permitted');}})],
        ['./utils.js',synthetic({parse_as_bytes:()=>524288})],
        ['./static.js',synthetic({create_file_map:()=>new Map(),serve_static:()=>((_req,_res,next)=>next())})]
      ]);
      for(const name of ['env.js','origin.js','handler.js']) modules.set('./'+name,new vm.SourceTextModule(fs.readFileSync(path.join(directory,name),'utf8'),{context,identifier:name}));
      const handler=modules.get('./handler.js');
      await handler.link((specifier)=>{assert.ok(modules.has(specifier),specifier);return modules.get(specifier);});
      if(item.reject){await assert.rejects(handler.evaluate(),item.reject,item.name);assert.equal(observed.initializations.length,0,item.name);continue;}
      await handler.evaluate();
      assert.equal(observed.initializations.length,1,item.name);
      assert.equal(observed.initializations[0].ORIGIN,item.expected,item.name);
      assert.equal(localProcess.env.ORIGIN,item.expected,item.name);
      await handler.namespace.handler({url:'/setup',headers:{host:'internal.example.test:3000','x-forwarded-host':'attacker.test','x-forwarded-proto':'http'},connection:{remoteAddress:'127.0.0.1'}},{},()=>{});
      assert.deepEqual(observed.requests,[item.request??item.expected],item.name);
    }
    console.log(JSON.stringify({cases:cases.length,productionSourceWiring:true,alternateBuiltArtifactsProduced:false}));
  `;
  const result=spawnSync(process.execPath,['--experimental-vm-modules','--input-type=module','-',root],{input:script,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{cases:9,productionSourceWiring:true,alternateBuiltArtifactsProduced:false});
});
