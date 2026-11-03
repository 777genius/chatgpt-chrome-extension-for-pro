import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,chmod,lstat,readdir,rm,symlink,open,mkdir,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {spawnSync,execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';
import {runMemory,parseArgs,openStore,acquireLock,isolateKey,connect,MemoryFault,PAGE_GUARD,type Call,type Options} from '../scripts/chrome-memory.ts';

const root=await mkdtemp(join(tmpdir(),'chrome-memory-test-'));
const mb=1024**2;
type Fixture={id:string;url:string;guardUrl?:string;isolate:string;heap:number;visibility:'hidden'|'visible';focused:boolean;generating:boolean;activityKnown:boolean;media:boolean;invalidHeap?:boolean};
function page(id:string,isolate=id):Fixture {return {id,url:`https://example.test/${id}`,isolate,heap:400*mb,visibility:'hidden',focused:false,generating:false,activityKnown:true,media:false};}
function fake(pages:Fixture[],hook?:(method:string,session?:string)=>void) {
  const calls:{method:string;params:Record<string,unknown>;session?:string}[]=[];
  let gc=0,hang=false;
  const call:Call=async(method,params={},session)=>{
    calls.push({method,params,session});hook?.(method,session);
    const current=pages.find(value=>`session-${value.id}`===session);
    if(method==='Target.getTargets')return {targetInfos:[...pages.map(p=>({targetId:p.id,type:'page',url:p.url,title:'Fixture'})),{targetId:'worker',type:'service_worker',url:'https://example.test/worker'}]};
    if(method==='Target.attachToTarget')return {sessionId:`session-${params.targetId}`};
    if(method==='Target.detachFromTarget')return {};
    assert.ok(current,'only measured page sessions may be addressed');
    if(method==='Runtime.getIsolateId')return {id:current.isolate};
    if(method==='Runtime.getHeapUsage')return {usedSize:current.invalidHeap?null:current.heap,totalSize:current.heap+100*mb};
    if(method==='Memory.getDOMCounters')return {documents:1,nodes:500,jsEventListeners:30};
    if(method==='Runtime.evaluate') {
      assert.equal(params.expression,PAGE_GUARD);
      return {result:{value:{url:current.guardUrl??current.url,title:'Fixture',visibility:current.visibility,focused:current.focused,ready:'complete',generating:current.generating,activityKnown:current.activityKnown,media:current.media}}};
    }
    if(method==='HeapProfiler.collectGarbage') {
      gc++;if(hang)return new Promise(()=>{});
      for(const item of pages)if(item.isolate===current.isolate)item.heap-=50*mb;
      return {};
    }
    throw new Error('Unexpected CDP command');
  };
  return {call,calls,get gc(){return gc;},set hang(value:boolean){hang=value;}};
}
let serial=0;
const options=(overrides:Partial<Options>={}):Options=>({...parseArgs([]),stateDir:join(root,`state-${++serial}`),timeoutMs:100,...overrides});
const ledger=async(dir:string)=>JSON.parse(await readFile(join(dir,'ledger.json'),'utf8'));
try {
  // Each regression must fail independently on the reviewed implementation.
  const regressions:Array<[string,()=>Promise<void>]>=[
    ['integer timeout',async()=>{assert.throws(()=>parseArgs(['--timeout-ms','1.5']),/invalid-options/);}],
    ['non-http peer census',async()=>{
      const blank=page('blank','selected');blank.url='';blank.guardUrl='about:blank';blank.focused=true;
      const f=fake([page('selected'),blank]),report=await runMemory(options({collect:true}),f.call);
      assert.equal(report.pages.length,2,'empty/about:blank pages must participate in the peer census');
      assert.ok(f.calls.some(call=>call.method==='Runtime.getIsolateId'&&call.session==='session-blank'));
      assert.equal(f.gc,0,'a focused non-HTTP shared peer cannot be hidden from the collection guard');
      assert.notEqual(report.pages.find(page=>page.target.targetId==='blank')?.reason,'url-changed','empty target URL is the about:blank document identity');
    }],
    ['unknown non-http peers',async()=>{
      const peer=page('internal');peer.url='chrome://settings';
      const f=fake([page('selected'),peer],(method,session)=>{if(method==='Runtime.getIsolateId'&&session==='session-internal')throw new MemoryFault('isolate-unknown');});
      const report=await runMemory(options({collect:true,includeActive:true}),f.call);
      assert.equal(report.unmeasuredPeerCount,1);assert.equal(f.gc,0);
    }],
    ['non-http direct eligibility',async()=>{
      const blank=page('blank');blank.url='about:blank';const f=fake([blank]);
      const report=await runMemory(options({collect:true,includeActive:true,target:'blank'}),f.call);
      assert.equal(report.pages.length,1);assert.equal(f.gc,0);assert.equal(report.groups[0].reason,'non-http-page');
    }],
    ['existing renderer peer joins',async()=>{
      for(const selected of [false,true])for(const afterIntent of [false,true]) {
        const peer=page('peer');peer.focused=true;let lists=0;
        const f=fake([page('selected'),peer],method=>{if(method==='Target.getTargets'&&++lists===(afterIntent?4:2))peer.isolate='selected';});
        const report=await runMemory(options({collect:true,...(selected?{target:'selected'}:{})}),f.call);
        assert.equal(f.gc,0,'an existing page joining the selected renderer must stop GC even without target/URL changes');
        assert.equal(report.groups.find(group=>group.isolateId==='selected')?.reason,'isolate-changed');
      }
    }],
    ['lock setup failure cleanup',async()=>{
      for(const operation of ['writeFile','sync'] as const) {
        const directory=join(root,`failed-lock-${operation}`);await mkdir(directory,{mode:0o700});
        const probe=await open(join(root,'handle-probe'),'a');const prototype=Object.getPrototypeOf(probe);await probe.close();
        const original=prototype[operation];prototype[operation]=async()=>{throw new Error('synthetic-lock-setup-failure');};
        try {await assert.rejects(acquireLock(directory,'failed'),/synthetic-lock-setup-failure/);}
        finally {prototype[operation]=original;}
        assert.deepEqual(await readdir(directory),[],'a failed lock setup must remove its own file');
        const release=await acquireLock(directory,'next');await release();
      }
    }],
    ['exact owned lock cleanup',async()=>{
      const directory=join(root,'replaced-lock');await mkdir(directory,{mode:0o700});
      const release=await acquireLock(directory,'original'),path=join(directory,'lock.json');
      await rename(path,join(directory,'original-lock.json'));
      await writeFile(path,'replacement',{mode:0o600});
      await assert.rejects(release(),/lock-changed/);
      assert.equal(await readFile(path,'utf8'),'replacement','cleanup must preserve a replacement lock');
      const failedDirectory=join(root,'replaced-during-setup');await mkdir(failedDirectory,{mode:0o700});
      const failedPath=join(failedDirectory,'lock.json'),probe=await open(join(root,'handle-probe'),'a');
      const prototype=Object.getPrototypeOf(probe);await probe.close();const original=prototype.sync;
      prototype.sync=async()=>{await rename(failedPath,join(failedDirectory,'original-lock.json'));await writeFile(failedPath,'replacement',{mode:0o600});throw new Error('synthetic-setup-replacement');};
      try {await assert.rejects(acquireLock(failedDirectory,'failed'),/lock-changed/);}
      finally {prototype.sync=original;}
      assert.equal(await readFile(failedPath,'utf8'),'replacement','failed setup cannot delete a replacement lock');
    }],
    ['signal lock release',async()=>{
      for(const signal of ['SIGINT','SIGTERM'] as const) {
        const directory=join(root,`signal-${signal}`),moduleURL=pathToFileURL(resolve('scripts/chrome-memory.ts')).href;
        const child=spawn(process.execPath,['--input-type=module','-e',`const {openStore}=await import(${JSON.stringify(moduleURL)});const store=await openStore(${JSON.stringify(directory)},'signal-run');await store.save();console.log('ready');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe'],timeout:5000,killSignal:'SIGKILL'});
        const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(yes=>child.once('close',(code,signal)=>yes({code,signal})));
        try {
          await new Promise<void>((yes,no)=>{child.once('error',no);child.once('close',()=>no(new Error('child exited before lock acquisition')));child.stdout.once('data',()=>yes());});
          child.kill(signal);const exit=await closed;
          assert.deepEqual(await readdir(directory),['ledger.json'],'handled termination releases the lock and preserves the ledger');
          assert.equal(exit.code,signal==='SIGINT'?130:143);
        } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
      }
    }],
  ];
  const failures:string[]=[];
  for(const [name,check] of regressions)try{await check();}catch(error){failures.push(`${name}: ${String(error)}`);}
  assert.deepEqual(failures,[],'review regressions');
  const base=parseArgs([]);assert.equal(base.collect,false);assert.equal(base.maxTabs,3);assert.equal(base.minHeapMB,256);
  assert.equal(base.allowUnmeasuredPeers,false);
  for(const flags of [['--allow-unmeasured-peers'],['--collect','--allow-unmeasured-peers'],['--include-active','--allow-unmeasured-peers']])assert.throws(()=>parseArgs(flags),/invalid-options/);
  assert.equal(parseArgs(['--collect','--include-active','--allow-unmeasured-peers']).allowUnmeasuredPeers,true);
  const empty=join(root,'empty');await import('node:fs/promises').then(fs=>fs.mkdir(empty,{mode:0o700}));
  const script=resolve('scripts/chrome-memory.ts');
  const help=spawnSync(process.execPath,[script,'--help','--bridge-config',join(root,'missing')],{cwd:empty,encoding:'utf8'});
  assert.equal(help.status,0);assert.match(help.stdout,/Default: inspect only/);
  const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(script).href)});console.log('import-ok')`],{cwd:empty,encoding:'utf8'});
  assert.equal(imported.status,0);assert.equal(imported.stdout.trim(),'import-ok');assert.deepEqual(await readdir(empty),[],'help and import neither connect nor write state');
  {
    const f=fake([page('idle')]),o=options();
    const report=await runMemory(o,f.call);
    assert.equal(f.gc,0,'default inspect must never collect');assert.equal(report.pages.length,1,'worker targets are excluded from the page census');
    assert.equal((await lstat(o.stateDir)).mode&0o777,0o700);assert.equal((await lstat(report.reportPath)).mode&0o777,0o600);
    assert.match(report.note,/does not prove physical RAM/);
    assert.ok(f.calls.some(call=>call.method==='Target.detachFromTarget'));
  }
  {
    const f=fake([page('one','shared'),page('two','shared')]),o=options({collect:true});
    const checked:Call=async(method,params,session)=>{
      if(method==='HeapProfiler.collectGarbage') {
        assert.equal((await ledger(o.stateDir)).entries[isolateKey('shared')].state,'intent','durable intent precedes the GC command');
        assert.equal((await lstat(join(o.stateDir,'ledger.json'))).mode&0o777,0o600);
      }
      return f.call(method,params,session);
    };
    const report=await runMemory(o,checked,()=>1000000);
    assert.equal(f.gc,1,'shared isolate receives exactly one sequential collection');
    assert.equal(report.groups[0].heapUsedDeltaBytes,-50*mb);assert.equal(report.groups[0].heapAllocatedDeltaBytes,-50*mb);
    assert.equal((await ledger(o.stateDir)).entries[isolateKey('shared')].state,'done');
    const repeat=await runMemory(o,checked,()=>1001000);assert.equal(f.gc,1);assert.equal(repeat.groups[0].reason,'cooldown');
  }
  for(const activity of ['visible','focused','generating','unknown'] as const) {
    const fixture=page(activity);
    if(activity==='visible')fixture.visibility='visible';if(activity==='focused')fixture.focused=true;
    if(activity==='generating')fixture.generating=true;if(activity==='unknown')fixture.activityKnown=false;
    const f=fake([fixture]);await runMemory(options({collect:true}),f.call);assert.equal(f.gc,0,`${activity} is skipped by default`);
    await runMemory(options({collect:true,includeActive:true}),f.call);assert.equal(f.gc,1,`${activity} requires explicit --include-active`);
  }
  {
    const idle=page('idle','same'),active=page('active','same');active.focused=true;
    const f=fake([idle,active]);await runMemory(options({collect:true}),f.call);assert.equal(f.gc,0,'an active shared-isolate sibling blocks collection');
    const invalid=page('unknown-measurement');invalid.invalidHeap=true;
    const unknown=fake([invalid]);await runMemory(options({collect:true,includeActive:true}),unknown.call);assert.equal(unknown.gc,0,'include-active never overrides missing memory measurements');
  }
  for(const change of ['url','isolate','after-intent'] as const) {
    const fixture=page(change);let lists=0,identities=0;
    const f=fake([fixture],method=>{
      if(method==='Target.getTargets'&&++lists===(change==='after-intent'?4:2)&&change!=='isolate')fixture.url='https://example.test/changed';
      if(method==='Runtime.getIsolateId'&&++identities===2&&change==='isolate')fixture.isolate='changed-isolate';
    });
    await runMemory(options({collect:true}),f.call);assert.equal(f.gc,0,`${change} before effect must stop collection`);
  }
  {
    const pages=[page('selected')];let lists=0;
    const f=fake(pages,method=>{if(method==='Target.getTargets'&&++lists===4){const popup=page('popup','selected');popup.focused=true;pages.push(popup);}});
    const report=await runMemory(options({collect:true,target:'selected'}),f.call);
    assert.equal(f.gc,0,'a new shared-isolate popup discovered after intent cannot bypass selected-target/activity guards');
    assert.equal(report.groups[0].reason,'target-set-changed');
  }
  {
    const peers=[page('measurable'),page('unmeasured')];
    const f=fake(peers,(method,session)=>{if(method==='Runtime.getIsolateId'&&session==='session-unmeasured')throw new MemoryFault('isolate-unknown');});
    const refused=await runMemory(options({collect:true,includeActive:true}),f.call);
    assert.equal(f.gc,0,'initial unknown peers still veto collection by default');
    assert.equal(refused.unmeasuredPeerCount,1);assert.equal(refused.sharedActivityUnverified,true);assert.equal(refused.allowUnmeasuredPeers,false);
    const allowed=await runMemory(options({collect:true,includeActive:true,allowUnmeasuredPeers:true}),f.call);
    assert.equal(f.gc,1,'the explicit combined opt-in permits only the measurable isolate');
    assert.equal(allowed.unmeasuredPeerCount,1);assert.equal(allowed.sharedActivityUnverified,true);assert.equal(allowed.allowUnmeasuredPeers,true);
    assert.ok(f.calls.filter(call=>call.method==='HeapProfiler.collectGarbage').every(call=>call.session==='session-measurable'));
    await runMemory(options({collect:true,includeActive:true,allowUnmeasuredPeers:true,target:'unmeasured'}),f.call);
    assert.equal(f.gc,1,'the opt-in cannot authorize GC on an unknown selected target');
    const invalid=page('bad-heap');invalid.invalidHeap=true;
    const bad=fake([invalid]);await runMemory(options({collect:true,includeActive:true,allowUnmeasuredPeers:true,target:'bad-heap'}),bad.call);assert.equal(bad.gc,0);
    const shared=fake([page('selected','same'),page('other','same')]);
    await runMemory(options({collect:true,includeActive:true,allowUnmeasuredPeers:true,target:'selected'}),shared.call);assert.equal(shared.gc,0,'known shared unselected targets remain a hard refusal');
    const current=[page('selected'),page('unmeasured')];let lists=0;
    const churn=fake(current,(method,session)=>{
      if(method==='Runtime.getIsolateId'&&session==='session-unmeasured')throw new MemoryFault('isolate-unknown');
      if(method==='Target.getTargets'&&++lists===4)current.push(page('new-peer','selected'));
    });
    const stopped=await runMemory(options({collect:true,includeActive:true,allowUnmeasuredPeers:true,target:'selected'}),churn.call);
    assert.equal(churn.gc,0);assert.equal(stopped.groups[0].reason,'target-set-changed','the opt-in never bypasses new-peer churn after intent');
  }
  {
    const f=fake(Array.from({length:5},(_,index)=>page(`limit-${index}`)));
    await runMemory(options({collect:true}),f.call);assert.equal(f.gc,3,'max-tabs limits collected isolates');
    const selected=fake([page('selected'),page('other')]);await runMemory(options({collect:true,target:'selected'}),selected.call);
    assert.equal(selected.gc,1);assert.equal(selected.calls.find(call=>call.method==='HeapProfiler.collectGarbage')?.session,'session-selected');
    const invalid=fake([page('valid')]);const missing=await runMemory(options({collect:true,target:'absent'}),invalid.call);
    assert.deepEqual(missing.errors,['target-not-found']);assert.equal(invalid.gc,0);assert.equal(invalid.calls.length,1);
    const shared=fake([page('selected','same'),page('unselected','same')]);await runMemory(options({collect:true,target:'selected'}),shared.call);assert.equal(shared.gc,0,'one-target authorization cannot expand to unselected shared contexts');
  }
  {
    const f=fake([page('timeout'),page('later')]),o=options({collect:true,timeoutMs:10});f.hang=true;
    const first=await runMemory(o,f.call,()=>2000000);assert.equal(f.gc,1);assert.ok(first.groups.some(group=>group.reason==='gc-outcome-unknown'));
    const saved=await ledger(o.stateDir);assert.equal(saved.entries[isolateKey('timeout')].state,'unknown');
    const second=await runMemory({...o,target:'timeout'},f.call,()=>9000000);assert.equal(f.gc,1,'an unknown effect never retries, even after cooldown');
    assert.equal(second.groups.find(group=>group.isolateId==='timeout')?.reason,'previous-outcome-unknown');
  }
  {
    const o=options({collect:true}),store=await openStore(o.stateDir,'test-lock'),f=fake([page('locked')]);
    const report=await runMemory(o,f.call);assert.deepEqual(report.errors,['state-locked']);assert.equal(f.calls.length,0,'overlap lock rejects before any browser command');await store.release();
    const seeded=await openStore(o.stateDir,'test-seed');seeded.ledger.entries[isolateKey('locked')]={state:'done',at:3000000,runId:'prior-run',isolateId:'locked',targetId:'locked',url:'https://example.test/locked',gc:true};await seeded.save();await seeded.release();
    await runMemory(o,f.call,()=>3001000);assert.equal(f.gc,0,'exported store can seed an already proven completed cooldown');
  }
  for(const status of ['intent','unknown','corrupt-done','corrupt-key'] as const) {
    const o=options({collect:true}),store=await openStore(o.stateDir,'test-ledger'),f=fake([page('ledger')]);
    const entry={state:status.startsWith('corrupt')?'done':status,at:3000000,runId:'previous',isolateId:'ledger',targetId:'ledger',url:'https://example.test/ledger',...(status==='corrupt-done'?{gc:'true'}:status==='corrupt-key'?{gc:true}:{})};
    store.ledger.entries[status==='corrupt-key'?'wrong-key':isolateKey('ledger')]=entry as unknown as typeof store.ledger.entries[string];await store.save();await store.release();
    const report=await runMemory(o,f.call,()=>9000000);assert.equal(f.gc,0,'unknown intents and malformed cooldown entries always fail closed');
    if(status.startsWith('corrupt')){assert.deepEqual(report.errors,['invalid-ledger']);assert.equal(f.calls.length,0);}
    else assert.equal(report.groups[0].reason,'previous-outcome-unknown');
  }
  {
    const {document,window}=parseHTML('<html><head><title>Fixture</title></head><body></body></html>');
    Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{width:240,height:32}],configurable:true});
    Object.assign(document,{hasFocus:()=>false,readyState:'complete',visibilityState:'hidden'});
    const location=new URL('https://chatgpt.com/c/synthetic-fixture');
    assert.equal(runInNewContext(PAGE_GUARD,{document,location}).activityKnown,false,'a ChatGPT snapshot without a composer is unknown');
    document.body.innerHTML='<form data-composer-body><button data-testid="stop-button">Stop</button></form>';
    const guard=runInNewContext(PAGE_GUARD,{document,location});assert.equal(guard.activityKnown,true);assert.equal(guard.generating,true);
  }
  {
    const token=randomBytes(20).toString('hex'),config=join(root,'bridge.json');
    let redirectTo='';
    const server=createServer((request,response)=>{
      if(request.method==='POST')assert.ok(request.headers.authorization===`Bearer ${token}`,'bridge must use its configured authentication');
      request.resume();
      if(redirectTo){response.writeHead(302,{Location:redirectTo});response.end();return;}
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify({error:{message:token}}));
    });
    await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
    try {
      const address=server.address();assert.ok(address&&typeof address!=='string');
      await writeFile(config,JSON.stringify({port:address.port,token}),{mode:0o600});
      const transport=await connect(options({bridgeConfig:config}));
      await assert.rejects(transport.call('Target.getTargets'),error=>error instanceof MemoryFault&&!String(error).includes(token));transport.close();
      const result=await promisify(execFile)(process.execPath,[script,'--bridge-config',config,'--state-dir',join(root,'cli-error')],{encoding:'utf8'}).catch(error=>({stdout:error.stdout as string,stderr:error.stderr as string}));
      assert.ok(!(result.stdout+result.stderr).includes(token),'CLI output never exposes echoed bridge secrets');
      const summary=JSON.parse(result.stdout);assert.ok(!(await readFile(summary.report,'utf8')).includes(token),'full reports never expose transport error payloads');
      let redirectedRequests=0;
      const receiver=createServer((request,response)=>{redirectedRequests++;request.resume();response.end('{}');});
      await new Promise<void>(yes=>receiver.listen(0,'127.0.0.1',yes));
      try {
        const destination=receiver.address();assert.ok(destination&&typeof destination!=='string');
        redirectTo=`http://127.0.0.1:${destination.port}/redirected`;
        const redirected=await connect(options({bridgeConfig:config}));
        await assert.rejects(redirected.call('Target.getTargets'),/bridge-transport-failed/);redirected.close();
        await assert.rejects(connect(options({cdp:`http://127.0.0.1:${address.port}`})),/cdp-discovery-failed/);
        assert.equal(redirectedRequests,0,'neither authenticated bridge nor discovery may follow HTTP redirects');
      } finally {await new Promise<void>(yes=>receiver.close(()=>yes()));redirectTo='';}
      await chmod(config,0o644);await assert.rejects(connect(options({bridgeConfig:config})),/file-not-private/);await chmod(config,0o600);
      const alias=join(root,'bridge-link');await symlink(config,alias);await assert.rejects(connect(options({bridgeConfig:alias})),/file-not-private/);
      await assert.rejects(connect(options({cdp:'http://remote.example:9222'})),/invalid-local-endpoint/);
    } finally {await new Promise<void>(yes=>server.close(()=>yes()));}
  }
  const allowed=new Set(['Target.getTargets','Target.attachToTarget','Target.detachFromTarget','Runtime.getIsolateId','Runtime.getHeapUsage','Runtime.evaluate','Memory.getDOMCounters','HeapProfiler.collectGarbage']);
  const final=fake([page('allowed')]);await runMemory(options({collect:true}),final.call);
  assert.ok(final.calls.every(call=>allowed.has(call.method)),'only measurements, guarded GC and session detachment are used');
  assert.doesNotMatch(PAGE_GUARD,/\.click\(|\.remove\(|\.setAttribute\(|localStorage|sessionStorage|fetch\(/,'page probe reads metadata and guards only');
  console.log('PASS: memory inspect has zero GC; opt-in isolate collection, identity/activity guards, one-target scope, intent/cooldown/unknown locks, no retry/forbidden commands, private reports/auth and help/import safety');
} finally {await rm(root,{recursive:true,force:true});}
