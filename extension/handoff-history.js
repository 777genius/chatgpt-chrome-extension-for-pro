'use strict';
// Keep only native user-facing history. An automatic user message is removed
// solely when its exact payload and native timestamp match one durable send
// and request; identical user-authored text is not enough to suppress it.
globalThis.ChatGPTHandoffHistory = (() => {
  function select(messages, events, sourceUrl, limit=20) {
    const eligible=events.filter(e=>e.sourceUrl===sourceUrl);
    const automatic=[];
    for(const send of eligible.filter(e=>e.kind==='send.dispatched'&&e.operationId&&typeof e.text==='string'&&e.text)) {
      const same=eligible.filter(e=>e.operationId===send.operationId&&e.tabId===send.tabId);
      const intents=same.filter(e=>['goal.send_intent','retry.send_intent'].includes(e.kind));
      const authorized=same.filter(e=>e.kind==='send.authorized');
      const requests=same.filter(e=>e.kind==='request.started'&&Number.isFinite(e.eventAt));
      if(intents.length!==1||authorized.length!==1||requests.length!==1)continue;
      const request=requests[0];
      const nearbyManual=eligible.some(e=>e.kind==='request.started'&&!e.operationId&&e.tabId===send.tabId&&Number.isFinite(e.eventAt)&&Math.abs(e.eventAt-request.eventAt)<=10000);
      const confirms=same.filter(e=>['goal.confirmed','retry.confirmed'].includes(e.kind));
      if(!nearbyManual)automatic.push({text:send.text,at:request.eventAt,
        userId:confirms.length===1?confirms[0].userId:null,promptKey:confirms.length===1?confirms[0].promptKey:null});
    }
    const candidates=messages.map(message=>message.role==='user'?
      automatic.filter(a=>a.text===message.text&&(a.userId&&message.id===a.userId||
        a.promptKey&&message.promptKey===a.promptKey||Number.isFinite(message.sentAtMs)&&Math.abs(a.at-message.sentAtMs)<=10000)):[]);
    const clean=messages.filter((message,index)=>{
      // Native fallbackMarkdown escapes the underscore in an otherwise exact
      // marker. Preserve explanations and all other assistant content.
      if(message.role==='assistant'&&/^GOAL\\?_(?:COMPLETE|BLOCKED)$/.test(message.text.trim()))return false;
      const matches=candidates[index];
      if(matches.length!==1)return true;
      return candidates.filter(x=>x.includes(matches[0])).length!==1;
    });
    const selected=new Set();
    for(const role of ['user','assistant'])clean.map((item,index)=>({item,index})).filter(x=>x.item.role===role).slice(-limit).forEach(x=>selected.add(x.index));
    return clean.filter((_,index)=>selected.has(index)).map(({role,text,id})=>({role,text,id}));
  }
  return Object.freeze({select});
})();
