import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createContext,runInContext} from 'node:vm';import{parseHTML}from'linkedom';
type V=Record<string,any>;
function fixture(){
 const{document,window}=parseHTML('<html><body><section data-app-shell-active-page="true"><form data-composer-body><div data-composer-markdown contenteditable="true">Continue test</div><div data-composer-attachments><span>context.txt</span></div><button type="submit">Send</button></form></section></body></html>');
 for(const e of document.querySelectorAll('*'))Object.assign(e,{getClientRects:()=>[{width:100,height:20}]});
 const editor=document.querySelector('[contenteditable]')!,form=document.querySelector('form')!,chip=document.querySelector('[data-composer-attachments] span')!;
 const uploading:V={name:'context.txt',size:32,uploadId:'upload-1',status:'uploading',progress:100};
 const ready:V={name:'context.txt',size:32,uploadId:'upload-1',status:'ready',id:'server-file-1'};
 const owner:V={memoizedProps:{attachment:ready},return:null};
 Object.assign(chip,{__reactFiber$fixture:{memoizedProps:{attachment:uploading},return:owner}});
 Object.assign(form,{__reactFiber$controller:{memoizedProps:{composerController:{view:{dom:editor},getPlainText:()=>editor.textContent,getChatGptPrompt:()=>({prompt:editor.textContent}),submitReady:true,pendingSubmit:null}}}});
 let clicks=0;document.querySelector('button')!.addEventListener('click',()=>{clicks++;});
 const ctx=createContext({document,location:{href:'https://chatgpt.com/'},URL,Date,Set,Map});runInContext(readFileSync('extension/page-probe.js','utf8'),ctx);
 const run=(action:string)=>{ctx.options={action,text:'Continue test',url:'https://chatgpt.com/',fileName:'context.txt'};return runInContext('controlChatComposer(options)',ctx);};
 return {document,chip,uploading,ready,owner,run,clicks:()=>clicks};
}
{
 const f=fixture();assert.equal(f.run('inspect-attachment').status,'ready','ready owner with server file ID wins over an obsolete uploading snapshot of the same upload');
 assert.equal(f.run('inspect').ok,true);assert.equal(f.run('send').clicked,true);assert.equal(f.clicks(),1);
}
for(const scenario of ['different-upload','different-name','different-size','no-server-file','conflicting-ready','error','extra-owner-file']){
 const f=fixture();
 if(scenario==='different-upload')f.ready.uploadId='upload-2';
 if(scenario==='different-name')f.ready.name='private.txt';
 if(scenario==='different-size')f.ready.size=99;
 if(scenario==='no-server-file')delete f.ready.id;
 if(scenario==='conflicting-ready')f.owner.return={memoizedProps:{attachment:{...f.ready,id:'another-server-file'}}};
 if(scenario==='error')f.uploading.status='error';
 if(scenario==='extra-owner-file'){
  const e=f.document.createElement('span');e.textContent='private.txt';Object.assign(e,{__reactFiber$owner:{memoizedProps:{attachment:{name:'private.txt',status:'ready',uploadId:'private',id:'private-server-id'}}}});f.chip.parentElement!.append(e);
 }
 assert.notEqual(f.run('inspect-attachment').status,'ready',scenario);assert.equal(f.run('send').ok,false,scenario);assert.equal(f.clicks(),0);
}
{
 const f=fixture();f.owner.memoizedProps.attachment=f.uploading;assert.equal(f.run('inspect-attachment').status,'uploading');assert.equal(f.run('send').ok,false);
}
console.log('Native file readiness: correlated stale/current snapshots, unique upload + server ID, one shared probe for wait/send, identity/error/extra-file fences passed.');
