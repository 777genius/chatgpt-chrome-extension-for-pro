import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';
const {document}=parseHTML('<html><body><main data-content-search-turn-key="fallback-turn-0"><div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">Finished background task</div><aside role="alert" class="text-danger">配信できませんでした</aside></main></body></html>');
const alert=document.querySelector('aside')! as any;
const entry={id:'fallback-turn-0',isMostRecentTurn:true,isReadOnly:false,showRequestUserInputStatus:true,showPendingLoadingMessage:false,errorMessage:alert.textContent,turn:{status:'complete',items:[{type:'assistant-message',messageId:'assistant-id',completed:true}]}};
alert.__reactFiber$fixture={memoizedProps:{entry},return:null};
const context=createContext({URL,document,location:{href:'https://chatgpt.com/c/delivery',origin:'https://chatgpt.com',pathname:'/c/delivery'}});
runInContext(readFileSync('extension/page-probe.js','utf8'),context);
const action=()=>runInContext('inspectChatError(0,false).action',context);
assert.equal(action(),'retry','a completed assistant-only turn may still carry an exact native input-delivery error');
entry.turn.status='in_progress';assert.equal(action(),'retry');entry.turn.status='complete';
for(const [key,value] of [['isMostRecentTurn',false],['isReadOnly',true],['showRequestUserInputStatus',false],['showPendingLoadingMessage',true],['errorMessage','different error']] as const){
 const object=entry as Record<string,any>,prior=object[key];object[key]=value;assert.equal(action(),'unknown',key);object[key]=prior;
}
entry.turn.status='unknown';assert.equal(action(),'unknown','unrecognized native statuses fail closed');
assert.equal(document.querySelectorAll('button').length,0,'classification requires no translated button text');
console.log('Assistant-only input delivery: complete/in-progress native states, exact error and latest/writable/input/pending fences passed.');
