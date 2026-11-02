import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {setImmediate as flush} from 'node:timers/promises';
import {parseHTML} from 'linkedom';
interface Card {cardKey:string;anchorKey:string;ordinal:number|null;taskId:string|null;enabled:boolean|null;current:boolean}
interface Snapshot {url:string;latestAnchorKey:string;latestOrdinal:number|null;cards:Card[]}
interface Change {phase:'none'|'pending'|'unknown'|'resumed';url:string;cardKey:string|null;anchorKey:string|null;taskId:string|null;reason:string}
interface Controller {refresh():void;requestStarted(value?:number|{startedAt:number}):void;dispose():void}
interface Factory {inspect(options:{document?:unknown;url?:string}):Snapshot;create(options:unknown):Controller;pollIntervalMs:number}
const source=readFileSync('extension/deferred-task-status.js','utf8');
const html=(id='card-a',date='Different localized date')=>`<span data-automation-card="true"><button aria-label="Synthetic task" aria-describedby="${id}"><svg><use href="/cdn/assets/new-hash.svg#codex-icon-clock-light-24"></use></svg><span>${date}</span><span>Localized action</span></button></span>`;
function setup(generating=false,body=`<main><div data-turn-key="turn-a"><div data-content-search-turn-key="fallback-turn-0">${html()}</div></div></main>`) {
  const {document,window}=parseHTML(`<html><head></head><body>${body}</body></html>`);
  Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{}],configurable:true});
  let url='https://chatgpt.com/c/fixture-a',clock=1000,alive=true,next=0,generation=generating,generationReads=0;
  const timers=new Map<number,{callback:()=>void;delay:number}>(),changes:Change[]=[];
  const world=createContext({URL});runInContext(source,world);const factory=world.ChatGPTDeferredTaskStatus as Factory;
  const controller=factory.create({document,getUrl:()=>url,onChange:(value:Change)=>changes.push(value),
    isGenerating:()=>{generationReads++;return generation;},alive:()=>alive,now:()=>clock,
    setTimeout:(callback:()=>void,delay:number)=>{const id=++next;timers.set(id,{callback,delay});return id;},clearTimeout:(id:number)=>timers.delete(id)});
  return {document,window,factory,controller,changes,timers,
    setGenerating(value:boolean){generation=value;},setUrl(value:string){url=value;},setTime(value:number){clock=value;},
    poll(){const [id,timer]=timers.entries().next().value!;assert.equal(timer.delay,300000);timers.delete(id);clock+=timer.delay;timer.callback();},
    stop(){alive=false;controller.refresh();},last:()=>changes.at(-1)!,get generationReads(){return generationReads;}};
}
const a=setup();
assert.equal(a.last().phase,'pending');assert.ok(a.last().cardKey&&a.last().anchorKey);assert.equal(a.timers.size,1);
const first=a.last().cardKey,events=a.changes.length;
a.poll();assert.equal(a.changes.length,events,'unchanged five-minute checks do not emit duplicate events');assert.equal(a.timers.size,1);
for(const date of ['2 нояб. 2026 г. · 14:54','Nov 2, 2026, 2:54 PM','٢٠٢٦/١١/٢ ١٤:٥٤']) {
  a.document.querySelector('[data-automation-card] button span')!.textContent=date;a.controller.refresh();
  assert.equal(a.last().phase,'pending');assert.equal(a.last().cardKey,first,'displayed dates never participate in identification or state');
}
const reads=a.generationReads;
const icon=a.document.createElement('link');icon.rel='icon';icon.href='data:image/svg+xml,frame';a.document.head.append(icon);
a.document.querySelector('main')!.append(a.document.createElement('span'));await flush();
assert.equal(a.generationReads,reads,'favicon frames and unrelated stream nodes do not scan the task');
a.controller.dispose();assert.equal(a.timers.size,0);

const initial=setup(true);assert.equal(initial.last().phase,'none','scheduler-creation answer still generating is not a continuation');
assert.equal(initial.timers.size,1);initial.controller.requestStarted(900);assert.equal(initial.last().phase,'none','late setup STARTED must not consume its just-created card');
initial.setGenerating(false);initial.controller.refresh();assert.equal(initial.last().phase,'pending');
initial.setTime(2000);initial.controller.requestStarted(1500);assert.equal(initial.last().phase,'resumed');
assert.ok(initial.last().cardKey);assert.equal(initial.timers.size,0);initial.controller.refresh();assert.equal(initial.last().phase,'resumed','unchanged old card cannot relatch before the new turn mounts');
initial.document.querySelector('[data-automation-card]')!.outerHTML=html('new-task-card');await flush();
assert.equal(initial.last().phase,'pending','a distinct new deferred card can become pending in the same whole turn');initial.controller.dispose();

const missing=setup();const card=missing.document.querySelector('[data-automation-card]')!;card.remove();await flush();
assert.equal(missing.last().phase,'unknown','disappearance alone is not completion or continuation');assert.equal(missing.timers.size,1);
missing.poll();assert.equal(missing.last().phase,'unknown');
missing.document.querySelector('[data-content-search-turn-key]')!.append(card);await flush();assert.equal(missing.last().phase,'pending');
missing.document.querySelector('main')!.insertAdjacentHTML('beforeend','<div data-turn-key="turn-b"><div data-content-search-turn-key="fallback-turn-1">New conversation turn</div></div>');await flush();
assert.equal(missing.last().phase,'resumed');assert.equal(missing.last().reason,'newer-turn');assert.equal(missing.timers.size,0);missing.controller.dispose();

const continuing=setup();continuing.setGenerating(true);continuing.controller.refresh();
assert.equal(continuing.last().phase,'resumed');assert.equal(continuing.last().reason,'generation-started');assert.ok(continuing.last().cardKey);
continuing.setGenerating(false);continuing.controller.refresh();assert.equal(continuing.last().phase,'resumed','an old retained card stays consumed after generation settles');continuing.controller.dispose();

const historical=setup(false,`<main><div data-content-search-turn-key="fallback-turn-0">${html()}</div><div data-content-search-turn-key="fallback-turn-1">Latest turn</div></main>`);
assert.equal(historical.last().phase,'none');assert.equal(historical.last().reason,'historical-card');assert.ok(historical.last().anchorKey);assert.equal(historical.timers.size,0,'historical cards never show a waiting clock');historical.controller.dispose();
const examples=setup(false,`<main><div data-content-search-turn-key="fallback-turn-0"><pre>${html()}</pre><span><svg><use href="/icons.svg#codex-icon-clock-light-24"></use></svg></span></div></main>`);
assert.equal(examples.last().phase,'none');examples.controller.dispose();

const native=setup();const button=native.document.querySelector('button')!;
const automation={id:'synthetic-task-id',type:'chatgpt-automation',isEnabled:true,nextRunAt:undefined};
Object.assign(button,{'__reactFiber$fixture':{memoizedProps:{},return:{memoizedProps:{automation},return:null}}});
let snapshot=native.factory.inspect({document:native.document,url:'https://chatgpt.com/c/fixture-a'});
assert.equal(snapshot.cards[0].taskId,'synthetic-task-id');
assert.equal(snapshot.cards[0].enabled,true);
native.controller.refresh();automation.isEnabled=false;native.poll();assert.equal(native.last().phase,'none');assert.equal(native.last().reason,'task-disabled');assert.equal(native.timers.size,0);
let called=false;Object.assign(button,{'__reactFiber$fixture':{memoizedProps:Object.defineProperty({},'automation',{get(){called=true;throw new Error('Untrusted getter');}}),return:null}});
snapshot=native.factory.inspect({document:native.document,url:'https://chatgpt.com/c/fixture-a'});
assert.equal(called,false,'the probe reads data descriptors instead of executing page getters');assert.equal(snapshot.cards[0].taskId,null);
const standalone=createContext({document:native.document,location:{href:'https://chatgpt.com/c/fixture-a'}});
const isolated=runInContext(`(${native.factory.inspect.toString()})()`,standalone) as Snapshot;
assert.equal(isolated.cards.length,1,'MAIN injection probe has no external closure dependencies');native.controller.dispose();

const route=setup();route.setUrl('https://chatgpt.com/c/fixture-b');route.controller.refresh();
assert.equal(route.last().phase,'none');assert.equal(route.last().url,'https://chatgpt.com/c/fixture-b');assert.equal(route.timers.size,0,'old chat DOM cannot bind a task to a new URL');
route.document.querySelector('main')!.outerHTML=`<main><div data-turn-key="turn-new-b"><div data-content-search-turn-key="fallback-turn-0">${html('task-b')}</div></div></main>`;await flush();
assert.equal(route.last().phase,'pending');assert.equal(route.last().url,'https://chatgpt.com/c/fixture-b');
route.stop();assert.equal(route.timers.size,0);const finalCount=route.changes.length;route.controller.refresh();await flush();assert.equal(route.changes.length,finalCount,'disposed contexts cannot publish late state');
console.log('PASS: locale-independent native automation cards, initial scheduler generation, real continuation, historical/unmounted cards, five-minute bounded poll, MAIN metadata, SPA and disposal.');
