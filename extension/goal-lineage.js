'use strict';
// Trace only observed allocations belonging to recorded handoff operations.
// A matching tab ID or a later URL alone does not carry Goal authorization.
globalThis.ChatGPTGoalLineage=Object.freeze({
  handoffTarget(events,tabId,id,sourceUrl) {
    const rows=events.filter(e=>e.tabId===tabId),starts=rows.filter(e=>e.kind==='handoff.navigating'&&e.operationId===id&&e.sourceUrl===sourceUrl);
    if(starts.length!==1)return null;
    const requests=rows.filter(e=>e.sequence>starts[0].sequence&&e.kind==='request.started'&&e.operationId===id&&e.sourceUrl==='https://chatgpt.com/');
    if(requests.length!==1)return null;
    const allocation=rows.find(e=>e.sequence>requests[0].sequence&&e.kind==='tab.updated'&&globalThis.ChatGPTGoalPolicy.canonical(e.changes?.url));
    if(!allocation||allocation.operationId!==id)return null;
    return {id,sourceUrl,targetUrl:globalThis.ChatGPTGoalPolicy.canonical(allocation.changes.url),requestId:requests[0].requestId};
  },
  trace(events,tabId,request) {
    const canonical=globalThis.ChatGPTGoalPolicy.canonical;
    const rows=events.filter(e=>e.tabId===tabId),initial=rows.filter(e=>e.kind==='request.started'&&
      !e.operationId&&e.sourceUrl==='https://chatgpt.com/'&&e.requestId===request?.requestId&&e.eventAt===request.startedAt);
    if(initial.length!==1)return null;
    let originUrl='',targetUrl='',pending=null;const handoffs=[];
    for(const e of rows.filter(e=>e.sequence>initial[0].sequence)) {
      if(e.kind==='handoff.navigating') {
        if(!targetUrl||pending||canonical(e.sourceUrl)!==targetUrl||!e.operationId)return null;
        pending={id:e.operationId,sourceUrl:targetUrl,requestId:null};
      }
      if(pending&&e.kind==='request.started'&&e.sourceUrl==='https://chatgpt.com/') {
        if(e.operationId!==pending.id||pending.requestId)return null;
        pending.requestId=e.requestId;
      }
      const allocated=e.kind==='tab.updated'&&canonical(e.changes?.url);
      if(!allocated||allocated===targetUrl)continue;
      if(!originUrl){originUrl=allocated;targetUrl=allocated;continue;}
      if(!pending||!pending.requestId||e.operationId!==pending.id)return null;
      handoffs.push({...pending,targetUrl:allocated});targetUrl=allocated;pending=null;
    }
    return originUrl&&targetUrl&&!pending?{originUrl,targetUrl,handoffs}:null;
  }
});
