import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createContext,runInContext} from 'node:vm';
const ctx=createContext({TextDecoder,Uint8Array});runInContext(readFileSync('extension/goal-request-proof.js','utf8'),ctx);
const read=runInContext('ChatGPTGoalRequestProof.read',ctx);
const body={action:'next',messages:[{id:'synthetic-user-id-001',author:{role:'user'},content:{content_type:'text',parts:['Exact original goal']}}],secret:'must never be copied'};
const details=(value:unknown)=>({requestBody:{raw:[{bytes:new TextEncoder().encode(JSON.stringify(value)).buffer}]}});
assert.deepEqual(JSON.parse(JSON.stringify(read(details(body)))),{userId:'synthetic-user-id-001',userText:'Exact original goal'});
for(const value of [{...body,action:'continue'},{...body,messages:[...body.messages,...body.messages]},
 {...body,messages:[{...body.messages[0],author:{role:'assistant'}}]},
 {...body,messages:[{...body.messages[0],content:{content_type:'text',parts:['first','second']}}]},
 {...body,messages:[{...body.messages[0],content:{content_type:'text',parts:['x'.repeat(10001)]}}]}])assert.equal(read(details(value)),null);
assert.equal(read({requestBody:{raw:[{bytes:new Uint8Array(262145).buffer}]}}),null);
assert.equal(read({requestBody:{raw:[{file:'not read'}]}}),null);assert.equal(read({}),null);
console.log('Goal request proof: bounded exact user-only body, ambiguous/non-text/oversize refusal and no unrelated body storage passed.');
