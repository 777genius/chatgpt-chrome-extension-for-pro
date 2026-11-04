'use strict';

// Pure Goal rules. The model's marker is an assertion, not evidence of CI or merge.
(function(root) {
  const MARKER='GOAL_COMPLETE';
  const BLOCKED_MARKER='GOAL_BLOCKED';
  const COMPLETION_FORMAT='Только после полного выполнения всей цели ответь ровно одной строкой GOAL_COMPLETE без точки в конце. Всё сообщение должно состоять только из этой строки: без Markdown, кавычек, пояснений, итогов и любого другого текста.';
  const BLOCKED_FORMAT='Если цель действительно заблокирована, сначала выполни всю доступную полезную работу и проверь разумные штатные способы продолжения. Не обходи ограничения странными, сомнительными или небезопасными путями. Только когда без внешнего действия больше нельзя продвинуться, ответь ровно одной строкой GOAL_BLOCKED без оформления и другого текста.';
  const INCOMPLETE_FORMAT='Пока цель не выполнена полностью, продолжай работу и сообщай конкретный прогресс или блокировки. Не обсуждай сигнал завершения и не поясняй, почему ты его не подаёшь.';
  const CONTINUATION='Продолжай выполнение исходной цели до полного результата. Проверь всё end-to-end, включая необходимые pull requests, merge и успешные проверки, если это входит в цель. '+INCOMPLETE_FORMAT+' '+COMPLETION_FORMAT+' '+BLOCKED_FORMAT;
  function canonical(value) {
    try {
      const url=new URL(value);
      return url.origin==='https://chatgpt.com'&&/^\/c\/[a-z0-9-]+\/?$/.test(url.pathname)
        ?url.origin+url.pathname.replace(/\/$/,''):'';
    } catch {return '';}
  }
  const DEFAULTS=Object.freeze({maxContinuations:30,maxMinutes:1440});
  function pageUrl(value) {
    try {const url=new URL(value);return url.origin==='https://chatgpt.com'&&url.pathname==='/'?url.origin+'/':canonical(value);}catch{return '';}
  }
  function composerSettings(input={}) {
    const {rules,maxContinuations,maxMinutes}=settings({...DEFAULTS,...Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined)),goal:'Native message'});
    return {rules,maxContinuations,maxMinutes};
  }
  function settings(input) {
    const goal=typeof input?.goal==='string'?input.goal.trim():'';
    const rules=typeof input?.rules==='string'?input.rules.trim():'';
    const maxContinuations=Number(input?.maxContinuations);
    const maxMinutes=Number(input?.maxMinutes);
    if(!goal||goal.length>10000||rules.length>5000)throw Error('Введите цель (до 10000 символов) и правила (до 5000)');
    if(!Number.isInteger(maxContinuations)||maxContinuations<1||maxContinuations>100)throw Error('Лимит продолжений: 1–100');
    if(!Number.isInteger(maxMinutes)||maxMinutes<1||maxMinutes>1440)throw Error('Лимит времени: 1–1440 минут');
    return {goal,rules,maxContinuations,maxMinutes};
  }
  function initialText(record) {
    return ['Цель (автономное выполнение):',record.goal,
      ...(record.rules?['Условия завершения:',record.rules]:[]),
      'Продолжай работу end-to-end. Успешные проверки, публикация и merge должны действительно состояться, если это требуется целью.',
      INCOMPLETE_FORMAT,
      COMPLETION_FORMAT,BLOCKED_FORMAT].join('\n\n');
  }
  function supplementsText(record) {
    return (record.supplements||[]).map((item,index)=>'Дополнение пользователя '+(index+1)+':\n'+item.userText);
  }
  function continuationText(record) {
    return [CONTINUATION,'Исходная цель:',record.goal,...(record.sourceContexts||[]).map(x=>'Сохранённый контекст предыдущего чата '+x.url+' (история, не новая цель):\n'+x.text),...supplementsText(record),
      ...(record.rules?['Условия завершения:',record.rules]:[])].join('\n\n');
  }
  function handoffText(record) {
    return ['--- Активная цель расширения (не отчёт о выполнении) ---',
      record.goal,...(record.sourceContexts||[]).map(x=>'История предыдущего чата '+x.url+':\n'+x.text),...supplementsText(record),...(record.rules?[record.rules]:[]),
      'Продолжений подтверждено: '+record.continuations+' из '+record.maxContinuations+'.',
      'Не считай перенос чата выполнением цели. '+CONTINUATION].join('\n\n');
  }
  function submittedTextMatches(intent,nativeText,visibleText) {
    if(typeof intent!=='string'||typeof nativeText!=='string')return false;
    return nativeText===intent||visibleText===intent||typeof visibleText==='string'&&
      visibleText.replace(/\s+/g,' ').trim()===intent.replace(/\s+/g,' ').trim();
  }
  function exactMarker(response,rawExact,nativeVerified) {
    return nativeVerified===true&&rawExact===true&&response===MARKER;
  }
  function exactBlockedMarker(response,rawExact,nativeVerified) {
    return nativeVerified===true&&rawExact===true&&response===BLOCKED_MARKER;
  }
  function terminalMarker(response,rawExact,nativeVerified) {
    return exactMarker(response,rawExact,nativeVerified)||exactBlockedMarker(response,rawExact,nativeVerified);
  }
  function decision(record,response,rawExact,nativeVerified,time) {
    if(nativeVerified!==true)return 'unverified';
    if(exactMarker(response,rawExact,nativeVerified))return 'complete';
    if(exactBlockedMarker(response,rawExact,nativeVerified))return 'blocked';
    if(time>=record.deadlineAt)return 'deadline';
    if(record.continuations>=record.maxContinuations)return 'budget';
    return 'continue';
  }
  const api=Object.freeze({MARKER,BLOCKED_MARKER,CONTINUATION,DEFAULTS,canonical,pageUrl,composerSettings,settings,initialText,continuationText,handoffText,submittedTextMatches,exactMarker,exactBlockedMarker,terminalMarker,decision});
  root.ChatGPTGoalPolicy=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
