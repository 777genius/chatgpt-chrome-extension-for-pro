'use strict';
// Trace only observed allocations belonging to recorded handoff operations.
// A matching tab ID or a later URL alone does not carry Goal authorization.
globalThis.ChatGPTGoalLineage=Object.freeze({
  // This is evidence only: the caller must independently verify the manual
  // message and the current Goal before using the resulting path.
  traceManualSuccessor(events,tabId,sourceUrl,handoffId) {
    const canonical=globalThis.ChatGPTGoalPolicy.canonical;
    const source=canonical(sourceUrl),rows=events.filter(e=>e.tabId===tabId);
    const starts=rows.filter(e=>e.kind==='handoff.navigating'&&e.operationId===handoffId&&e.sourceUrl===source);
    const failures=rows.filter(e=>e.kind==='handoff.failed'&&e.operationId===handoffId&&e.sourceUrl===source&&
      e.reason==='Не удалось дождаться готовности нового чата');
    if(!source||starts.length!==1||failures.length!==1||failures[0].sequence<=starts[0].sequence)return null;
    const later=rows.filter(e=>e.sequence>starts[0].sequence),failure=failures[0];
    if(later.some(e=>e.sequence<=failure.sequence&&e.operationId===handoffId&&
      ['handoff.sending','handoff.clicked','handoff.sent','send.authorized','send.dispatched','request.started'].includes(e.kind)))return null;
    const request=later.find(e=>e.sequence>failure.sequence&&e.kind==='request.started');
    if(!request||request.operationId||request.sourceUrl!=='https://chatgpt.com/'||!request.requestId||!Number.isFinite(request.eventAt))return null;
    const allocation=later.find(e=>e.sequence>request.sequence&&e.kind==='tab.updated'&&canonical(e.changes?.url));
    if(!allocation||allocation.operationId)return null;
    let target=canonical(allocation.changes.url);const handoffs=[];
    for(const e of later.filter(e=>e.sequence>allocation.sequence&&e.kind==='handoff.navigating')) {
      if(canonical(e.sourceUrl)!==target||!e.operationId)return null;
      const sent=later.filter(x=>x.kind==='handoff.sent'&&x.operationId===e.operationId&&x.sourceUrl===target&&x.sequence>e.sequence);
      const hop=this.handoffTarget(rows,tabId,e.operationId,target);
      if(sent.length!==1||!hop||hop.targetUrl!==canonical(sent[0].targetUrl)||hop.targetUrl===target)return null;
      target=canonical(sent[0].targetUrl);handoffs.push({id:e.operationId,sourceUrl:e.sourceUrl,targetUrl:target});
    }
    return {sourceUrl:source,manualRequestId:request.requestId,manualStartedAt:request.eventAt,
      firstTargetUrl:canonical(allocation.changes.url),targetUrl:target,handoffs};
  },
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
