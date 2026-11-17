import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

const IO_ERROR='IO error: /x/040152.ldb: Unable to create writable file (ChromeMethodBFE: 9::NewWritableFile::8)';
const load=(chrome:unknown)=>{
  const context=createContext({chrome,console:{warn(){},info(){}},structuredClone,Object,Date,JSON,Promise,Symbol,Proxy,Reflect});
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
    async clear(keys:string[]){for(const key of keys)rows.delete(key);},
    async size(){return rows.size;}};
}
const make=(primary:any,overlay:any)=>lib.create({primary,overlay,probeIntervalMs:0});

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
