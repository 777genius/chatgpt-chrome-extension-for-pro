"use strict";

interface GoalPopupRecord {
  goal:string;rules?:string;maxContinuations:number;maxMinutes:number;
  phase:string;continuations:number;deadlineAt:number;reason?:string;
  operation?:{id:string;kind:string;status:string;createdAt:number}|null;
}
interface PopupResponse {
  ok?:boolean;error?:string;text?:string;draft?:string;
  operationId?:string;tabId?:number;targetUrl?:string;desiredTitle?:string;
  reason?:string;skipped?:boolean;available?:boolean;url?:string;
  record?:GoalPopupRecord|null;
}
interface PopupHost {
  runtime: {
    sendMessage(message:Record<string,unknown>):Promise<PopupResponse>;
    getURL(relativePath:string):string;
  };
  tabs: {create(options:{url:string}):Promise<unknown>};
}
declare const chrome:PopupHost;
function popupElement(id:string):HTMLElement {
  const node=document.getElementById(id);
  if(!node)throw new Error("Popup element missing: "+id);
  return node;
}
function popupButton(id:string):HTMLButtonElement {
  const node=popupElement(id);
  if(node.tagName !== "BUTTON")throw new Error("Popup button missing: "+id);
  return node as HTMLButtonElement;
}
function popupTextArea(id:string):HTMLTextAreaElement {
  const node=popupElement(id);
  if(node.tagName !== "TEXTAREA")throw new Error("Popup textarea missing: "+id);
  return node as HTMLTextAreaElement;
}
function popupNumeric(id:string):HTMLInputElement {
  const node=popupElement(id);
  if(node.tagName !== "INPUT")throw new Error("Popup number field missing: "+id);
  return node as HTMLInputElement;
}
function popupError(error:unknown):string {
  return error instanceof Error ? error.message : String(error);
}
const button = popupButton('test');
const status = popupElement('status');

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Dispatching both channels...';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'TEST_BOTH' });
    if (!result?.ok) throw new Error(result?.error || 'Unknown error');
    status.textContent = 'Sound + desktop notification dispatched.';
  } catch (error:unknown) {
    status.textContent = `Test failed: ${popupError(error)}`;
  } finally {
    button.disabled = false;
  }
});


popupButton('handoff').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'CHATGPT_HANDOFF_DOWNLOAD' });
  if (!result?.ok) { status.textContent = 'В этой вкладке пока нет сохранённой передачи.'; return; }
  const text = result.text + (result.draft ? `\n\n--- Неотправленный черновик ---\n${result.draft}` : '');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'chat-handoff-recovery.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

popupButton('journal').addEventListener('click', () => {
  chrome.tabs.create({url:chrome.runtime.getURL('journal.html')});
});

const titleRecovery=popupElement('title-recovery');
const recoverTitle=popupButton('recover-title');
let recoveryInfo:PopupResponse|null=null;
chrome.runtime.sendMessage({type:'CHATGPT_HANDOFF_TITLE_INFO'}).then(info=>{
  if(!info?.ok||!info.available)return;
  recoveryInfo=info;
  popupElement('desired-title').textContent=info.desiredTitle??null;
  titleRecovery.hidden=false;
}).catch(()=>{});
recoverTitle.addEventListener('click',async()=>{
  if(!recoveryInfo||recoverTitle.disabled)return;
  recoverTitle.disabled=true;
  status.textContent='Восстанавливаем название...';
  try {
    const result=await chrome.runtime.sendMessage({type:'CHATGPT_HANDOFF_RENAME_RECOVER',
      operationId:recoveryInfo.operationId,tabId:recoveryInfo.tabId,targetUrl:recoveryInfo.targetUrl,desiredTitle:recoveryInfo.desiredTitle});
    if(!result?.ok||result.skipped||result.available===false)throw new Error(result?.reason||'Восстановление больше недоступно');
    status.textContent='Название чата восстановлено.';
    titleRecovery.hidden=true;
  } catch(error:unknown) {
    status.textContent=`Название не восстановлено: ${popupError(error)}`;
  }
});


const goalUi={
  text:popupTextArea('goal-text'),
  rules:popupTextArea('goal-rules'),
  max:popupNumeric('goal-max'),
  minutes:popupNumeric('goal-minutes'),
  status:popupElement('goal-status'),
  start:popupButton('goal-start'),
  pause:popupButton('goal-pause'),
  resume:popupButton('goal-resume'),
  stop:popupButton('goal-stop')
};
let goalBusy=false;
let goalRecord:GoalPopupRecord|null=null;
let goalBinding:{tabId:number;url:string}|null=null;
const goalPhases:Record<string,string>={
  preparing:'Подготовка сообщения',sending:'Разрешённая отправка',
  clicked:'Ожидание подтверждения клика',waiting:'Ожидание полного ответа',
  recovering:'Восстановление ошибки',handoff:'Перенос в новый чат',
  paused:'Пауза',completed:'Модель выдала GOAL_COMPLETE',
  blocked:'Остановлено для безопасности',stopped:'Остановлено',moved:'Перенесено в новый чат'
};
function showGoal(record:GoalPopupRecord|null):void {
  goalRecord=record;
  const active=!!record&&!['completed','blocked','stopped','moved'].includes(record.phase);
  const editable=!active&&!goalBusy;
  for(const field of [goalUi.text,goalUi.rules,goalUi.max,goalUi.minutes])field.disabled=!editable;
  if(record) {
    goalUi.text.value=record.goal;
    goalUi.rules.value=record.rules||'';
    goalUi.max.value=String(record.maxContinuations);
    goalUi.minutes.value=String(record.maxMinutes);
    const parts=[goalPhases[record.phase]||record.phase,
      record.continuations+' / '+record.maxContinuations+' продолжений',
      'до '+new Date(record.deadlineAt).toLocaleString()];
    if(record.reason)parts.push(record.reason);
    if(record.operation&&['stopped','blocked'].includes(record.phase))parts.push('Предыдущая отправка не подтверждена: для новой цели откройте другой чат');
    if(record.phase==='blocked')parts.push('Проверьте журнал и нажмите «Остановить» перед новым запуском');
    goalUi.status.textContent=parts.join(' · ');
  } else goalUi.status.textContent='Задайте цель и нажмите «Начать Goal».';
  goalUi.start.disabled=!editable||!goalBinding||!!record?.operation||record?.phase==='blocked';
  goalUi.pause.disabled=goalBusy||!active||!goalBinding||record.phase==='paused'||record.phase==='handoff';
  goalUi.resume.disabled=goalBusy||record?.phase!=='paused'||!!record?.operation||!goalBinding;
  goalUi.stop.disabled=goalBusy||(!active&&record?.phase!=='blocked')||!goalBinding;
}
async function goalAction(action:'start'|'pause'|'resume'|'stop'):Promise<void> {
  if(goalBusy)return;
  goalBusy=true;
  for(const key of ['start','pause','resume','stop'] as const)goalUi[key].disabled=true;
  goalUi.status.textContent='Сохранение Goal…';
  try {
    if(!goalBinding)throw Error('Сначала откройте меню расширения в нужном чате');
    const result=await chrome.runtime.sendMessage({type:'CHATGPT_GOAL_CONTROL',action,
      expectedTabId:goalBinding.tabId,expectedUrl:goalBinding.url,
      ...(action==='start'?{goal:goalUi.text.value,rules:goalUi.rules.value,
        maxContinuations:Number(goalUi.max.value),maxMinutes:Number(goalUi.minutes.value)}:{})});
    if(!result?.ok)throw Error(result?.error||'Операция Goal не подтверждена');
    goalBusy=false;
    showGoal(result.record??null);
  }catch(error){
    goalBusy=false;
    showGoal(goalRecord);
    goalUi.status.textContent='Goal: '+popupError(error);
  }
}
for(const action of ['start','pause','resume','stop'] as const)
  goalUi[action].addEventListener('click',()=>void goalAction(action));
chrome.runtime.sendMessage({type:'CHATGPT_GOAL_CONTROL',action:'get'}).then(result=>{
  if(!result?.ok)throw Error(result?.error||'Нет доступа к чату');
  if(typeof result.tabId!=='number'||!result.url)throw Error('Не удалось закрепить активный чат');
  goalBinding={tabId:result.tabId,url:result.url};
  showGoal(result.record??null);
}).catch((error:unknown)=>{goalUi.status.textContent='Goal: '+popupError(error);});
