import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';
interface State {ok:boolean;url:string;revision:number;status:null|{kind:'error'|'success'}}
interface Indicator {accept(state:State):boolean;refresh():Promise<void>;dispose():void}
interface Factory {create(options:unknown):Indicator}
const source=readFileSync('extension/status-indicator.js','utf8');
const {document,window}=parseHTML('<html><head><link rel="icon" href="native.ico"></head><body></body></html>');
const native=document.querySelector('link')!;
let url='https://chatgpt.com/c/alpha',alive=true;
const pending:Array<{url:string;resolve:(value:State)=>void}>=[];
const world=createContext({URL});runInContext(source,world);
const indicator=(world.ChatGPTStatusIndicator as Factory).create({document,getUrl:()=>url,alive:()=>alive,
 load:(requested:string)=>new Promise<State>(resolve=>pending.push({url:requested,resolve}))});
const state=(kind:'error'|'success'|null,revision:number,chat=url):State=>({ok:true,url:chat,revision,status:kind?{kind}:null});
const tick=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
const owned=()=>document.querySelector('link[data-chatgpt-notifier-status]');
pending.shift()!.resolve(state('error',1));await tick();
assert.ok(owned());
assert.equal(decodeURIComponent(owned()!.getAttribute('href')!.split(',')[1]),readFileSync('extension/icons/status-error.svg','utf8').trim());
assert.equal(native.getAttribute('href'),'native.ico');
const visit=indicator.refresh();pending.shift()!.resolve(state('error',1));await visit;
assert.ok(owned(),'visiting does not acknowledge the indicator');
assert.equal(indicator.accept(state('success',2)),true);await tick();
assert.equal(decodeURIComponent(owned()!.getAttribute('href')!.split(',')[1]),readFileSync('extension/icons/status-success.svg','utf8').trim());
const replacement=document.createElement('link');replacement.rel='icon';replacement.href='new-native.ico';document.head.append(replacement);await tick();
assert.equal(document.head.querySelectorAll('link[rel~="icon"]')[2],owned(),'status stays last after native favicon changes');
assert.equal(document.querySelectorAll('[data-chatgpt-notifier-status]').length,1);
indicator.accept(state(null,3));await tick();assert.equal(owned(),null);
assert.equal(indicator.accept(state('error',2)),false,'late status cannot undo manual acknowledgement');
assert.equal(native.getAttribute('href'),'native.ico');assert.equal(replacement.href,'new-native.ico');
const oldRequest=indicator.refresh();const old=pending.shift()!;
url='https://chatgpt.com/c/beta';const newRequest=indicator.refresh();const next=pending.shift()!;
next.resolve(state('success',1));await newRequest;old.resolve(state('error',10,'https://chatgpt.com/c/alpha'));await oldRequest;
assert.match(decodeURIComponent(owned()!.getAttribute('href')!),/#16a34a/,'old chat response must not recolor current chat');
assert.equal(indicator.accept(state('error',20,'https://chatgpt.com/c/alpha')),false);
url='https://chatgpt.com/c/alpha';const back=indicator.refresh();pending.shift()!.resolve(state(null,3));await back;assert.equal(owned(),null);
indicator.accept(state('error',4));alive=false;replacement.href='again.ico';await tick();assert.equal(owned(),null,'invalidated runtime disposes old icon observer');
assert.equal(indicator.accept(state('success',5)),false);indicator.dispose();
assert.equal(document.querySelectorAll('link').length,2,'native favicon links are preserved');
console.log('Status favicon: colors, reading/manual reset, native updates, SPA races and disposal passed.');
// document_start may run before head exists. Bootstrap observes only until head
// appears, then scopes observation to head so conversation mutations cost nothing.
const early=parseHTML('<html><head></head><body></body></html>');early.document.head.remove();
let lateHead:ReturnType<typeof early.document.createElement>|null=null;
Object.defineProperty(early.document,'head',{get:()=>lateHead,configurable:true});
const earlyWorld=createContext({URL});runInContext(source,earlyWorld);
const earlyIndicator=(earlyWorld.ChatGPTStatusIndicator as Factory).create({document:early.document,getUrl:()=>url,load:async()=>state('error',1)});
await tick();assert.equal(early.document.querySelector('[data-chatgpt-notifier-status]'),null);
const head=early.document.createElement('head');lateHead=head;early.document.documentElement.prepend(head);await tick();
assert.ok(head.querySelector('[data-chatgpt-notifier-status]'),'status appears when head becomes available');
earlyIndicator.dispose();
