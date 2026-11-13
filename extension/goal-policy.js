'use strict';

// Pure Goal rules. The model's marker is an assertion, not evidence of CI or merge.
(function(root) {
  const MARKER='GOAL_COMPLETE';
  const BLOCKED_MARKER='GOAL_BLOCKED';
  const COMPLETION_FORMAT='Только после полного выполнения всей цели ответь ровно одной строкой GOAL_COMPLETE без точки в конце. Всё сообщение должно состоять только из этой строки: без Markdown, кавычек, пояснений, итогов и любого другого текста.';
  const WAIT_FORMAT='Ожидание само по себе не является блокировкой, даже если работа занимает долгое время: очередь CI, ожидание runner, выполняющиеся проверки, сборка, развёртывание или распространение изменений требуют времени. Не используй GOAL_BLOCKED для CI, runner, проверок или деплоя в очереди или в работе. Дождись результата штатным механизмом, затем проверь результат и продолжай работу end-to-end. Не завершай попытку только из-за ожидания и не объявляй цель заблокированной; не подменяй ожидание частыми проверками, повторными запусками или обходом ограничений. Соблюдай заданные лимиты цели и ручную остановку пользователя.';
  const BLOCKED_FORMAT='Прежде чем считать цель заблокированной, проверь актуальное состояние и штатные способы продолжения; отдельно ответь себе: какое именно действие пользователя необходимо, почему его нельзя выполнить самостоятельно штатными средствами и почему до его получения нельзя сделать никакой полезной работы. Не выдавай GOAL_BLOCKED, если хоть один из этих пунктов не установлен. Ошибка проверки, уязвимая или неподтверждённая зависимость, непройденное ревью, необходимость исправить код, подготовить подписанный выпуск или выполнить merge сами по себе не требуют вмешательства владельца: изучи причины, исправь доступное, дождись текущих проверок и продолжай другие независимые части цели. Если конкретный инструмент не поддерживает действие, проверь, доступны ли в текущей среде и с имеющимися правами другие официальные штатные способы выполнить его; отсутствие функции в одном инструменте само по себе не доказывает блокировку. Не выдумывай доступные инструменты и не обходи запреты или права доступа. Не считай старое сообщение о блокировке или частичный результат доказательством текущей блокировки. Если выполнение какого-то действия ограничено, не обходи ограничения странными, сомнительными или небезопасными путями; выполни остальное в рамках разрешений. Только когда для продолжения действительно требуется вмешательство пользователя или владельца (например, отсутствующие права, данные или решение), а простое ожидание результата не поможет, ответь ровно одной строкой GOAL_BLOCKED без оформления и другого текста.';
  const INCOMPLETE_FORMAT='Пока цель не выполнена полностью, продолжай работу и сообщай конкретный прогресс или блокировки. Не обсуждай сигнал завершения и не поясняй, почему ты его не подаёшь.';
  const RETRY_MESSAGE_KEY='chatgpt-retry-message';
  const DEFAULT_RETRY_MESSAGE='доделай е2е';
  function retryMessage(value) {
    return typeof value==='string'&&value.trim().length<=500&&value.trim()?value.trim():DEFAULT_RETRY_MESSAGE;
  }
  const CONTINUATION='Продолжай выполнение исходной цели до полного результата. Проверь всё end-to-end, включая необходимые pull requests, merge и успешные проверки, если это входит в цель. '+INCOMPLETE_FORMAT+' '+WAIT_FORMAT+' '+COMPLETION_FORMAT+' '+BLOCKED_FORMAT;
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
  function temporaryPageUrl(value) {
    try {
      const url=new URL(value),match=url.pathname.match(/^\/c\/([^/]+)\/?$/);
      if(url.origin!=='https://chatgpt.com'||!match||!/^local-chatgpt:[a-z0-9-]+$/.test(decodeURIComponent(match[1])))return '';
      return url.origin+url.pathname.replace(/\/$/,'');
    } catch {return '';}
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
      INCOMPLETE_FORMAT,WAIT_FORMAT,
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
  function submittedTextMatches(intent,nativeText,visibleText,linkTargets) {
    if(typeof intent!=='string'||typeof nativeText!=='string')return false;
    // Literal Markdown typed by the user needs no transformed-link fallback.
    if(nativeText===intent)return true;
    if(typeof visibleText!=='string'||visibleText!==intent&&
        visibleText.replace(/\s+/g,' ').trim()!==intent.replace(/\s+/g,' ').trim())return false;
    // Old pending records lack a link snapshot; keep their legacy behavior.
    if(linkTargets===undefined)return true;
    if(!Array.isArray(linkTargets)||linkTargets.length>32||linkTargets.some(x=>typeof x!=='string'||!/^https?:\/\//.test(x)||x.length>2048))return false;
    // A trusted user click captured the editor's link targets before submit.
    // A matching visible label cannot approve a different serialized URL.
    // Preserve explicitly captured targets while allowing ChatGPT to turn a
    // literal URL in the same message into an identical automatic link.
    const pattern=/\[([^\]\n]{1,500})\]\((https?:\/\/(?:\\.|[^)\s])+)\)/g;
    const links=[...nativeText.matchAll(pattern)];
    if(nativeText.replace(pattern,'').includes(']('))return false;
    const captured=[];
    for(const match of links) {
      const target=match[2].replace(/\\([()\\])/g,'$1');
      if(target===linkTargets[captured.length])captured.push(target);
      else if(match[1]!==target||!intent.includes(target))return false;
    }
    return captured.length===linkTargets.length&&captured.every((target,index)=>target===linkTargets[index]);
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
  const api=Object.freeze({MARKER,BLOCKED_MARKER,CONTINUATION,RETRY_MESSAGE_KEY,DEFAULT_RETRY_MESSAGE,retryMessage,DEFAULTS,canonical,pageUrl,temporaryPageUrl,composerSettings,settings,initialText,continuationText,handoffText,submittedTextMatches,exactMarker,exactBlockedMarker,terminalMarker,decision});
  root.ChatGPTGoalPolicy=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
