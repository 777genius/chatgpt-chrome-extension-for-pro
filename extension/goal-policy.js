'use strict';

// Pure Goal rules. The model's marker is an assertion, not evidence of CI or merge.
(function(root) {
  const MARKER='GOAL_COMPLETE';
  const COMPLETION_FORMAT='После полного выполнения цели напиши GOAL_COMPLETE отдельным первым абзацем без оформления. После пустой строки напиши «Итог:», затем 1–3 коротких пункта с префиксом «- » о том, что выполнено по всей цели.';
  const CONTINUATION='Продолжай выполнение исходной цели до полного результата. Проверь всё end-to-end, включая необходимые pull requests, merge и успешные проверки, если это входит в цель. Если работа ещё не завершена, продолжай её и не выдавай маркер. '+COMPLETION_FORMAT;
  function canonical(value) {
    try {
      const url=new URL(value);
      return url.origin==='https://chatgpt.com'&&/^\/c\/[a-z0-9-]+\/?$/.test(url.pathname)
        ?url.origin+url.pathname.replace(/\/$/,''):'';
    } catch {return '';}
  }
  const DEFAULTS=Object.freeze({maxContinuations:10,maxMinutes:1440});
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
      COMPLETION_FORMAT,
      'Если цель не завершена, не используй GOAL_COMPLETE. Работай дальше, прямо указывай блокировки и реальные результаты.'].join('\n\n');
  }
  function supplementsText(record) {
    return (record.supplements||[]).map((item,index)=>'Дополнение пользователя '+(index+1)+':\n'+item.userText);
  }
  function continuationText(record) {
    return [CONTINUATION,'Исходная цель:',record.goal,...supplementsText(record),
      ...(record.rules?['Условия завершения:',record.rules]:[])].join('\n\n');
  }
  function handoffText(record) {
    return ['--- Активная цель расширения (не отчёт о выполнении) ---',
      record.goal,...supplementsText(record),...(record.rules?[record.rules]:[]),
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
  function decision(record,response,rawExact,nativeVerified,time) {
    if(nativeVerified!==true)return 'unverified';
    if(exactMarker(response,rawExact,nativeVerified))return 'complete';
    if(time>=record.deadlineAt)return 'deadline';
    if(record.continuations>=record.maxContinuations)return 'budget';
    return 'continue';
  }
  const api=Object.freeze({MARKER,CONTINUATION,DEFAULTS,canonical,pageUrl,composerSettings,settings,initialText,continuationText,handoffText,submittedTextMatches,exactMarker,decision});
  root.ChatGPTGoalPolicy=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
