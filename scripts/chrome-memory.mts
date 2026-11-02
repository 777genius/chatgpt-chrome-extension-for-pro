import {constants} from 'node:fs';
import {lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export type Call=(method:string,params?:Record<string,unknown>,sessionId?:string)=>Promise<unknown>;
export interface Options {collect:boolean;includeActive:boolean;allowUnmeasuredPeers:boolean;maxTabs:number;minHeapMB:number;stateDir:string;timeoutMs:number;bridgeConfig?:string;cdp?:string;target?:string;help?:boolean}
interface Target {targetId:string;type:string;url:string;title?:string}
interface Guard {url:string;title:string;visibility:string;focused:boolean;ready:string;generating:boolean;activityKnown:boolean;media:boolean}
interface Heap {usedSize:number;totalSize:number}
interface DOM {documents:number;nodes:number;jsEventListeners:number}
interface Sample {heap:Heap;dom:DOM;guard:Guard}
interface Page {target:Target;sessionId?:string;isolateId?:string;sample?:Sample;reason?:string}
export interface Entry {state:'intent'|'done'|'unknown';at:number;runId:string;isolateId:string;targetId:string;url:string;gc?:boolean}
export interface Ledger {schema:1;entries:Record<string,Entry>}
export interface Report {schema:1;runId:string;mode:'inspect'|'collect';startedAt:number;finishedAt?:number;maxIsolates:number;allowUnmeasuredPeers:boolean;unmeasuredPeerCount:number;sharedActivityUnverified:boolean;pages:Page[];groups:Array<{isolateId:string;targetIds:string[];reason?:string;gc?:boolean;before?:Sample;after?:Sample;heapUsedDeltaBytes?:number;heapAllocatedDeltaBytes?:number;error?:string}>;errors:string[];reportPath:string;note:string}
export class MemoryFault extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
function fault(code:string):never {throw new MemoryFault(code);}
const code=(error:unknown)=>error instanceof MemoryFault?error.code:'operation-failed';
const missing=(error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code==='ENOENT';
const owned=(stat:{uid:number})=>!process.getuid||stat.uid===process.getuid();
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const httpPage=(target:Target)=>target.type==='page'&&/^https?:\/\//.test(target.url);
// CDP reports an empty target URL for some initial about:blank documents.
const sameDocumentURL=(target:Target,url:string)=>target.url===url||target.url===''&&url==='about:blank';

async function privateDirectory(path:string) {
  await mkdir(path,{recursive:true,mode:0o700});
  const stat=await lstat(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||!owned(stat))fault('state-directory-not-private');
}
export async function readPrivateJSON(path:string):Promise<unknown> {
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600||!owned(stat))fault('file-not-private');
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try {
    const actual=await file.stat();
    if(actual.ino!==stat.ino||actual.dev!==stat.dev||(actual.mode&0o777)!==0o600||!owned(actual))fault('file-changed');
    try {return JSON.parse(await file.readFile('utf8'));}catch{fault('invalid-private-json');}
  } finally {await file.close();}
}
async function atomicJSON(path:string,value:unknown) {
  const temporary=join(dirname(path),`.${randomUUID()}.tmp`);
  const file=await open(temporary,'wx',0o600);
  try {await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}
  finally {await file.close();}
  try {
    await rename(temporary,path);
    const directory=await open(dirname(path),'r');
    try {await directory.sync();}finally{await directory.close();}
  } catch(error) {await unlink(temporary).catch(()=>{});throw error;}
}
export async function acquireLock(stateDir:string,runId:string) {
  const path=join(stateDir,'lock.json');
  const file=await open(path,'wx',0o600).catch(()=>fault('state-locked'));
  let identity:Awaited<ReturnType<typeof file.stat>>|undefined,cleanup:Promise<void>|undefined,interrupted=false;
  const release=()=>{
    cleanup??=(async()=>{
      process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onTerminate);
      identity??=await file.stat();
      const current=await lstat(path);
      if(current.ino!==identity.ino||current.dev!==identity.dev)fault('lock-changed');
      await unlink(path);
    })();
    return cleanup;
  };
  const stop=(status:number)=>{interrupted=true;void release().then(()=>process.exit(status),()=>process.exit(status));};
  const onInterrupt=()=>stop(130),onTerminate=()=>stop(143);
  process.once('SIGINT',onInterrupt);process.once('SIGTERM',onTerminate);
  try {
    identity=await file.stat();
    await file.writeFile(JSON.stringify({schema:1,runId,at:Date.now(),pid:process.pid}));await file.sync();await file.close();
    return Object.assign(release,{interrupted:()=>interrupted});
  } catch(error) {
    try {await release();}finally{await file.close().catch(()=>{});}
    throw error;
  }
}
async function readLedger(path:string):Promise<Ledger> {
  let value;
  try {value=await readPrivateJSON(path);}catch(error){if(missing(error))return {schema:1,entries:{}};throw error;}
  const ledger=value as Ledger;
  if(ledger?.schema!==1||!ledger.entries||typeof ledger.entries!=='object'||Array.isArray(ledger.entries))fault('invalid-ledger');
  for(const [key,entry] of Object.entries(ledger.entries)) {
    if(!entry||!['intent','done','unknown'].includes(entry.state)||!finite(entry.at)||
        ![entry.isolateId,entry.targetId,entry.url,entry.runId].every(value=>typeof value==='string'&&value.length>0)||
        !/^https?:\/\//.test(entry.url)||key!==isolateKey(entry.isolateId)||
        entry.state==='done'&&typeof entry.gc!=='boolean'||entry.gc!==undefined&&typeof entry.gc!=='boolean')fault('invalid-ledger');
  }
  return ledger;
}
export const isolateKey=(id:string)=>createHash('sha256').update(id).digest('hex');
export async function openStore(stateDir:string,runId:string=randomUUID()) {
  await privateDirectory(stateDir);
  const release=await acquireLock(stateDir,runId),path=join(stateDir,'ledger.json');
  try {
    const ledger=await readLedger(path);
    return {ledger,save:()=>atomicJSON(path,ledger),release};
  }catch(error){await release();throw error;}
}
async function bounded<T>(operation:Promise<T>,timeoutMs:number):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new MemoryFault('command-timeout')),timeoutMs);})]);}
  finally {if(timer)clearTimeout(timer);}
}
const loopback=(value:string,protocols:string[])=>{
  let url:URL;try{url=new URL(value);}catch{fault('invalid-local-endpoint');}
  if(!protocols.includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)fault('invalid-local-endpoint');
  return url;
};
export async function connect(options:Options):Promise<{call:Call;close():void}> {
  if(options.bridgeConfig) {
    const config=await readPrivateJSON(options.bridgeConfig) as {port?:number;token?:string};
    if(!Number.isInteger(config?.port)||config.port!<1||config.port!>65535||typeof config.token!=='string'||!config.token)fault('invalid-bridge-config');
    return {close(){},call:async(method,params={},sessionId)=>{
      try {
        const response=await fetch(`http://127.0.0.1:${config.port}`,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},
          body:JSON.stringify({method,params,...(sessionId?{sessionId}:{})}),signal:AbortSignal.timeout(options.timeoutMs)});
        if(!response.ok)fault('bridge-http-failed');
        const value=await response.json() as {result?:unknown;error?:unknown};
        if(value.error)fault('cdp-command-failed');
        if(!Object.hasOwn(value,'result'))fault('invalid-cdp-response');
        return value.result;
      } catch(error) {if(error instanceof MemoryFault)throw error;fault('bridge-transport-failed');}
    }};
  }
  if(!options.cdp)fault('connection-required');
  const endpoint=loopback(options.cdp,['http:']);
  let address:string;
  try {
    const response=await fetch(new URL('/json/version',endpoint),{redirect:'error',signal:AbortSignal.timeout(options.timeoutMs)});
    if(!response.ok)fault('cdp-discovery-failed');
    address=(await response.json() as {webSocketDebuggerUrl:string}).webSocketDebuggerUrl;
  } catch {fault('cdp-discovery-failed');}
  const socketUrl=loopback(address,['ws:']);
  if(socketUrl.port!==endpoint.port)fault('cdp-endpoint-changed');
  const socket=new WebSocket(socketUrl.href);
  const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:MemoryFault)=>void;timer:ReturnType<typeof setTimeout>}>();
  let serial=0,closed=false;
  const fail=()=>{closed=true;for(const item of pending.values()){clearTimeout(item.timer);item.reject(new MemoryFault('cdp-disconnected'));}pending.clear();};
  socket.addEventListener('close',fail);socket.addEventListener('error',fail);
  socket.addEventListener('message',event=>{
    try {
      const value=JSON.parse(String(event.data)) as {id:number;result?:unknown;error?:unknown};
      const item=pending.get(value.id);if(!item)return;
      pending.delete(value.id);clearTimeout(item.timer);
      if(value.error)item.reject(new MemoryFault('cdp-command-failed'));
      else if(!Object.hasOwn(value,'result'))item.reject(new MemoryFault('invalid-cdp-response'));
      else item.resolve(value.result);
    } catch {/* Ignore non-response frames, never expose browser payloads. */}
  });
  try {await bounded(new Promise<void>((yes,no)=>{socket.addEventListener('open',()=>yes(),{once:true});socket.addEventListener('error',()=>no(new MemoryFault('cdp-connect-failed')),{once:true});}),options.timeoutMs);}
  catch{socket.close();fault('cdp-connect-failed');}
  return {close(){socket.close();},call(method,params={},sessionId){
    if(closed)return Promise.reject(new MemoryFault('cdp-disconnected'));
    return new Promise((yes,no)=>{
      const id=++serial,timer=setTimeout(()=>{pending.delete(id);no(new MemoryFault('command-timeout'));},options.timeoutMs);
      pending.set(id,{resolve:yes,reject:no,timer});
      try {socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}
      catch {pending.delete(id);clearTimeout(timer);no(new MemoryFault('cdp-send-failed'));}
    });
  }};
}

// Static read-only DOM probe. A ChatGPT snapshot without a native composer is
// not proof of idleness, even when its visible stop button is absent.
export const PAGE_GUARD=`(()=>{
 const visible=node=>Boolean(node&&node.getClientRects().length&&!node.closest('[inert],[aria-hidden="true"],[data-app-shell-active-page="false"]'));
 const root=document.querySelector('[data-app-shell-active-page="true"]')||document;
 const composer=[...root.querySelectorAll('[data-composer-body],#prompt-textarea')].some(visible);
 const generating=[...root.querySelectorAll('button')].some(node=>visible(node)&&(node.matches('[data-testid="stop-button"],[data-testid="fruitjuice-stop-button"]')||node.querySelector('svg.icon-primary-action path[d^="M4.5 5.75C4.5"]')));
 return {url:location.href,title:document.title,visibility:document.visibilityState,focused:document.hasFocus(),ready:document.readyState,
 generating,activityKnown:location.hostname!=='chatgpt.com'||composer,media:[...document.querySelectorAll('video,audio')].some(node=>!node.paused&&!node.ended)};
})()`;
function validGuard(value:unknown):value is Guard {
  const guard=value as Guard;
  return typeof guard?.url==='string'&&typeof guard.title==='string'&&['hidden','visible'].includes(guard.visibility)&&typeof guard.focused==='boolean'&&
    typeof guard.ready==='string'&&typeof guard.generating==='boolean'&&typeof guard.activityKnown==='boolean'&&typeof guard.media==='boolean';
}
function guardReason(guard:Guard,includeActive:boolean) {
  if(guard.ready!=='complete')return 'page-not-ready';
  if(!includeActive&&guard.generating)return 'generating';
  if(guard.media)return 'playing-media';
  if(!includeActive&&(guard.visibility==='visible'||guard.focused))return 'active-or-focused';
  if(!includeActive&&!guard.activityKnown)return 'activity-unknown';
  return '';
}
export async function runMemory(options:Options,raw:Call,now=Date.now):Promise<Report> {
  if(options.allowUnmeasuredPeers&&(!options.includeActive||!options.collect))fault('invalid-options');
  await privateDirectory(options.stateDir);
  const runId=randomUUID(),reportPath=join(options.stateDir,`report-${runId}.json`);
  const report:Report={schema:1,runId,mode:options.collect?'collect':'inspect',startedAt:now(),maxIsolates:options.maxTabs,allowUnmeasuredPeers:options.allowUnmeasuredPeers,unmeasuredPeerCount:0,sharedActivityUnverified:false,pages:[],groups:[],errors:[],reportPath,
    note:'Heap used/allocated are V8 isolate measurements. OS RSS is not measured; a smaller JS heap does not prove physical RAM was released.'};
  let release:Awaited<ReturnType<typeof acquireLock>>|undefined;
  const call:Call=(method,params={},sessionId)=>{
    if(release?.interrupted())fault('interrupted');
    return bounded(raw(method,params,sessionId),options.timeoutMs);
  };
  const targets=async()=>{
    const result=await call('Target.getTargets') as {targetInfos:Target[]};
    if(!Array.isArray(result?.targetInfos))fault('invalid-target-list');
    return result.targetInfos.filter(target=>typeof target?.targetId==='string'&&typeof target.url==='string'&&target.type==='page');
  };
  const isolate=async(session:string)=>{
    const result=await call('Runtime.getIsolateId',{},session) as {id:string};
    if(typeof result?.id!=='string'||!result.id)fault('isolate-unknown');return result.id;
  };
  const guard=async(session:string)=>{
    const result=await call('Runtime.evaluate',{expression:PAGE_GUARD,returnByValue:true,timeout:Math.min(1500,options.timeoutMs)},session) as {result?:{value?:unknown};exceptionDetails?:unknown};
    if(result?.exceptionDetails||!validGuard(result?.result?.value))fault('activity-measurement-unknown');return result.result!.value as Guard;
  };
  const sample=async(session:string):Promise<Sample>=>{
    const heap=await call('Runtime.getHeapUsage',{},session) as Heap,dom=await call('Memory.getDOMCounters',{},session) as DOM;
    if(!finite(heap?.usedSize)||!finite(heap.totalSize)||heap.totalSize<heap.usedSize||!finite(dom?.documents)||!finite(dom.nodes)||!finite(dom.jsEventListeners))fault('memory-measurement-unknown');
    return {heap,dom,guard:await guard(session)};
  };
  try {
    const store=await openStore(options.stateDir,runId);release=store.release;
    const ledger=store.ledger,discovered=await targets();
    const signature=(items:Target[])=>JSON.stringify(items.map(target=>[target.targetId,target.url]).sort((a,b)=>a[0].localeCompare(b[0])));
    const initialSignature=signature(discovered);
    if(options.target&&!discovered.some(target=>target.targetId===options.target))fault('target-not-found');
    for(const target of discovered) {
      const page:Page={target};report.pages.push(page);
      try {
        const attached=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true}) as {sessionId:string};
        if(typeof attached?.sessionId!=='string'||!attached.sessionId)fault('attach-unknown');
        page.sessionId=attached.sessionId;page.isolateId=await isolate(page.sessionId);
        if(options.target&&target.targetId!==options.target){page.reason='target-not-selected';continue;}
        page.sample=await sample(page.sessionId);
        if(!sameDocumentURL(target,page.sample.guard.url))fault('url-changed');
        page.reason=!httpPage(target)?'non-http-page':guardReason(page.sample.guard,options.includeActive)||undefined;
      }catch(error){page.reason=code(error);}
    }
    const groups=new Map<string,Page[]>();
    for(const page of report.pages)if(page.isolateId)groups.set(page.isolateId,[...(groups.get(page.isolateId)||[]),page]);
    let collected=0,uncertain=false;
    // Unknown peers can hide shared activity. Only the explicit combined opt-in
    // bypasses this initial veto; the selected isolate's own proof stays required.
    report.unmeasuredPeerCount=report.pages.filter(page=>!page.isolateId).length;
    report.sharedActivityUnverified=report.unmeasuredPeerCount>0;
    const unresolvedPeer=report.unmeasuredPeerCount>0&&!options.allowUnmeasuredPeers;
    const ranked=Array.from(groups).sort((left,right)=>Math.max(...right[1].map(p=>p.sample?.heap.usedSize||0))-Math.max(...left[1].map(p=>p.sample?.heap.usedSize||0)));
    for(const [isolateId,pages] of ranked) {
      const row:Report['groups'][number]={isolateId,targetIds:pages.map(page=>page.target.targetId)};report.groups.push(row);
      const primary=pages[0],key=isolateKey(isolateId),old=ledger.entries[key];
      row.reason=unresolvedPeer?'unknown-peer-isolate':pages.find(page=>page.reason)?.reason;
      if(options.target&&!pages.some(page=>page.target.targetId===options.target))row.reason='target-not-selected';
      else if(options.target&&pages.some(page=>page.target.targetId!==options.target))row.reason='shared-with-unselected-target';
      if(!row.reason&&pages.some(page=>!page.sample))row.reason='measurement-unknown';
      if(!row.reason&&Math.max(...pages.map(page=>page.sample!.heap.usedSize))<options.minHeapMB*1024**2)row.reason='below-minimum-heap';
      if(!row.reason&&old&&old.state!=='done')row.reason='previous-outcome-unknown';
      if(!row.reason&&old?.gc===true&&now()-old.at<600000)row.reason='cooldown';
      if(!row.reason&&uncertain)row.reason='earlier-gc-unknown';
      if(!row.reason&&collected>=options.maxTabs)row.reason='isolate-limit';
      if(row.reason||!options.collect)continue;
      let intent=false,dispatched=false;
      const recheck=async()=>{
        const current=await targets();
        if(signature(current)!==initialSignature)fault('target-set-changed');
        // An existing page can move into this renderer without changing its URL
        // or the target list. Revalidate the entire initially measured census.
        for(const page of report.pages)if(page.isolateId&&await isolate(page.sessionId!)!==page.isolateId)fault('isolate-changed');
        for(const page of pages) {
          if(!current.some(target=>target.targetId===page.target.targetId&&target.url===page.target.url))fault('url-changed');
          const state=await guard(page.sessionId!);
          if(!sameDocumentURL(page.target,state.url))fault('url-changed');
          const reason=guardReason(state,options.includeActive);if(reason)fault(reason);
        }
        if(signature(await targets())!==initialSignature)fault('target-set-changed');
      };
      try {
        await recheck();row.before=await sample(primary.sessionId!);
        if(row.before.heap.usedSize<options.minHeapMB*1024**2)fault('below-minimum-heap');
        ledger.entries[key]={state:'intent',at:now(),runId,isolateId,targetId:primary.target.targetId,url:primary.target.url};
        await store.save();intent=true;
        await recheck();dispatched=true;
        const ack=await call('HeapProfiler.collectGarbage',{},primary.sessionId!);
        if(!ack||typeof ack!=='object'||Array.isArray(ack))fault('gc-ack-unknown');
        row.gc=true;collected++;
        ledger.entries[key]={...ledger.entries[key],state:'done',at:now(),gc:true};await store.save();
        try {
          await recheck();const after=await sample(primary.sessionId!);
          if(await isolate(primary.sessionId!)!==isolateId||!sameDocumentURL(primary.target,after.guard.url))fault('after-identity-changed');
          row.after=after;row.heapUsedDeltaBytes=after.heap.usedSize-row.before.heap.usedSize;row.heapAllocatedDeltaBytes=after.heap.totalSize-row.before.heap.totalSize;
        }
        catch(error){row.error=code(error);}
      }catch(error) {
        row.error=code(error);row.reason=dispatched?'gc-outcome-unknown':code(error);
        if(intent) {
          ledger.entries[key]={...ledger.entries[key],state:dispatched?'unknown':'done',at:now(),gc:false};
          await store.save();
        }
        if(dispatched)uncertain=true;
      }
    }
  }catch(error){report.errors.push(code(error));}
  finally {
    for(const page of report.pages)if(page.sessionId)try{await call('Target.detachFromTarget',{sessionId:page.sessionId});}catch{report.errors.push('detach-failed');}
    report.finishedAt=now();
    try {await atomicJSON(reportPath,report);}finally{if(release)await release();}
  }
  return report;
}

export const HELP=`Usage: node scripts/chrome-memory.mts [--collect] [options]
Default: inspect only; no garbage collection or browser settings changes.
  --bridge-config FILE   Private regular 0600 JSON {port,token} for an existing localhost bridge
  --cdp HTTP_URL         Existing localhost CDP endpoint; no browser launch or debugging changes
  --collect              Explicitly allow one sequential GC per eligible V8 isolate
  --include-active       Explicitly allow visible/focused/generating or unknown-activity pages; skip playing media
  --allow-unmeasured-peers  Bypass initial unknown-peer veto ONLY with --collect --include-active; shared activity is unverified
  --target TARGET_ID     Collect only this exact web target; refuse an isolate shared with unselected pages
  --max-tabs N           Maximum isolates collected (default 3)
  --min-heap-mb N        Minimum used JS heap per isolate (default 256)
  --state-dir DIR        Private 0700 ledger/report directory (default .chrome-memory)
  --timeout-ms N         Per-command timeout (default 10000)
  --help                Print help without connecting
Unknown prior GC outcomes block that isolate; successful GC has a 10-minute cooldown.
No pages are killed, closed, reloaded or discarded. OS RSS/physical RAM release is not inferred.
`;
export function parseArgs(args:string[]):Options {
  const options:Options={collect:false,includeActive:false,allowUnmeasuredPeers:false,maxTabs:3,minHeapMB:256,stateDir:resolve('.chrome-memory'),timeoutMs:10000};
  const strings:Record<string,'bridgeConfig'|'cdp'|'stateDir'|'target'>={'--bridge-config':'bridgeConfig','--cdp':'cdp','--state-dir':'stateDir','--target':'target'};
  const numbers:Record<string,'maxTabs'|'minHeapMB'|'timeoutMs'>={'--max-tabs':'maxTabs','--min-heap-mb':'minHeapMB','--timeout-ms':'timeoutMs'};
  if(args.includes('--help'))return {...options,help:true};
  for(let index=0;index<args.length;index++) {
    const arg=args[index];
    if(arg==='--collect')options.collect=true;
    else if(arg==='--include-active')options.includeActive=true;
    else if(arg==='--allow-unmeasured-peers')options.allowUnmeasuredPeers=true;
    else if(strings[arg]){const value=args[++index];if(!value||value.startsWith('--'))fault('invalid-options');options[strings[arg]]=value;}
    else if(numbers[arg]){const value=Number(args[++index]);if(!Number.isFinite(value)||(numbers[arg]==='minHeapMB'?value<0:value<=0))fault('invalid-options');options[numbers[arg]]=value;}
    else fault('invalid-options');
  }
  if(options.bridgeConfig&&options.cdp||!Number.isInteger(options.maxTabs)||options.maxTabs>100||!Number.isInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>120000||options.allowUnmeasuredPeers&&(!options.includeActive||!options.collect))fault('invalid-options');
  options.stateDir=resolve(options.stateDir);return options;
}
export async function main(args=process.argv.slice(2)) {
  let connection:ReturnType<typeof connect>|undefined;
  try {
    const options=parseArgs(args);if(options.help){process.stdout.write(HELP);return;}
    const report=await runMemory(options,async(method,params,sessionId)=>{connection??=connect(options);return (await connection).call(method,params,sessionId);});
    const measured=report.groups.filter(group=>finite(Math.abs(group.heapUsedDeltaBytes??NaN)));
    const top=report.groups.slice(0,5).map(group=>{const page=report.pages.find(item=>item.target.targetId===group.targetIds[0]);return {title:String(page?.sample?.guard.title||page?.target.title||'').replace(/\s+/g,' ').slice(0,120),heapUsedBytes:page?.sample?.heap.usedSize,heapAllocatedBytes:page?.sample?.heap.totalSize,reason:group.reason};});
    process.stdout.write(JSON.stringify({mode:report.mode,report:report.reportPath,pages:report.pages.length,collectedIsolates:report.groups.filter(group=>group.gc).length,
      measuredAfterCount:measured.length,heapUsedDeltaBytes:measured.reduce((sum,group)=>sum+group.heapUsedDeltaBytes!,0),heapAllocatedDeltaBytes:measured.reduce((sum,group)=>sum+group.heapAllocatedDeltaBytes!,0),
      allowUnmeasuredPeers:report.allowUnmeasuredPeers,unmeasuredPeerCount:report.unmeasuredPeerCount,sharedActivityUnverified:report.sharedActivityUnverified,
      unknown:report.groups.filter(group=>group.reason==='gc-outcome-unknown').length,errors:report.errors,top})+'\n');
    if(report.errors.length||report.groups.some(group=>group.reason==='gc-outcome-unknown'))process.exitCode=1;
  } catch(error) {process.stderr.write(`Chrome memory: ${code(error)}\n`);process.exitCode=1;}
  finally {if(connection)try{(await connection).close();}catch{/* No raw transport error payloads. */}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
