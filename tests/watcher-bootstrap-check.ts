import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
type Bootstrap={ensure():Promise<boolean>};
const world=createContext({});
runInContext(readFileSync('extension/watcher-bootstrap.js','utf8'),world);
const factory=world.ChatGPTWatcherBootstrap as {create(options:{session:any;version:string;install:()=>Promise<void>}):Bootstrap};
const store:Record<string,unknown>={};
const session={get:async(key:string)=>({[key]:store[key]}),set:async(value:Record<string,unknown>)=>Object.assign(store,value)};
let calls=0;
const boot=()=>factory.create({session,version:'fixture',install:async()=>{calls++;}});
const first=boot();await Promise.all([first.ensure(),first.ensure(),first.ensure()]);
assert.equal(calls,1,'boot and install/startup events share one tab attachment pass');
await boot().ensure();assert.equal(calls,1,'a fresh suspended worker preserves the session marker');
delete store['chatgpt-watchers:attached'];
await boot().ensure();assert.equal(calls,2,'a same-version full reload reattaches existing tabs');
delete store['chatgpt-watchers:attached'];
let fail=true;
const failed=factory.create({session,version:'fixture',install:async()=>{if(fail)throw Error('Transient attachment failure');calls++;}});
await assert.rejects(failed.ensure());assert.equal(store['chatgpt-watchers:attached'],undefined,'a failed pass is never marked ready');
fail=false;await failed.ensure();assert.equal(calls,3,'a failed read-only attachment can recover');
console.log('Watcher bootstrap: full reload reattach, suspension skip, concurrent events and failure recovery passed.');

// Execute the real attachment pass: failed obsolete cleanup cannot prevent
// replacement of same-version listeners in the existing isolated world.
const workerSource=readFileSync('extension/service-worker.js','utf8');
const installSource=workerSource.slice(workerSource.indexOf('async function installErrorWatchers()'),workerSource.indexOf('\nconst watcherBootstrap='));
assert.ok(installSource);
let injected=false;
const attachment=createContext({console,journalInBackground:()=>{},__chatgptNotifierVersion:'same',__chatgptNotifierDispose:()=>{throw Error('Invalidated old context');},chrome:{tabs:{query:async()=>[{id:7,url:'https://chatgpt.com/c/fixture'}]},scripting:{executeScript:async(options:any)=>{if(options.func)return options.func();injected=options.files.includes('content-script.js');}}}});
await runInContext(installSource+'\ninstallErrorWatchers()',attachment);
assert.equal(injected,true,'same-version scripts reattach even when obsolete disposal throws');
assert.equal(attachment.__chatgptNotifierVersion,null);
assert.equal(attachment.__chatgptNotifierDispose,null);
