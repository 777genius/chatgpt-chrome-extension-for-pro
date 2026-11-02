'use strict';

// Chrome worker owns the only durable Goal coordinator. No page script may
// authorize itself to click; the journal's consumed send grant is authoritative.
(function(root) {
  function create({storage,tabs,appendJournal,now=()=>Date.now(),uuid=()=>crypto.randomUUID()}) {
    const policy=root.ChatGPTGoalPolicy;
    if(!policy)throw Error('Goal policy is not loaded');
    let writes=Promise.resolve();
    const serialize=fn=>{
      const task=writes.catch(()=>{}).then(fn);
      writes=task;
      return task;
    };
    const key=url=>'chatgpt-goal:'+policy.canonical(url);
    const canonical=url=>policy.canonical(url);
    const buffered=(record,plural,singular)=>[
      ...(Array.isArray(record?.[plural])?record[plural]:[]),
      ...(record?.[singular]?[record[singular]]:[])
    ];
    function requireUrl(url) {
      const value=canonical(url);
      if(!value)throw Error('Goal доступен только в сохранённом чате ChatGPT');
      return value;
    }
    async function read(url) {
      const path=requireUrl(url),name=key(path);
      return (await storage.get(name))[name]||null;
    }
    async function save(record) {await storage.set({[key(record.url)]:record});}
    function view(record) {
      if(!record)return null;
      const {operation, ...safe}=record;
      return {...safe,operation:operation?{id:operation.id,kind:operation.kind,status:operation.status,createdAt:operation.createdAt}:null};
    }
    async function event(kind,record,tabId,details={}) {
      await appendJournal({kind:'goal.'+kind,sourceUrl:record.url,operationId:record.operation?.id||record.id,
        goalId:record.id,phase:record.phase,continuations:record.continuations,reason:record.reason||'',...details},
        {id:tabId,url:record.url});
    }
    function operation(record,kind,tabId,time) {
      return {id:uuid(),kind,text:kind==='initial'?policy.initialText(record):policy.continuationText(record),
        tabId,createdAt:time,status:'reserved'};
    }
    function canSend(record,tabId,id,operationId,phase) {
      return !!record&&record.id===id&&record.url&&record.operation?.id===operationId&&
        record.operation.tabId===tabId&&record.phase===phase&&!record.pauseRequested&&!record.stopRequested;
    }
    async function deliver(record) {
      if(!record?.operation)return;
      const op=record.operation;
      try {
        const tab=await tabs.get(op.tabId);
        if(canonical(tab.url)!==record.url)throw Error('Вкладка перешла в другой чат');
        const result=await tabs.sendMessage(op.tabId,{type:'CHATGPT_GOAL_DISPATCH',
          url:record.url,goalId:record.id,operationId:op.id,text:op.text});
        if(!result?.ok)throw Error('Обработчик Goal недоступен во вкладке');
      } catch(error) {
        await report({url:record.url,tabId:op.tabId,id:record.id,operationId:op.id,status:'blocked',
          reason:'Goal dispatch: '+String(error?.message||error)}).catch(()=>{});
      }
    }
    async function get(url) {
      return serialize(async()=>{
        let record=await read(url);
        if(!record)return null;
        if(record.operation&&['sending','clicked'].includes(record.phase)&&
            now()-record.operation.createdAt>120000) {
          record={...record,phase:'blocked',
            reason:'Неподтверждённая отправка пережила перезапуск; автоматический повтор запрещён'};
          await event('blocked',record,record.operation.tabId);
          await save(record);
        } else if(['preparing','waiting','paused','recovering'].includes(record.phase)&&now()>=record.deadlineAt) {
          record={...record,phase:'stopped',operation:null,pendingSendKind:null,reason:'Время Goal истекло'};
          await event('stopped',record,null);
          await save(record);
        }
        return view(record);
      });
    }
    async function start({url,tabId,goal,rules,maxContinuations,maxMinutes}) {
      const target=requireUrl(url),config=policy.settings({goal,rules,maxContinuations,maxMinutes});
      const result=await serialize(async()=>{
        const previous=await read(target);
        if(previous?.operation)throw Error('Предыдущая отправка не подтверждена; для нового Goal используйте другой чат или вручную разберите журнал');
        if(previous&&!['completed','stopped','moved'].includes(previous.phase))
          throw Error('Для этого чата уже запущена цель. Сначала остановите её');
        const time=now();
        const record={schema:1,id:uuid(),url:target,originUrl:target,goal:config.goal,rules:config.rules,
          maxContinuations:config.maxContinuations,maxMinutes:config.maxMinutes,deadlineAt:time+config.maxMinutes*60000,
          startedAt:time,phase:'preparing',reason:'',continuations:0,expectedPromptKey:null,
          lastCompletionKey:'',pendingCompletion:null,pauseRequested:false,stopRequested:false,
          handoffPending:false,handoffId:null,operation:null};
        record.operation=operation(record,'initial',tabId,time);
        await event('started',record,tabId,{maxContinuations:record.maxContinuations,deadlineAt:record.deadlineAt});
        await save(record);
        return record;
      });
      await deliver(result);
      return {ok:true,record:view(await getRaw(target))};
    }
    async function getRaw(url) {return serialize(()=>read(url));}
    async function recoverTab(tab) {
      const url=canonical(tab?.url);
      if(!url||typeof tab?.id!=='number')return {ok:false};
      const pending=await serialize(async()=>{
        const current=await read(url);
        return current?.earlyCompletion&&['waiting','paused'].includes(current.phase)?current.earlyCompletion:null;
      });
      if(pending) {
        // completion() already dispatches the continuation when appropriate.
        // Falling through to reserved recovery would send a second dispatch
        // message for the same operation ID during this worker startup.
        await completion(pending);
        return {ok:true,replayed:true};
      }
      const record=await serialize(async()=>{
        const current=await read(url);
        if(!current||current.phase!=='preparing'||current.operation?.status!=='reserved'||
            current.operation.tabId!==tab.id||current.stopRequested||current.pauseRequested)return null;
        if(now()>=current.deadlineAt) {
          const expired={...current,phase:'stopped',operation:null,reason:'Время Goal истекло'};
          await event('stopped',expired,tab.id);
          await save(expired);
          return null;
        }
        return current;
      });
      if(!record)return {ok:false};
      // Same operation ID only, never a new intent. A second receiver will
      // inspect the worker grant again and cannot repeat an already claimed send.
      await deliver(record);
      return {ok:true};
    }
    async function control({action,url,tabId}) {
      const target=requireUrl(url);
      const outcome=await serialize(async()=>{
        const old=await read(target);
        if(!old)throw Error('Сохранённая цель не найдена');
        if(action==='pause') {
          if(['completed','stopped','blocked','moved'].includes(old.phase))throw Error('Goal уже завершён');
          const inFlight=['sending','clicked'].includes(old.phase);
          const ready=old.phase==='preparing'&&old.operation?.status==='reserved';
          const record={...old,phase:inFlight?old.phase:'paused',pauseRequested:inFlight,
            ...(ready?{pendingSendKind:old.operation.kind,operation:null}:{}),
            reason:inFlight?'Пауза после подтверждения текущей отправки':'Приостановлено пользователем'};
          await event('paused',record,tabId);
          await save(record);
          return {record};
        }
        if(action==='stop') {
          if(old.phase==='moved')throw Error('Остановите цель в новом чате');
          const inFlight=['sending','clicked'].includes(old.phase);
          const record={...old,phase:inFlight?old.phase:'stopped',stopRequested:inFlight,
            ...(old.phase==='preparing'||(old.phase==='blocked'&&old.operation?.status==='reserved')?{operation:null,pendingSendKind:null}:{}),
            reason:inFlight?'Остановка после исхода текущей отправки':old.phase==='blocked'?
              'Явно остановлено после неизвестного исхода; проверьте журнал перед новым запуском':'Остановлено пользователем'};
          await event(inFlight||old.operation?'stop_requested':'stopped',record,tabId);
          await save(record);
          return {record};
        }
        if(action==='resume') {
          if(old.phase!=='paused'||old.operation)
            throw Error('Нельзя безопасно возобновить неподтверждённую отправку. Остановите цель и разберите журнал');
          if(now()>=old.deadlineAt)throw Error('Временной лимит Goal исчерпан');
          if(old.manualOverride) {
            // An explicit Resume after a real manual intervention is a fresh
            // user authorization, but the current chat must be idle first.
            const ready=await tabs.sendMessage(tabId,{type:'CHATGPT_GOAL_READINESS',url:target});
            if(!ready?.ok||ready.idle!==true)throw Error(ready?.reason||'Дождитесь завершения ручного ответа и очистите черновик');
          }
          let record={...old,phase:'waiting',pauseRequested:false,manualOverride:false,reason:''};
          if(old.pendingSendKind) {
            record={...record,phase:'preparing',pendingSendKind:null,
              operation:operation(record,old.pendingSendKind,tabId,now())};
          } else if(old.pendingCompletion) {
            record={...record,pendingCompletion:null};
            if(record.continuations>=record.maxContinuations) {
              record={...record,phase:'stopped',reason:'Лимит продолжений исчерпан'};
            } else {
              record={...record,phase:'preparing',operation:operation(record,'continuation',tabId,now())};
            }
          } else if(old.manualOverride) {
            record={...record,phase:'preparing',operation:operation(record,'continuation',tabId,now())};
          }
          await event('resumed',record,tabId);
          await save(record);
          return {record,dispatch:record.phase==='preparing'};
        }
        throw Error('Неизвестное действие Goal');
      });
      if(outcome.dispatch)await deliver(outcome.record);
      return {ok:true,record:view(await getRaw(target))};
    }
    async function check({url,tabId,id,operationId,phase='preparing'}) {
      return serialize(async()=>{
        const record=await read(url);
        return {ok:canSend(record,tabId,id,operationId,phase)};
      });
    }
    async function intent({url,tabId,id,operationId,text,baselineKey}) {
      return serialize(async()=>{
        const record=await read(url);
        if(!canSend(record,tabId,id,operationId,'preparing')||record.operation.text!==text)
          throw Error('Нет разрешённой подготовки Goal');
        if(now()>=record.deadlineAt)throw Error('Время Goal истекло');
        // Persist before journal grant: a crash cannot reset the claim to pending.
        const next={...record,phase:'sending',
          operation:{...record.operation,status:'intent',baselineKey:typeof baselineKey==='string'?baselineKey:''}};
        await save(next);
        await appendJournal({kind:'goal.send_intent',sourceUrl:record.url,operationId,
          goalId:id,text,promptKey:baselineKey||''},{id:tabId,url:record.url});
        return {ok:true};
      });
    }
    async function authorize({url,tabId,id,operationId,text}) {
      return serialize(async()=>{
        const record=await read(url);
        if(!canSend(record,tabId,id,operationId,'sending')||record.operation.text!==text)
          throw Error('Goal отправка более не разрешена');
        return {ok:true};
      });
    }
    async function report({url,tabId,id,operationId,status,reason='',newPromptKey=''}) {
      const result=await serialize(async()=>{
        const record=await read(url);
        if(!record||record.id!==id||record.operation?.id!==operationId||
            record.operation.tabId!==tabId)return {ok:false,reason:'Операция Goal изменена'};
        if(status==='clicked') {
          if(!['sending','clicked'].includes(record.phase))return {ok:false};
          const next={...record,phase:'clicked',operation:{...record.operation,status:'clicked'}};
          await event('clicked',next,tabId);
          await save(next);
          return {ok:true,record:view(next)};
        }
        if(status==='confirmed') {
          if(!['sending','clicked'].includes(record.phase))return {ok:false};
          const expectedPrefix=new URL(record.url).pathname+'|';
          if(typeof newPromptKey!=='string'||!newPromptKey.startsWith(expectedPrefix)||
              newPromptKey===record.operation.baselineKey)
            throw Error('Не подтверждено новое пользовательское сообщение Goal');
          const stop=record.stopRequested,pause=record.pauseRequested;
          const early=buffered(record,'earlyCompletions','earlyCompletion')
            .find(item=>item.promptKey===newPromptKey)||null;
          const next={...record,phase:stop?'stopped':pause?'paused':'waiting',
            reason:stop?'Остановлено пользователем':pause?'Приостановлено пользователем':'',
            expectedPromptKey:newPromptKey,handoffPending:false,operation:null,
            earlyCompletion:stop?null:early,earlyCompletions:[],
            continuations:record.continuations+(record.operation.kind==='continuation'?1:0)};
          await event('confirmed',next,tabId,{operationId,promptKey:newPromptKey});
          await save(next);
          return {ok:true,record:view(next),replay:early&&!stop?early:null};
        }
        if(status==='blocked') {
          if(!['preparing','sending','clicked','paused'].includes(record.phase))return {ok:false};
          const next={...record,phase:'blocked',reason:String(reason||'Исход отправки неизвестен').slice(0,500)};
          await event('blocked',next,tabId,{operationId,reason:next.reason});
          await save(next);
          return {ok:true,record:view(next)};
        }
        return {ok:false,reason:'Неподдерживаемый результат Goal'};
      });
      // A fast answer may finish before the asynchronous send-ack arrives. Keep
      // the response durably bound to the operation, then process after the
      // confirmed new user turn. Recovery can replay the same record safely.
      if(result.replay)await completion(result.replay);
      return {ok:result.ok,record:result.replay?await get(url):result.record,reason:result.reason};
    }
    async function completion({url,tabId,completionKey,promptKey,response,nativeVerified,rawExact,userId}) {
      const target=canonical(url);
      if(!target||typeof completionKey!=='string'||!completionKey||typeof promptKey!=='string'||
          !completionKey.startsWith(promptKey+'|')||typeof response!=='string')return {ok:false};
      const result=await serialize(async()=>{
        const record=await read(target);
        if(!record||record.lastCompletionKey===completionKey)return {ok:false};
        if(['sending','clicked'].includes(record.phase)&&record.operation?.tabId===tabId&&
            record.operation.status!=='reserved'&&nativeVerified===true&&
            promptKey!==record.operation.baselineKey&&
            promptKey.startsWith(new URL(target).pathname+'|')&&typeof userId==='string'&&userId) {
          const saved=buffered(record,'earlyCompletions','earlyCompletion');
          if(saved.some(item=>item.completionKey===completionKey))return {ok:false};
          const next={...record,earlyCompletion:null,
            earlyCompletions:[...saved,{url:target,tabId,completionKey,promptKey,response,
              nativeVerified,rawExact,userId}].slice(-6)};
          await event('completion_staged',next,tabId,{completionKey,promptKey});
          await save(next);
          return {ok:true,staged:true};
        }
        if(!['waiting','paused'].includes(record.phase)||record.operation||
            (!record.handoffPending&&record.expectedPromptKey!==promptKey)||
            (record.handoffPending&&(!record.handoffAcceptedUserId||userId!==record.handoffAcceptedUserId)))
          return {ok:false};
        const outcome=policy.decision(record,response,rawExact,nativeVerified,now());
        let next={...record,lastCompletionKey:completionKey,expectedPromptKey:promptKey,
          handoffPending:false,earlyCompletion:null,earlyCompletions:[]};
        if(outcome==='unverified')next={...next,phase:'blocked',reason:'Нативная целостность финального ответа не подтверждена'};
        else if(outcome==='complete')next={...next,phase:'completed',reason:'Модель ответила точным маркером GOAL_COMPLETE'};
        else if(outcome==='budget'||outcome==='deadline')
          next={...next,phase:'stopped',reason:outcome==='budget'?'Лимит продолжений исчерпан':'Время Goal истекло'};
        else if(record.phase==='paused')next={...next,pendingCompletion:{key:completionKey,promptKey},reason:'Ожидает возобновления'};
        else next={...next,phase:'preparing',operation:operation(record,'continuation',tabId,now()),pendingCompletion:null,reason:''};
        await event(outcome==='continue'?'answer_continue':'answer_'+outcome,next,tabId,
          {completionKey,promptKey,nativeVerified:nativeVerified===true,exactMarker:outcome==='complete'});
        await save(next);
        return {ok:true,record:next,dispatch:next.phase==='preparing'};
      });
      if(result.dispatch)await deliver(result.record);
      return {ok:result.ok,record:view(await getRaw(target))};
    }
    async function manual({url,tabId}) {
      const target=canonical(url);
      if(!target)return {ok:false};
      return serialize(async()=>{
        const record=await read(target);
        if(!record||!['preparing','sending','clicked','waiting','recovering','paused'].includes(record.phase))
          return {ok:false};
        const inFlight=['sending','clicked'].includes(record.phase);
        const reserved=record.phase==='preparing'&&record.operation?.status==='reserved';
        const next={...record,phase:inFlight?record.phase:'paused',pauseRequested:inFlight,
          manualOverride:!inFlight,
          ...(reserved?{pendingSendKind:record.operation.kind,operation:null}:{}),
          reason:inFlight?'Ожидается исход отправки; ручное действие имеет приоритет':'Пауза: ручная отправка пользователя'};
        await event('manual_pause',next,tabId);
        await save(next);
        return {ok:true};
      });
    }
    async function retry({url,tabId,kind,promptKey,goalHandoff=false}) {
      const target=canonical(url);
      if(!target)return;
      await serialize(async()=>{
        const record=await read(target);
        if(!record||!['waiting','recovering','paused'].includes(record.phase))return;
        if(kind==='retry.blocked'&&goalHandoff)return; // new-chat recovery is not a failed Goal
        let next=record;
        if(kind==='retry.planned')next={...record,phase:record.phase==='paused'?'paused':'recovering'};
        if(kind==='retry.confirmed'&&typeof promptKey==='string'&&promptKey.startsWith(new URL(target).pathname+'|'))
          next={...record,phase:record.phase==='paused'?'paused':'waiting',expectedPromptKey:promptKey};
        if(['retry.failed','retry.blocked'].includes(kind))
          next={...record,phase:'blocked',reason:'Восстановление запроса завершилось ошибкой'};
        if(next===record)return;
        await event('recovery',next,tabId,{recoveryKind:kind});
        await save(next);
      });
    }
    async function handoffBegin({sourceUrl,handoffId,tabId}) {
      const source=canonical(sourceUrl);
      if(!source)return;
      await serialize(async()=>{
        const record=await read(source);
        if(!record||['completed','stopped','blocked','moved'].includes(record.phase))return;
        // The handoff record is persisted before the Goal phase. A worker can
        // stop in between; GET must be able to replay this exact transition.
        if(record.phase==='handoff'&&record.handoffId===handoffId)return;
        if(!['waiting','paused','recovering'].includes(record.phase))throw Error('Goal отправляет сообщение; handoff остановлен');
        const next={...record,preHandoffPhase:record.phase,phase:'handoff',handoffId};
        await event('handoff_begin',next,tabId,{handoffId});
        await save(next);
      });
    }
    async function stageHandoffCompletion({sourceUrl,targetUrl,handoffId,tabId,completionKey,promptKey,response,nativeVerified,rawExact,userId}) {
      const source=canonical(sourceUrl),target=canonical(targetUrl);
      if(!source||!target||source===target||!handoffId||!userId||nativeVerified!==true||
          !completionKey?.startsWith(promptKey+'|')||
          !promptKey?.startsWith(new URL(target).pathname+'|')||typeof response!=='string')return {ok:false};
      return serialize(async()=>{
        const old=await read(source);
        if(!old||old.phase!=='handoff'||old.handoffId!==handoffId)return {ok:false};
        const saved=buffered(old,'handoffEarlyCompletions','handoffEarlyCompletion');
        if(saved.some(item=>item.completionKey===completionKey))return {ok:false};
        const next={...old,handoffEarlyCompletion:null,
          handoffEarlyCompletions:[...saved,{url:target,tabId,completionKey,promptKey,response,
            nativeVerified,rawExact,userId}].slice(-6)};
        await event('handoff_completion_staged',next,tabId,{handoffId,completionKey,promptKey});
        await save(next);
        return {ok:true};
      });
    }
    async function handoffConfirm({sourceUrl,targetUrl,handoffId,tabId,acceptedUserId}) {
      const source=canonical(sourceUrl),target=canonical(targetUrl);
      if(!source||!target||source===target)return;
      const early=await serialize(async()=>{
        const old=await read(source);
        const existing=await read(target);
        if(existing?.id===old?.id&&old?.phase==='moved')
          return existing.earlyCompletion||null;
        if(!old||old.phase!=='handoff'||old.handoffId!==handoffId)return null;
        if(typeof acceptedUserId!=='string'||!acceptedUserId)
          throw Error('Нативный ID перенесённого пользовательского сообщения не подтверждён');
        if(existing&&!['completed','stopped','blocked','moved'].includes(existing.phase))
          throw Error('В новом чате уже есть другая активная цель');
        const retained=buffered(old,'handoffEarlyCompletions','handoffEarlyCompletion')
          .find(item=>item.userId===acceptedUserId&&item.url===target)||null;
        const moved={...old,phase:'moved',reason:'Цель перенесена в '+target,
          operation:null,handoffEarlyCompletion:null,handoffEarlyCompletions:[]};
        const next={...old,url:target,phase:old.preHandoffPhase==='paused'?'paused':'waiting',
          reason:'',expectedPromptKey:null,handoffPending:true,handoffAcceptedUserId:acceptedUserId,
          operation:null,pendingCompletion:null,earlyCompletion:retained,earlyCompletions:[],
          handoffEarlyCompletion:null,handoffEarlyCompletions:[]};
        await event('handoff_confirmed',next,tabId,{sourceUrl:source,targetUrl:target,handoffId});
        await storage.set({[key(source)]:moved,[key(target)]:next});
        return retained;
      });
      // If an answer completed between native handoff acceptance and Goal
      // transfer, process its saved proof once. It stays on the target Goal for
      // recovery if execution stops before this replay.
      if(early)await completion(early);
    }
    return Object.freeze({get,start,recoverTab,control,check,intent,authorize,report,completion,manual,retry,handoffBegin,handoffConfirm,stageHandoffCompletion,
      context:async url=>{const record=await getRaw(url);return record&&!['moved','completed','stopped','blocked'].includes(record.phase)?policy.handoffText(record):'';}});
  }
  const api=Object.freeze({create});
  root.ChatGPTGoalStore=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
