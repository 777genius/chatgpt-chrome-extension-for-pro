import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
const {inspectCompletedTurn}=createRequire(import.meta.url)('../extension/completion-probe.js');
const {document,window}=parseHTML('<html><body><section data-app-shell-active-page="true"><article data-content-search-turn-key="turn-0"><div data-chatgpt-search-unit-key="turn-0:0:user"></div></article><article data-content-search-turn-key="turn-1"><div data-chatgpt-search-unit-key="turn-1:0:user"></div></article></section></body></html>');
const rows=[...document.querySelectorAll('article')];
for(const e of document.querySelectorAll('*'))Object.assign(e,{getClientRects:()=>[{width:10,height:10}]});
const entries=rows.map((_,i)=>({id:'turn-'+i,conversationId:'local-native-conversation',isMostRecentTurn:i===1,isReadOnly:false,
 timestampTurns:[{role:'user',sentAtMs:100000+i*20000}],turn:{status:'in_progress',items:[{type:'user-message',messageId:'user-'+i,message:'Message '+i}]}}));
Object.assign(rows[1],{__reactFiber$test:{memoizedProps:{entries},return:null}});
const g=globalThis as any,old={document:g.document,location:g.location};
g.document=document;g.location={origin:'https://chatgpt.com',pathname:'/c/probe-recovery'};
try{
 const n=inspectCompletedTurn('https://chatgpt.com/c/probe-recovery',true,null,100000);
 assert.deepEqual(n.recoveryTimeline.map((u:any)=>u.userId),['user-0','user-1']);
 assert.equal(n.userId,'user-0');assert.equal(n.isLatest,false);assert.equal(n.firstTurn,false,'history recovery does not falsify latest-only allocation evidence');
 assert.equal(inspectCompletedTurn('https://chatgpt.com/c/probe-recovery').recoveryTimeline,undefined,'metadata-only probes never expose sent text');
 const window={notBefore:99000,notAfter:101000,userText:'Message 0',submittedText:'Serialized Message 0'};
 assert.equal(inspectCompletedTurn('https://chatgpt.com/c/probe-recovery',true,null,window).userId,'user-0');
 assert.equal(inspectCompletedTurn('https://chatgpt.com/c/probe-recovery',true,null,{...window,notBefore:100001}).ok,false);
 assert.equal(inspectCompletedTurn('https://chatgpt.com/c/probe-recovery',true,null,{...window,userText:'Different',submittedText:'Also different'}).ok,false);
 entries[1].timestampTurns[0].sentAtMs=100000;entries[1].turn.items[0].message='Message 0';
 assert.equal(inspectCompletedTurn('https://chatgpt.com/c/probe-recovery',true,null,window).reason,'historical-user-ambiguous');
 entries[1].timestampTurns[0].sentAtMs=120000;entries[1].turn.items[0].message='Message 1';
 entries[1].conversationId='other';assert.equal(inspectCompletedTurn('https://chatgpt.com/c/probe-recovery',true,null,100000).recoveryTimeline,null);
 entries[1].conversationId=entries[0].conversationId;entries[1].isReadOnly=true;
 assert.equal(inspectCompletedTurn('https://chatgpt.com/c/probe-recovery',true,null,100000).recoveryTimeline,null);
 entries[1].isReadOnly=false;rows[0].remove();
 assert.equal(inspectCompletedTurn('https://chatgpt.com/c/probe-recovery',true,null,100000).ok,false,'unrendered history cannot authorize recovery');
}finally{g.document=old.document;g.location=old.location;}
console.log('Composer recovery probe: native conversation identity, chronological rendered users, text opt-in, readonly and missing history fences passed.');
