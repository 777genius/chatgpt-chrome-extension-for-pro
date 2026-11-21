import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

const IO_ERROR='IO error: /x/040152.ldb: Unable to create writable file (ChromeMethodBFE: 9::NewWritableFile::8)';
const load=(chrome:unknown,extra:Record<string,unknown>={})=>{
  const context=createContext({chrome,...extra,console:{warn(){},info(){},error(){}},structuredClone,Object,Date,JSON,Promise,Symbol,Proxy,Reflect});
  runInContext(readFileSync('extension/resilient-storage.js','utf8'),context);
  return context as any;
};
const {ChatGPTStorage:lib}=load(undefined);
assert.equal(lib.status(),null,'without chrome.storage nothing is installed');

function fakePrimary(initial:Record<string,unknown>={}) {
  const data:Record<string,any>={...initial};
  const area:any={data,broken:false,
    async get(keys:any){
      if(keys===null)return structuredClone(data);
      const list=typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(keys);
      const out:Record<string,any>={};
      for(const key of list)if(Object.hasOwn(data,key))out[key]=structuredClone(data[key]);
      if(keys&&typeof keys==='object'&&!Array.isArray(keys))for(const [key,value] of Object.entries(keys))if(!Object.hasOwn(out,key))out[key]=value;
      return out;
    },
    async set(items:any){if(area.broken)throw new Error(IO_ERROR);Object.assign(data,structuredClone(items));},
    async remove(keys:any){if(area.broken)throw new Error(IO_ERROR);for(const key of [].concat(keys))delete data[key];},
    onChanged:{addListener(){}}};
  return area;
}
function fakeOverlay() {
  const rows=new Map<string,any>();
  return {rows,broken:false,
    async entries(){return new Map(rows);},
    async lookup(keys:string[]){return new Map(keys.filter(key=>rows.has(key)).map(key=>[key,rows.get(key)]));},
    async commit(items:[string,any][]){if(this.broken)throw new Error('overlay down');for(const [key,record] of items)rows.set(key,structuredClone(record));},
    async clear(revisions:Map<string,unknown>){for(const [key,rev] of revisions)if(rows.get(key)?.rev===rev)rows.delete(key);},
    async hasRecords(){if(this.unreadable)throw new Error('overlay unreadable');return rows.size>0;},
    unreadable:false};
}
const sharedLock=()=>{let tail:Promise<unknown>=Promise.resolve();return (fn:()=>Promise<unknown>)=>{const run=tail.then(fn);tail=run.catch(()=>{});return run;};};
const make=(primary:any,overlay:any,lock?:any)=>lib.create({primary,overlay,probeIntervalMs:0,...(lock?{lock}:{})});

// A transient synchronous open failure must not poison the cached connection.
// Until the overlay can be inspected, preserve the existing write fence.
{
  let opens=0;
  const indexedDB={open(){
    if(++opens===1)throw new Error('Synthetic IndexedDB temporarily unavailable');
    const request:any={result:{transaction(){
      const tx:any={objectStore:()=>({openKeyCursor(){
        const cursor:any={};
        queueMicrotask(()=>{cursor.onsuccess({target:{result:null}});tx.oncomplete();});
        return cursor;
      }})};
      return tx;
    }}};
    queueMicrotask(()=>request.onsuccess());
    return request;
  }};
  const primary=fakePrimary({intent:'previous operation'});
  const overlay=lib.createIndexedDbOverlay({indexedDB}),store=make(primary,overlay);
  assert.deepEqual(await store.get('intent'),{intent:'previous operation'});
  assert.equal(store.status().unknown,true,'failed startup inspection keeps the overlay unknown');
  await store.set({intent:'new persisted operation'});
  assert.equal(opens,2,'the next write retries IndexedDB.open after its synchronous failure');
  assert.equal(store.status().unknown,false);
  assert.deepEqual(await store.get('intent'),{intent:'new persisted operation'});
}

assert.equal(lib.isStorageFault(new Error(IO_ERROR)),true,'the sticky LevelDB failure is classified');
assert.equal(lib.isStorageFault(new Error('QUOTA_BYTES quota exceeded')),false,'quota and argument errors are not storage faults');
{
  const primary=fakePrimary(),overlay=fakeOverlay(),store=make(primary,overlay);
  await store.set({a:1});
  assert.deepEqual(await store.get('a'),{a:1});
  assert.equal(overlay.rows.size,0,'a healthy store never touches the overlay');
}
{
  const primary=fakePrimary({old:1,gone:2}),overlay=fakeOverlay(),store=make(primary,overlay);
  primary.broken=true;
  await store.set({journal:{seq:5},old:9});
  await store.remove(['gone']);
  assert.equal(store.status().degraded,true);
  assert.deepEqual(await store.get(['journal','old','gone']),{journal:{seq:5},old:9},'reads merge overlay writes and deletes over the primary store');
  assert.deepEqual(await store.get({gone:'default',missing:7}),{gone:'default',missing:7},'a deleted key falls back to its default');
  assert.deepEqual(await store.get(null),{journal:{seq:5},old:9});
  assert.equal(primary.data.old,1,'the primary store is untouched while degraded');
}
{
  const primary=fakePrimary(),overlay=fakeOverlay(),store=make(primary,overlay);
  primary.set=async()=>{throw new Error('QUOTA_BYTES quota exceeded');};
  await assert.rejects(store.set({a:1}),/QUOTA_BYTES/,'non-fault errors keep their original behavior');
  assert.equal(store.status().degraded,false);
  assert.equal(overlay.rows.size,0);
}
{
  const primary=fakePrimary(),overlay=fakeOverlay(),store=make(primary,overlay);
  primary.broken=true;overlay.broken=true;
  await assert.rejects(store.set({a:1}),/IO error/,'when the overlay fails too the original error rejects, so automatic sends stay blocked');
  assert.equal(store.status().degraded,false);
  const bare=fakePrimary();bare.broken=true;
  await assert.rejects(make(bare,null).set({a:1}),/IO error/,'no overlay available behaves like plain chrome.storage.local');
}
{
  const primary=fakePrimary({gone:1,keep:1}),overlay=fakeOverlay(),store=make(primary,overlay);
  primary.broken=true;
  await store.set({keep:2,fresh:3});
  await store.remove('gone');
  primary.broken=false;
  await store.set({later:4});
  assert.equal(store.status().degraded,false,'the next write probes the primary store and recovers');
  assert.equal(overlay.rows.size,0,'the overlay is cleared after the copy-back');
  assert.deepEqual(primary.data,{keep:2,fresh:3,later:4},'copy-back applies sets and deletes before the new write');
}
{
  const primary=fakePrimary(),overlay=fakeOverlay(),store=make(primary,overlay);
  primary.broken=true;
  await store.set({a:1});
  primary.broken=false;
  const realSet=primary.set;let writes=0;
  primary.set=async(items:any)=>{writes++;if(writes===2)throw new Error(IO_ERROR);return realSet(items);};
  await store.set({b:2});
  assert.equal(store.status().degraded,true,'a failed copy-back keeps the overlay authoritative');
  assert.deepEqual(await store.get(['a','b']),{a:1,b:2});
}
{
  const primary=fakePrimary({x:1}),overlay=fakeOverlay();
  overlay.rows.set('x',{value:5});
  primary.broken=true;
  const store=make(primary,overlay);
  assert.deepEqual(await store.get('x'),{x:5},'leftover overlay data wins over the stale primary value after a restart');
  assert.equal(store.status().degraded,true);
  primary.broken=false;
  await store.recover();
  assert.equal(store.status().degraded,false);
  assert.deepEqual(primary.data,{x:5});
}
{
  const primary=fakePrimary(),overlay=fakeOverlay(),store=make(primary,overlay);
  primary.broken=true;
  await Promise.all(Array.from({length:20},(_,index)=>store.set({counter:index})));
  assert.deepEqual(await store.get('counter'),{counter:19},'concurrent writes during a fault keep submission order');
}
// Several contexts (service worker, popup) each own a wrapper over the same stores.
{
  // A context that never heard about the overlay must not write past it and be overwritten by the copy-back.
  const primary=fakePrimary(),overlay=fakeOverlay(),lock=sharedLock();
  const popup=make(primary,overlay,lock),worker=make(primary,overlay,lock);
  primary.broken=true;
  await worker.set({k:1});
  primary.broken=false;
  await popup.set({k:2});
  assert.equal(primary.data.k,2,'a stale-healthy context drains the overlay before writing, so older records never overwrite newer ones');
  assert.equal(overlay.rows.size,0);
}
{
  // Concurrent copy-back from two contexts and a write that lands meanwhile: nothing is lost or rolled back.
  const primary=fakePrimary(),overlay=fakeOverlay(),lock=sharedLock();
  const worker=make(primary,overlay,lock);
  primary.broken=true;
  await worker.set({meta:{sequence:149},intent:'op-1'});
  primary.broken=false;
  const popup=make(primary,overlay,lock);
  await Promise.all([popup.recover(),worker.set({intent:'op-2 persisted before click'}),worker.set({meta:{sequence:150}}),popup.recover()]);
  assert.deepEqual(await worker.get(['meta','intent']),{meta:{sequence:150},intent:'op-2 persisted before click'});
  assert.deepEqual(await popup.get(['meta','intent']),{meta:{sequence:150},intent:'op-2 persisted before click'});
  assert.equal(overlay.rows.size,0);
}
{
  // Even if a record were changed by a context outside the lock, a record that changed after the copy-back snapshot is kept, never cleared.
  const primary=fakePrimary(),overlay=fakeOverlay(),store=make(primary,overlay);
  primary.broken=true;
  await store.set({k:'old'});
  primary.broken=false;
  const realSet=primary.set;
  primary.set=async(items:any)=>{await realSet(items);if(Object.hasOwn(items,'k'))overlay.rows.set('k',{value:'newer',rev:'other-context'});};
  assert.equal(await store.recover(),false,'a changed record keeps the store degraded');
  assert.equal(store.status().degraded,true);
  primary.set=realSet;
  assert.equal(await store.recover(),true);
  assert.equal(primary.data.k,'newer','the newer record is copied on the next pass');
}
{
  // An overlay that cannot be read is unknown, not empty: writes are refused rather than risk being overtaken.
  const primary=fakePrimary({a:1}),overlay=fakeOverlay();
  overlay.unreadable=true;
  const store=make(primary,overlay);
  await assert.rejects(store.set({a:2}),/overlay unreadable/);
  assert.equal(primary.data.a,1,'the primary store is untouched while the overlay state is unknown');
  assert.deepEqual(await store.get('a'),{a:1},'reads still work');
  overlay.unreadable=false;
  await store.set({a:3});
  assert.equal(primary.data.a,3,'writes resume as soon as the overlay is readable again');
}
{
  // A failed install (non-configurable storage.local) must never break service worker start.
  const chrome:any={storage:Object.freeze({local:fakePrimary()})};
  const {ChatGPTStorage:failed}=load(chrome);
  assert.equal(failed.status(),null);
}
{
  // Deterministic version of the rollback race: the popup's copy-back has taken its snapshot and is
  // about to write it when the worker persists a newer record. Without the Web Lock the stale snapshot lands last.
  const scenario=async(lock:any)=>{
    const primary=fakePrimary(),overlay=fakeOverlay(),worker=make(primary,overlay,lock);
    primary.broken=true;
    await worker.set({meta:{sequence:149},intent:'op-1'});
    primary.broken=false;
    let release!:()=>void,reached!:()=>void,gated=false;
    const gate=new Promise<void>(resolve=>{release=resolve;}),atGate=new Promise<void>(resolve=>{reached=resolve;});
    const realSet=primary.set;
    primary.set=async(items:any)=>{if(Object.hasOwn(items,'intent')&&!gated){gated=true;reached();await gate;}return realSet(items);};
    const popup=make(primary,overlay,lock);
    await atGate;
    const newer=worker.set({intent:'op-2 persisted before click'});
    await new Promise(resolve=>setTimeout(resolve,25));
    release();
    await newer;await popup.recover();
    return {primary,overlay};
  };
  const shared=await scenario(sharedLock());
  assert.equal(shared.primary.data.intent,'op-2 persisted before click','a newer record is never rolled back by another context\'s copy-back');
  assert.equal(shared.overlay.rows.size,0);
  const {ChatGPTStorage:withLocks}=load(undefined,{navigator:globalThis.navigator});
  assert.ok(globalThis.navigator?.locks,'Node provides navigator.locks');
  const realLocks=await (async()=>{
    const primary=fakePrimary(),overlay=fakeOverlay(),make2=()=>withLocks.create({primary,overlay,probeIntervalMs:0});
    const worker=make2();primary.broken=true;
    await worker.set({meta:{sequence:149},intent:'op-1'});primary.broken=false;
    let release!:()=>void,reached!:()=>void,gated=false;
    const gate=new Promise<void>(resolve=>{release=resolve;}),atGate=new Promise<void>(resolve=>{reached=resolve;});
    const realSet=primary.set;
    primary.set=async(items:any)=>{if(Object.hasOwn(items,'intent')&&!gated){gated=true;reached();await gate;}return realSet(items);};
    const popup=make2();await atGate;
    const newer=worker.set({intent:'op-2'});await new Promise(resolve=>setTimeout(resolve,25));release();await newer;await popup.recover();
    return primary.data.intent;
  })();
  assert.equal(realLocks,'op-2','the default navigator.locks lock serializes the two wrappers as well');
}
console.log('Resilient storage: fault classification, overlay writes/deletes, merged reads, copy-back and fail-closed fences passed.');

{
  const area=fakePrimary({seed:1});
  const chrome:any={storage:{local:area}};
  const {ChatGPTStorage:installed}=load(chrome);
  const decorated=chrome.storage.local;
  assert.notEqual(decorated,area,'chrome.storage.local is decorated in place');
  assert.equal(decorated.onChanged,area.onChanged,'members other than get/set/remove are delegated');
  await decorated.set({a:1});
  assert.deepEqual(await decorated.get('a'),{a:1});
  assert.equal(installed.install(),installed.install(),'installing twice returns one store and never double-wraps');
  assert.equal(chrome.storage.local,decorated);
  area.broken=true;
  await assert.rejects(decorated.set({b:2}),/IO error/,'without an overlay (no IndexedDB) a storage fault still rejects');
}
console.log('Resilient storage install: in-place decoration, delegation and idempotence passed.');
