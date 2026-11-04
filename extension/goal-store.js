'use strict';

// Chrome worker owns the only durable Goal coordinator. No page script may
// authorize itself to click; the journal's consumed send grant is authoritative.
(function(root) {
  function create({storage,tabs,appendJournal,now=()=>Date.now(),uuid=()=>crypto.randomUUID(),beforeDispatch=async record=>{}}) {
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
    const composerKey=tabId=>'chatgpt-goal-composer:'+tabId;
    const composerBindingKey=id=>'chatgpt-goal-composer-binding:'+id;
    const buffered=(record,plural,singular)=>[
      ...(Array.isArray(record?.[plural])?record[plural]:[]),
      ...(record?.[singular]?[record[singular]]:[])
    ];
    function requireUrl(url) {
      const value=canonical(url);
      if(!value)throw Error('Goal доступен только в сохранённом чате ChatGPT');
      return value;
    }
    function requireTab(tabId) {
      if(!Number.isInteger(tabId)||tabId<0)throw Error('Вкладка Goal не подтверждена');
      return tabId;
    }
    function requirePage(url) {
      const value=policy.pageUrl(url);
      if(!value)throw Error('Goal доступен только на странице чата ChatGPT');
      return value;
    }
    function requireAvailable(previous) {
      if(previous?.operation)throw Error('Предыдущая отправка не подтверждена; для нового Goal используйте другой чат или вручную разберите журнал');
      if(previous&&!['completed','stopped','moved'].includes(previous.phase))
        throw Error('Для этого чата уже запущена цель. Сначала остановите её');
    }
    async function read(url) {
      const path=requireUrl(url),name=key(path);
      return (await storage.get(name))[name]||null;
    }
    async function save(record) {await storage.set({[key(record.url)]:record});}
    async function readComposer(tabId) {
      const name=composerKey(requireTab(tabId));
      return (await storage.get(name))[name]||null;
    }
    async function composerGet({tabId}) {return serialize(()=>readComposer(tabId));}
    async function composerArm({tabId,url,rules,maxContinuations,maxMinutes}) {
      requireTab(tabId);
      const target=requirePage(url);
      const config=policy.composerSettings({rules,
        ...(maxContinuations===undefined?{}:{maxContinuations}),
        ...(maxMinutes===undefined?{}:{maxMinutes})});
      return serialize(async()=>{
        const previous=await readComposer(tabId);
        if(previous?.phase==='bound') {
          const boundUrl=previous.binding?.url;
          const bound=boundUrl?await read(boundUrl):null;
          if(bound?.id!==previous.id||bound.operation||
              !['completed','stopped','moved'].includes(bound.phase))
            throw Error('Предыдущая ручная цель ещё активна; сначала явно выключите Goal');
        } else if(previous?.phase==='intent') {
          if(!canonical(previous.url)||previous.url===target)
            throw Error('Ручная отправка Goal уже ожидает подтверждения; сначала явно выключите Goal');
          // Explicit arming on a different page cancels only an unbound saved
          // source intent. Root allocation and same-chat outcomes stay fenced.
          await event('composer_superseded',previous,tabId,{oldArmId:previous.id,oldIntent:previous.intent,
            targetUrl:target,reason:'Явное включение Goal в другом чате отменило непривязанное намерение'});
        }
        if(previous?.phase==='armed'&&previous.url===target&&
            JSON.stringify(previous.config)===JSON.stringify(config))return {ok:true,record:previous};
        const record={schema:1,id:uuid(),phase:'armed',url:target,config,armedAt:now()};
        await storage.set({[composerKey(tabId)]:record});
        return {ok:true,record};
      });
    }
    async function composerDisarm({tabId,armId}) {
      requireTab(tabId);
      return serialize(async()=>{
        const current=await readComposer(tabId);
        if(armId!==undefined&&current?.id!==armId)throw Error('Разрешение Goal уже изменилось');
        const changes={[composerKey(tabId)]:null};
        let stopped=null;
        if(current?.phase==='bound'&&current.binding?.url) {
          const goal=await read(current.binding.url);
          if(goal?.id===current.id&&!['completed','stopped','moved'].includes(goal.phase)) {
            stopped=stopTransition(goal);
            await event(stopped.stopRequested||goal.operation?'stop_requested':'stopped',stopped,tabId);
            changes[key(goal.url)]=stopped;
          }
        }
        await storage.set(changes);
        return {ok:true,record:null,...(stopped?{goal:view(stopped)}:{})};
      });
    }
    async function composerIntent({tabId,url,armId,eventAt,text,baselineKey}) {
      requireTab(tabId);
      const target=requirePage(url);
      return serialize(async()=>{
        const current=await readComposer(tabId);
        if(!current||current.id!==armId||current.url!==target)
          throw Error('Разрешение ручной отправки Goal изменилось');
        if(['intent','bound'].includes(current.phase)) {
          const prior=current.intent;
          if(prior?.eventAt===eventAt&&prior.text===text&&prior.baselineKey===baselineKey)
            return {ok:true,record:current};
          throw Error('Другая ручная отправка Goal уже ожидает подтверждения');
        }
        if(current.phase!=='armed'||!Number.isFinite(eventAt)||eventAt<current.armedAt||
            eventAt>now()||now()-eventAt>10000)
          throw Error('Ручная отправка Goal не относится к свежему включению');
        if(typeof text!=='string'||!text.trim()||text.length>10000||typeof baselineKey!=='string')
          throw Error('Ручная цель должна содержать точный текст до 10000 символов');
        if(baselineKey&&(target==='https://chatgpt.com/'||!baselineKey.startsWith(new URL(target).pathname+'|')))
          throw Error('Исходное сообщение Goal относится к другому чату');
        const record={...current,phase:'intent',intent:{text,eventAt,baselineKey}};
        await storage.set({[composerKey(tabId)]:record});
        return {ok:true,record};
      });
    }
    // Keep the observed request with the consent intent, independent of the
    // bounded session cache. This grants no click and never adopts draft text.
    async function composerRequest({tabId,armId,requestId,startedAt,url}) {
      requireTab(tabId);
      return serialize(async()=>{
        const current=await readComposer(tabId),intent=current?.intent;
        if(current?.id!==armId||current.phase!=='intent'||!intent||
            typeof requestId!=='string'||!requestId||!Number.isFinite(startedAt)||
            startedAt<intent.eventAt||startedAt-intent.eventAt>10000||
            (url&&requirePage(url)!==current.url))return {ok:false};
        const request={requestId,startedAt,url:url||current.url};
        if(current.request)return {ok:JSON.stringify(current.request)===JSON.stringify(request),record:current};
        const record={...current,request};
        await storage.set({[composerKey(tabId)]:record});
        return {ok:true,record};
      });
    }
    async function composerBind({tabId,armId,url,requestId,startedAt,promptKey,userId,userText,userVisibleText,userSentAtMs,firstTurn,nativeVerified,recovery}) {
      requireTab(tabId);
      const target=requireUrl(url);
      return serialize(async()=>{
        const current=await readComposer(tabId),intent=current?.intent;
        if(!current||current.id!==armId||!['intent','bound'].includes(current.phase)||!intent)
          throw Error('Нет сохранённого намерения ручной отправки Goal');
        if(current.request&&(current.request.requestId!==requestId||current.request.startedAt!==startedAt))
          throw Error('Ручная отправка Goal уже связана с другим запросом');
        if(nativeVerified!==true||typeof requestId!=='string'||!requestId||typeof userId!=='string'||!userId||
            !Number.isFinite(startedAt)||startedAt<intent.eventAt||startedAt-intent.eventAt>10000||
            !Number.isFinite(userSentAtMs)||Math.abs(userSentAtMs-startedAt)>10000||
            typeof userText!=='string'||!userText.trim()||userText.length>10000||
            !policy.submittedTextMatches(intent.text,userText,userVisibleText)||
            typeof promptKey!=='string'||promptKey===intent.baselineKey||
            !promptKey.startsWith(new URL(target).pathname+'|'))
          throw Error('Нативная ручная отправка Goal не подтверждена точным запросом и текстом');
        const supplements=[];
        if(recovery!==undefined) {
          if(recovery?.nativeVerified!==true||recovery.firstUserId!==userId||!Array.isArray(recovery.supplements)||recovery.supplements.length>100)
            throw Error('История ручной цели не подтверждена');
          let previousAt=startedAt;
          const ids=new Set([userId]),requests=new Set([requestId]);
          for(const item of recovery.supplements) {
            if(!item||typeof item.userId!=='string'||!item.userId||ids.has(item.userId)||
                typeof item.requestId!=='string'||!item.requestId||requests.has(item.requestId)||
                !Number.isFinite(item.startedAt)||item.startedAt<=previousAt||!Number.isFinite(item.userSentAtMs)||
                Math.abs(item.userSentAtMs-item.startedAt)>10000||typeof item.userText!=='string'||!item.userText.trim()||
                item.userText.length>10000||typeof item.promptKey!=='string'||!item.promptKey.startsWith(new URL(target).pathname+'|'))
              throw Error('Дополнения ручной цели не подтверждены в исходном порядке');
            ids.add(item.userId);requests.add(item.requestId);previousAt=item.startedAt;
            supplements.push({...item,tabId,text:item.userText,eventAt:Math.min(item.startedAt,item.userSentAtMs)});
          }
        }
        if(current.url==='https://chatgpt.com/'?firstTurn!==true&&recovery?.firstUserId!==userId:current.url!==target)
          throw Error('Ручная отправка Goal относится к другому чату или не является первым сообщением');
        // Native Markdown may retain link targets absent from the visible
        // composer text. The worker proves the exact rendered submitted turn;
        // keep both forms so a replay cannot substitute a different payload.
        const binding={url:target,requestId,startedAt,promptKey,userId,userSentAtMs,
          userText,userVisibleText:typeof userVisibleText==='string'?userVisibleText:null,
          ...(recovery?{recovery}: {})};
        const sameBinding=value=>value&&Object.keys(binding).every(name=>name==='recovery'?
          JSON.stringify(value[name])===JSON.stringify(binding[name]):value[name]===binding[name]);
        const name=composerBindingKey(armId),prior=(await storage.get(name))[name];
        const previous=await read(target);
        if(current.phase==='bound') {
          if(!sameBinding(current.binding)||!sameBinding(prior)||prior.tabId!==tabId||previous?.id!==armId||previous.goal!==userText)
            throw Error('Разрешение Goal уже связано с другой отправкой или более новой целью');
          return {ok:true,record:current,goal:view(previous)};
        }
        if(prior)throw Error('Разрешение Goal уже связано с другим чатом');
        requireAvailable(previous);
        const record={...current,phase:'bound',binding};
        const next={schema:1,id:armId,url:target,originUrl:target,goal:userText,rules:current.config.rules,
          maxContinuations:current.config.maxContinuations,maxMinutes:current.config.maxMinutes,
          startedAt,manualStartedAt:supplements.at(-1)?.startedAt||startedAt,deadlineAt:startedAt+current.config.maxMinutes*60000,phase:'waiting',reason:'',continuations:0,
          expectedPromptKey:supplements.at(-1)?.promptKey||promptKey,lastCompletionKey:'',pendingCompletion:null,pauseRequested:false,stopRequested:false,
          ...(recovery?{supplements}:{}),
          handoffPending:false,handoffId:null,operation:null,manualStart:{...binding,tabId,sourceUrl:current.url}};
        await event('manual_started',next,tabId,{text:userText,intentText:intent.text,userVisibleText:binding.userVisibleText,rules:next.rules,
          maxContinuations:next.maxContinuations,maxMinutes:next.maxMinutes,deadlineAt:next.deadlineAt,
          requestId,startedAt,promptKey,userId,userSentAtMs,composerSourceUrl:current.url,
          ...(recovery?{recoveredSupplements:supplements}: {})});
        await storage.set({[key(target)]:next,[composerKey(tabId)]:record,[name]:{...binding,tabId}});
        return {ok:true,record,goal:view(next)};
      });
    }
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
      if(kind==='continuation'&&record.continuations>=record.maxContinuations)
        throw Error('Лимит продолжений исчерпан');
      return {id:uuid(),kind,text:kind==='initial'?policy.initialText(record):policy.continuationText(record),
        tabId,createdAt:time,status:'reserved'};
    }
    function stopTransition(old) {
      const inFlight=['sending','clicked'].includes(old.phase);
      return {...old,phase:inFlight?old.phase:'stopped',stopRequested:inFlight,
        ...(old.phase==='preparing'||(old.phase==='blocked'&&old.operation?.status==='reserved')?{operation:null,pendingSendKind:null}:{}),
        reason:inFlight?'Остановка после исхода текущей отправки':old.phase==='blocked'?
          'Явно остановлено после неизвестного исхода; проверьте журнал перед новым запуском':'Остановлено пользователем'};
    }
    function canSend(record,tabId,id,operationId,phase) {
      return !!record&&record.id===id&&record.url&&record.operation?.id===operationId&&
        record.operation.tabId===tabId&&record.phase===phase&&!record.pauseRequested&&!record.stopRequested&&!record.manualPending&&
        !(record.manualSupplementBinding?.startedAt>record.operation.createdAt);
    }
    async function deliver(record) {
      if(!record?.operation)return;
      const op=record.operation;
      try {
        // Native title dialogs must finish before a continuation touches the composer.
        await beforeDispatch(record);
        // A pause/stop/new operation during the native dialog wins.
        if(!(await check({url:record.url,tabId:op.tabId,id:record.id,operationId:op.id})).ok)return;
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
        requireAvailable(previous);
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
          const handoff=old.phase==='handoff';
          const record={...old,phase:inFlight||handoff?old.phase:'paused',pauseRequested:inFlight,
            ...(handoff?{preHandoffPhase:'paused'}:{}),
            ...(ready?{pendingSendKind:old.operation.kind,operation:null}:{}),
            reason:inFlight?'Пауза после подтверждения текущей отправки':'Приостановлено пользователем'};
          await event('paused',record,tabId);
          await save(record);
          return {record};
        }
        if(action==='stop') {
          if(old.phase==='moved')throw Error('Остановите цель в новом чате');
          const inFlight=['sending','clicked'].includes(old.phase);
          const record=stopTransition(old);
          await event(inFlight||old.operation?'stop_requested':'stopped',record,tabId);
          await save(record);
          return {record};
        }
        if(action==='resume') {
          if(old.phase==='handoff'&&old.preHandoffPhase==='paused') {
            if(now()>=old.deadlineAt)throw Error('Временной лимит Goal исчерпан');
            const record={...old,preHandoffPhase:'waiting',pauseRequested:false,reason:''};
            await event('resumed',record,tabId);
            await save(record);
            return {record};
          }
          const recoveryBlocked=old.phase==='blocked'&&!old.operation&&
            old.reason==='Восстановление запроса завершилось ошибкой';
          if((old.phase!=='paused'&&!recoveryBlocked)||old.operation)
            throw Error('Нельзя безопасно возобновить неподтверждённую отправку. Остановите цель и разберите журнал');
          if(now()>=old.deadlineAt)throw Error('Временной лимит Goal исчерпан');
          if(old.manualOverride||recoveryBlocked) {
            // An explicit Resume after a real manual intervention is a fresh
            // user authorization, but the current chat must be idle first.
            const ready=await tabs.sendMessage(tabId,{type:'CHATGPT_GOAL_READINESS',url:target});
            if(!ready?.ok||ready.idle!==true)throw Error(ready?.reason||'Дождитесь завершения ручного ответа и очистите черновик');
          }
          let record={...old,phase:'waiting',pauseRequested:false,manualOverride:false,reason:''};
          const pendingKind=old.manualPending?null:old.pendingSendKind||
            (old.pendingCompletion||old.manualOverride||recoveryBlocked?'continuation':null);
          if(pendingKind) {
            record={...record,pendingSendKind:null,pendingCompletion:null};
            record=pendingKind==='continuation'&&record.continuations>=record.maxContinuations
              ?{...record,phase:'stopped',reason:'Лимит продолжений исчерпан'}
              :{...record,phase:'preparing',operation:operation(record,pendingKind,tabId,now())};
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
    async function retryPreparation({url,tabId,id,operationId}) {
      const outcome=await serialize(async()=>{
        const record=await read(url),op=record?.operation;
        if(record?.id!==id||record.phase!=='blocked'||op?.id!==operationId||op.tabId!==tabId||
            op.status!=='reserved'||record.pauseRequested||record.stopRequested||record.manualOverride||
            record.manualPending||now()>=record.deadlineAt)return {ok:false};
        const next={...record,phase:'preparing',reason:'',operation:{...op,createdAt:now()}};
        await event('preparation_retried',next,tabId);await save(next);
        return {ok:true,record:next};
      });
      if(outcome.ok)await deliver(outcome.record);
      return {ok:outcome.ok};
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
    async function report({url,tabId,id,operationId,status,reason='',newPromptKey='',nativeConfirmed=false}) {
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
          if(!['sending','clicked'].includes(record.phase)&&!(record.phase==='blocked'&&nativeConfirmed===true&&
              ['intent','clicked'].includes(record.operation.status)))return {ok:false};
          const expectedPrefix=new URL(record.url).pathname+'|';
          if(typeof newPromptKey!=='string'||!newPromptKey.startsWith(expectedPrefix)||
              newPromptKey===record.operation.baselineKey)
            throw Error('Не подтверждено новое пользовательское сообщение Goal');
          const stop=record.stopRequested,pause=record.pauseRequested;
          const manual=record.manualSupplementBinding;
          const newerManual=manual&&manual.startedAt>record.operation.createdAt;
          const expected=newerManual?manual.promptKey:newPromptKey;
          const early=newerManual?record.earlyCompletion:buffered(record,'earlyCompletions','earlyCompletion')
            .find(item=>item.promptKey===newPromptKey)||null;
          const next={...record,phase:stop?'stopped':pause?'paused':'waiting',
            reason:stop?'Остановлено пользователем':pause?'Приостановлено пользователем':'',
            expectedPromptKey:expected,handoffPending:false,operation:null,
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
        if(record?.manualPending) {
          const pending=record.manualPending;
          if(nativeVerified!==true||pending.tabId!==tabId||promptKey===pending.baselineKey||!promptKey.startsWith(new URL(target).pathname+'|')||!userId)return {ok:false};
          const saved=buffered(record,'manualEarlyCompletions','manualEarlyCompletion');
          if(saved.some(item=>item.completionKey===completionKey))return {ok:false};
          const next={...record,manualEarlyCompletion:null,manualEarlyCompletions:[...saved,{url:target,tabId,completionKey,promptKey,response,nativeVerified,rawExact,userId}].slice(-6)};
          await event('manual_completion_staged',next,tabId,{completionKey,promptKey});await save(next);return {ok:true,staged:true};
        }
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
    async function manual({url,tabId,startedAt,requestId,eventAt,text,baselineKey}) {
      const target=canonical(url);
      if(!target)return {ok:false};
      return serialize(async()=>{
        const record=await read(target);
        if(record&&Number.isFinite(startedAt)&&Math.max(record.startedAt||0,record.manualStartedAt||0)>startedAt)return {ok:false};
        if(record&&Number.isFinite(startedAt)&&record.manualStart?.startedAt===startedAt)return {ok:false};
        if(!record||!['preparing','sending','clicked','waiting','recovering','paused'].includes(record.phase))return {ok:false};
        const supplement=typeof requestId==='string'&&requestId&&Number.isFinite(startedAt)&&Number.isFinite(eventAt)&&
          startedAt>=eventAt&&startedAt-eventAt<=10000&&typeof text==='string'&&text.trim()&&text.length<=10000&&
          typeof baselineKey==='string'&&(!baselineKey||baselineKey.startsWith(new URL(target).pathname+'|'));
        if(supplement) {
          const prior=record.manualPending||record.manualSupplementBinding;
          if(prior?.requestId===requestId) {
            if(prior.startedAt!==startedAt||prior.text!==text||prior.eventAt!==eventAt||prior.baselineKey!==baselineKey)
              throw Error('Ручное дополнение уже связано с другим текстом');
            return {ok:true,record:view(record)};
          }
          if(startedAt<=(record.manualStartedAt||0))return {ok:false};
          const inFlight=['sending','clicked'].includes(record.phase),paused=record.phase==='paused'||record.pauseRequested;
          const next={...record,phase:inFlight?record.phase:paused?'paused':'waiting',manualStartedAt:startedAt,
            manualPending:{tabId,requestId,startedAt,eventAt,text,baselineKey},manualOverride:false,
            pendingCompletion:null,pendingSendKind:null,earlyCompletion:null,earlyCompletions:[],
            ...(!inFlight?{operation:null}:{}),reason:'Подтверждается отправленное дополнение к цели'};
          await event('manual_supplement_pending',next,tabId,{requestId,startedAt,eventAt,text,baselineKey});
          await save(next);return {ok:true,record:view(next)};
        }
        // Explicit manual Stop remains a pause. Missing/invalid sent-text proof
        // cannot silently change an objective or authorize another send.
        const inFlight=['sending','clicked'].includes(record.phase),reserved=record.phase==='preparing'&&record.operation?.status==='reserved';
        const next={...record,phase:inFlight?record.phase:'paused',pauseRequested:inFlight,manualOverride:!inFlight,
          ...(Number.isFinite(startedAt)&&startedAt>0?{manualStartedAt:Math.max(record.manualStartedAt||0,startedAt)}:{}),
          ...(reserved?{pendingSendKind:record.operation.kind,operation:null}:{}),
          reason:inFlight?'Ожидается исход отправки; ручное действие имеет приоритет':'Пауза: ручная отправка пользователя'};
        await event('manual_pause',next,tabId);await save(next);return {ok:true};
      });
    }
    async function manualBind({url,tabId,id,requestId,startedAt,promptKey,userId,userText,userVisibleText,userSentAtMs,nativeVerified}) {
      const target=requireUrl(url);
      const result=await serialize(async()=>{
        const old=await read(target),pending=old?.manualPending,prior=old?.manualSupplementBinding;
        if(!old||old.id!==id)return {ok:false};
        const binding={tabId,requestId,startedAt,promptKey,userId,userText,userVisibleText:typeof userVisibleText==='string'?userVisibleText:null,userSentAtMs};
        if(!pending) {
          if(prior&&Object.keys(binding).every(k=>binding[k]===prior[k]))return {ok:true,record:view(old)};
          return {ok:false};
        }
        if(!['preparing','sending','clicked','waiting','recovering','paused','blocked'].includes(old.phase)||
            pending.tabId!==tabId||pending.requestId!==requestId||pending.startedAt!==startedAt||old.manualStartedAt!==startedAt||
            nativeVerified!==true||typeof userId!=='string'||!userId||typeof userText!=='string'||!userText.trim()||userText.length>10000||
            !policy.submittedTextMatches(pending.text,userText,userVisibleText)||typeof promptKey!=='string'||promptKey===pending.baselineKey||
            !promptKey.startsWith(new URL(target).pathname+'|')||!Number.isFinite(userSentAtMs)||Math.abs(userSentAtMs-startedAt)>10000)
          return {ok:false};
        if((old.supplements||[]).some(item=>item.userId===userId||item.requestId===requestId))return {ok:false};
        const supplement={...binding,text:pending.text,eventAt:pending.eventAt,baselineKey:pending.baselineKey};
        const early=buffered(old,'manualEarlyCompletions','manualEarlyCompletion').find(item=>item.userId===userId&&item.promptKey===promptKey)||null;
        const fenced=!!old.operation||old.phase==='blocked',paused=old.phase==='paused'||old.pauseRequested;
        const next={...old,supplements:[...(old.supplements||[]),supplement],manualPending:null,manualSupplementBinding:supplement,
          expectedPromptKey:promptKey,handoffPending:false,manualEarlyCompletion:null,manualEarlyCompletions:[],
          earlyCompletion:early,phase:fenced?old.phase:paused?'paused':'waiting',
          reason:fenced?old.reason:paused?'Приостановлено пользователем':''};
        await event('manual_supplement_bound',next,tabId,{requestId,startedAt,promptKey,userId,text:userText,intentText:pending.text});
        await save(next);return {ok:true,record:view(next),replay:!fenced?early:null};
      });
      if(result.replay)await completion(result.replay);
      return {ok:result.ok,record:result.replay?await get(target):result.record};
    }
    async function retry({url,tabId,kind,promptKey,attemptId,goalHandoff=false}) {
      const target=canonical(url);
      if(!target)return;
      await serialize(async()=>{
        const record=await read(target);
        const recoveredBlock=record?.phase==='blocked'&&!record.operation&&
          record.reason==='Восстановление запроса завершилось ошибкой'&&['retry.confirmed','retry.preparation_recovered'].includes(kind);
        if(!record||!['waiting','recovering','paused'].includes(record.phase)&&!recoveredBlock)return;
        // Journal delivery and Goal writes use different queues. Recheck the
        // request fence here, after serialization: an accepted old callback
        // may arrive after a manual send or a newly started Goal.
        const attempt=Number(attemptId),knownAttempt=Number.isFinite(attempt)&&attempt>0;
        if(knownAttempt&&attempt<Math.max(record.startedAt||0,record.manualStartedAt||0)||
            !knownAttempt&&record.manualStartedAt>0)return;
        if(kind==='retry.preparation_recovered'&&(record.operation||record.pauseRequested||record.stopRequested||
            record.manualPending||record.phase==='paused'||now()>=record.deadlineAt||record.expectedPromptKey!==promptKey))return;
        if(kind==='retry.blocked'&&goalHandoff)return; // new-chat recovery is not a failed Goal
        let next=record;
        if(kind==='retry.preparation_recovered')next={...record,phase:'recovering',reason:''};
        if(kind==='retry.planned')next={...record,phase:record.phase==='paused'?'paused':'recovering'};
        if(kind==='retry.confirmed'&&typeof promptKey==='string'&&promptKey.startsWith(new URL(target).pathname+'|'))
          next={...record,phase:record.phase==='paused'?'paused':'waiting',expectedPromptKey:promptKey,reason:''};
        if(['retry.failed','retry.blocked','draft.restore_failed'].includes(kind))
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
        if(record.phase==='handoff'&&record.handoffId===handoffId) {
          // The worker replays its own durable handoff key. Older Goal records
          // lack this derived tab binding; fill it once without replaying sends.
          if(record.handoffTabId===undefined&&Number.isInteger(tabId)&&tabId>=0)
            await save({...record,handoffTabId:tabId});
          return;
        }
        if(record.manualPending)throw Error('Дополнение к цели ещё не подтверждено; handoff остановлен');
        if(!['waiting','paused','recovering'].includes(record.phase))throw Error('Goal отправляет сообщение; handoff остановлен');
        const next={...record,preHandoffPhase:record.phase,phase:'handoff',handoffId,handoffTabId:tabId};
        await event('handoff_begin',next,tabId,{handoffId});
        await save(next);
      });
    }
    async function handoffFailed({sourceUrl,handoffId,tabId,reason}) {
      const source=canonical(sourceUrl);
      if(!source||typeof handoffId!=='string'||!handoffId)return {ok:false};
      return serialize(async()=>{
        const record=await read(source);
        if(!record||record.phase!=='handoff'||record.handoffId!==handoffId||
            record.handoffTabId!==tabId)return {ok:false};
        const next={...record,phase:'blocked',
          reason:('Передача Goal остановлена: '+String(reason||'Не удалось подтвердить перенос')).slice(0,500)};
        await event('handoff_failed',next,tabId,{handoffId});
        await save(next);
        return {ok:true,record:view(next)};
      });
    }
    async function handoffPreparationReady({sourceUrl,handoffId,tabId}) {
      const source=canonical(sourceUrl);
      if(!source)return {ok:false};
      return serialize(async()=>{
        const record=await read(source);
        if(!record)return {ok:true};
        if(record.handoffId!==handoffId||record.handoffTabId!==tabId||record.operation||
            record.pauseRequested||record.stopRequested||record.manualPending||
            record.preHandoffPhase==='paused'||now()>=record.deadlineAt)return {ok:false};
        if(record.phase==='handoff')return {ok:true};
        if(record.phase!=='blocked'||record.reason!=='Передача Goal остановлена: Не удалось дождаться готовности нового чата')return {ok:false};
        const next={...record,phase:'handoff',reason:''};
        await event('handoff_preparation_ready',next,tabId,{handoffId});
        await save(next);
        return {ok:true};
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
        // Native acceptance may arrive *after* the answer. Never evict its
        // candidate because later unrelated turns completed in the same tab.
        // Keep one compact final proof per native user id; no assistant text is
        // needed beyond the exact marker for policy.decision().
        const compact={url:target,tabId,completionKey,promptKey,
          response:response===policy.MARKER?policy.MARKER:'',nativeVerified,rawExact,userId};
        const index=saved.findIndex(item=>item.userId===userId);
        const candidates=index<0?[...saved,compact]:saved.map((item,i)=>i===index?compact:item);
        if(candidates.length>256) {
          const blocked={...old,phase:'blocked',
            reason:'Больше 256 неподтверждённых ответов нового чата; нельзя безопасно выбрать ответ Goal'};
          await event('handoff_overflow_blocked',blocked,tabId,{handoffId});
          await save(blocked);
          return {ok:false,blocked:true};
        }
        const next={...old,handoffEarlyCompletion:null,handoffEarlyCompletions:candidates};
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
    return Object.freeze({get,start,composerGet,composerArm,composerDisarm,composerIntent,composerRequest,composerBind,recoverTab,control,retryPreparation,check,intent,authorize,report,completion,manual,manualBind,retry,handoffBegin,handoffFailed,handoffPreparationReady,handoffConfirm,stageHandoffCompletion,
      context:async url=>{const record=await getRaw(url);return record&&!['moved','completed','stopped','blocked'].includes(record.phase)?policy.handoffText(record):'';}});
  }
  const api=Object.freeze({create});
  root.ChatGPTGoalStore=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
