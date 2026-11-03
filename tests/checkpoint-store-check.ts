import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const storage:Record<string,unknown>={};
const context=createContext({chrome:{storage:{local:{get:async(key:string)=>structuredClone({[key]:storage[key]}),set:async(values:Record<string,unknown>)=>Object.assign(storage,structuredClone(values))}}}});
runInContext(readFileSync('extension/completion-checkpoint.js','utf8'),context);
const run=(text:string)=>runInContext(text,context) as Promise<any>;
await run("completionCheckpointIntent(7,{url:'https://chatgpt.com/c/a',at:100,baselineKey:'/c/a|old'})");
await run("completionCheckpointStart(7,{url:'https://chatgpt.com/c/a',startedAt:101,requestId:'request-a'})");
assert.equal((await run('completionCheckpointRead(7)')).baselineKey,'/c/a|old');
assert.equal(await run("completionCheckpointUpdate(7,{url:'https://chatgpt.com/c/a',startedAt:101,requestId:'request-a',promptKey:'/c/a|old'})"),false,'the old answer cannot become the new bound prompt');
assert.equal(await run("completionCheckpointUpdate(7,{url:'https://chatgpt.com/c/a',startedAt:101,requestId:'request-a',promptKey:'/c/a|new'})"),true);
assert.equal(await run("completionCheckpointUpdate(7,{url:'https://chatgpt.com/c/b',startedAt:101,requestId:'request-a',promptKey:'/c/a|new'})"),false,'route changes cannot move a checkpoint to another chat');
assert.equal(await run("completionCheckpointFinish(7,101,'stopped','request-a')"),true);
assert.equal(await run("completionCheckpointUpdate(7,{url:'https://chatgpt.com/c/a',startedAt:101,requestId:'request-a',promptKey:'/c/a|new'})"),false,'stopped attempt cannot be resurrected by a delayed bound write');
await run("completionCheckpointStart(7,{url:'https://chatgpt.com/c/a',startedAt:200,requestId:'request-b'})");
assert.equal(await run("completionCheckpointFinish(7,101,'complete')"),false,'a stale terminal receipt cannot close a newer send');
await run("completionCheckpointStart(7,{url:'https://chatgpt.com/c/a',startedAt:100,requestId:'late-a'})");
assert.equal((await run('completionCheckpointRead(7)')).requestId,'request-b','delayed old request start cannot replace a newer attempt');
assert.equal(await run("completionCheckpointFinish(7,200,'complete','request-b')"),true);
assert.equal(await run("completionCheckpointFinish(7,200,'complete','request-b')"),false,'terminal completion is claimed at most once');
console.log('Checkpoint store: protected baseline, bound prompt, route, stop, newer request and terminal fences passed.');

const allocating={state:'active',url:'https://chatgpt.com/',startedAt:100000,baselineKey:'',promptKey:''};
const native={ok:true,url:'https://chatgpt.com/c/new',firstTurn:true,firstUserSentAtMs:99990,isLatest:true,isReadOnly:false,hasError:false,userId:'user',promptKey:'/c/new|user',turnStatus:'complete',generating:false,assistantCompleted:true,assistantPhase:'final_answer',assistantId:'answer',assistantKey:'answer-key'};
context.allocating=allocating;context.native=native;
assert.equal((await run("completionAllocationEvidence(allocating,native.url,native)")).promptKey,native.promptKey);
for(const patch of [{firstTurn:false},{firstUserSentAtMs:null},{firstUserSentAtMs:80000},{hasError:true},{isReadOnly:true},{assistantCompleted:false},{generating:true}]){
 context.native={...native,...patch};assert.equal(await run('completionAllocationEvidence(allocating,native.url,native)'),null,'unbound history/error cannot adopt the request');
}
context.native=native;
for(const patch of [{baselineKey:'/|old'},{baselineKey:null},{state:'stopped'},{promptKey:'/c/other|user'},{url:'https://chatgpt.com/c/other'},{startedAt:NaN}]){
 context.allocating={...allocating,...patch};assert.equal(await run('completionAllocationEvidence(allocating,native.url,native)'),null);
}
console.log('New-chat allocation: first native user timing, empty baseline, completed evidence and route fences passed.');
