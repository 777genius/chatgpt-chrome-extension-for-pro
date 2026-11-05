import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';

const html=readFileSync(new URL('../extension/popup.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../extension/popup.js',import.meta.url),'utf8');
const inline=readFileSync(new URL('../extension/goal-inline.js',import.meta.url),'utf8');
const {document}=parseHTML(html);
const chrome={
  runtime:{
    sendMessage:async (message:{type:string})=>message.type==='CHATGPT_GOAL_CONTROL'?
      {ok:true,tabId:1,url:'https://chatgpt.com/c/synthetic',record:null}:{ok:true,available:false},
    getURL:(path:string)=>'chrome-extension://synthetic/'+path
  },
  tabs:{create:()=>{}}
};
const ctx=createContext({document,chrome,URL,Blob,setTimeout,console});
runInContext(source,ctx);
const objective=document.getElementById('goal-text') as HTMLTextAreaElement|null;
const followups=document.getElementById('goal-followups');
assert.ok(followups,'popup has a distinct read-only follow-up view');
assert.match(html,/#goal-followups\s*\{[^}]*white-space:pre-wrap/);
assert.match(inline,/\[data-goal-objective\]\{white-space:pre-wrap\}/);
ctx.sample={goal:'Original goal',phase:'waiting',rules:'',continuations:0,maxContinuations:10,
  maxMinutes:60,deadlineAt:3000000,operation:null,
  supplements:[{userText:'Line 1\nLine 2'},{userText:'Second follow-up'}]};
runInContext('showGoal(sample)',ctx);
assert.equal(objective.value,'Original goal','original objective must not be rewritten');
assert.equal(followups.hidden,false);
assert.equal(followups.textContent,'Дополнение 1:\nLine 1\nLine 2\n\nДополнение 2:\nSecond follow-up');
runInContext('showGoal({...sample,supplements:[]})',ctx);
assert.equal(followups.hidden,true,'no stale follow-ups on another goal');
assert.equal(followups.textContent,'');
runInContext('showGoal(null)',ctx);
assert.equal(followups.hidden,true,'clear old chat view');
console.log('Popup and inline Goal supplement rendering: immutable objective, multiline context, reset passed.');
