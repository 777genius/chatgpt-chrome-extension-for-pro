'use strict';

const button = document.getElementById('test');
const status = document.getElementById('status');

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Dispatching both channels...';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'TEST_BOTH' });
    if (!result?.ok) throw new Error(result?.error || 'Unknown error');
    status.textContent = 'Sound + desktop notification dispatched.';
  } catch (error) {
    status.textContent = `Test failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});


document.getElementById('handoff').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'CHATGPT_HANDOFF_DOWNLOAD' });
  if (!result?.ok) { status.textContent = 'No saved chat transfer for this tab.'; return; }
  const text = result.text + (result.draft ? `\n\n--- Unsent draft ---\n${result.draft}` : '');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'chat-handoff-recovery.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

document.getElementById('journal').addEventListener('click', () => {
  chrome.tabs.create({url:chrome.runtime.getURL('journal.html')});
});

const titleRecovery=document.getElementById('title-recovery');
const recoverTitle=document.getElementById('recover-title');
let recoveryInfo=null;
chrome.runtime.sendMessage({type:'CHATGPT_HANDOFF_TITLE_INFO'}).then(info=>{
  if(!info?.ok||!info.available)return;
  recoveryInfo=info;
  document.getElementById('desired-title').textContent=info.desiredTitle;
  titleRecovery.hidden=false;
}).catch(()=>{});
recoverTitle.addEventListener('click',async()=>{
  if(!recoveryInfo||recoverTitle.disabled)return;
  recoverTitle.disabled=true;
  status.textContent='Restoring chat title…';
  try {
    const result=await chrome.runtime.sendMessage({type:'CHATGPT_HANDOFF_RENAME_RECOVER',
      operationId:recoveryInfo.operationId,tabId:recoveryInfo.tabId,targetUrl:recoveryInfo.targetUrl,desiredTitle:recoveryInfo.desiredTitle});
    if(!result?.ok||result.skipped||result.available===false)throw new Error('The saved title is no longer available');
    status.textContent='Chat title restored.';
    titleRecovery.hidden=true;
  } catch(error) {
    status.textContent=`Could not restore the title: ${error.message}`;
  }
});


const goalUi={
  text:document.getElementById('goal-text'),
  followups:document.getElementById('goal-followups'),
  rules:document.getElementById('goal-rules'),
  max:document.getElementById('goal-max'),
  minutes:document.getElementById('goal-minutes'),
  status:document.getElementById('goal-status'),
  start:document.getElementById('goal-start'),
  pause:document.getElementById('goal-pause'),
  resume:document.getElementById('goal-resume'),
  stop:document.getElementById('goal-stop')
};
let goalBusy=false;
let goalRecord=null;
let goalBinding=null;
const goalPhases={
  preparing:'Preparing a message',sending:'Sending a message',
  clicked:'Confirming the message',waiting:'Waiting to continue',
  recovering:'Recovering from an error',handoff:'Moving to a new chat',
  paused:'Paused',completed:'Completed',
  blocked:'Needs attention',stopped:'Stopped',moved:'Moved to a new chat'
};
function showGoal(record) {
  goalRecord=record;
  const active=!!record&&!['completed','blocked','stopped','moved'].includes(record.phase);
  const editable=!active&&!goalBusy;
  for(const field of [goalUi.text,goalUi.rules,goalUi.max,goalUi.minutes])field.disabled=!editable;
  // Confirmed additions are read-only context, not part of the editable original objective.
  const supplements=Array.isArray(record?.supplements)?record.supplements.filter(item=>typeof item?.userText==='string'):[];
  goalUi.followups.hidden=supplements.length===0;
  goalUi.followups.textContent=supplements.map((item,index)=>'Update '+(index+1)+':\n'+item.userText).join('\n\n');
  if(record) {
    goalUi.text.value=record.goal;
    goalUi.rules.value=record.rules||'';
    goalUi.max.value=String(record.maxContinuations);
    goalUi.minutes.value=String(record.maxMinutes);
    const parts=[goalPhases[record.phase]||record.phase,
      record.continuations+' / '+record.maxContinuations+' follow-ups',
      'Until '+new Date(record.deadlineAt).toLocaleString()];
    if(record.operation&&['stopped','blocked'].includes(record.phase))parts.push('A previous message is still unconfirmed. Open another chat to start a new goal.');
    if(record.phase==='blocked')parts.push('Check the activity log before starting again.');
    goalUi.status.textContent=parts.join(' · ');
  } else goalUi.status.textContent='Enter an objective to start.';
  goalUi.start.disabled=!editable||!goalBinding||!!record?.operation||record?.phase==='blocked';
  goalUi.pause.disabled=goalBusy||!active||!goalBinding||record.phase==='paused'||record.phase==='handoff';
  goalUi.resume.disabled=goalBusy||(record?.phase!=='paused'&&!(record?.phase==='blocked'&&['Восстановление запроса завершилось ошибкой','Модель ответила точным маркером GOAL_BLOCKED'].includes(record.reason)))||!!record?.operation||!goalBinding;
  goalUi.stop.disabled=goalBusy||(!active&&record?.phase!=='blocked')||!goalBinding;
}
async function goalAction(action) {
  if(goalBusy)return;
  goalBusy=true;
  for(const key of ['start','pause','resume','stop'])goalUi[key].disabled=true;
  goalUi.status.textContent='Saving…';
  try {
    if(!goalBinding)throw Error('Open the extension from the chat you want to use');
    const result=await chrome.runtime.sendMessage({type:'CHATGPT_GOAL_CONTROL',action,
      expectedTabId:goalBinding.tabId,expectedUrl:goalBinding.url,
      ...(action==='start'?{goal:goalUi.text.value,rules:goalUi.rules.value,
        maxContinuations:Number(goalUi.max.value),maxMinutes:Number(goalUi.minutes.value)}:{})});
    if(!result?.ok)throw Error('Could not update the goal');
    goalBusy=false;
    showGoal(result.record);
  }catch(error){
    goalBusy=false;
    showGoal(goalRecord);
    goalUi.status.textContent='Goal: '+String(error?.message||error);
  }
}
for(const action of ['start','pause','resume','stop'])
  goalUi[action].addEventListener('click',()=>void goalAction(action));
chrome.runtime.sendMessage({type:'CHATGPT_GOAL_CONTROL',action:'get'}).then(result=>{
  if(!result?.ok)throw Error('Open a ChatGPT chat to manage its goal');
  if(typeof result.tabId!=='number'||!result.url)throw Error('Could not find the active chat');
  goalBinding={tabId:result.tabId,url:result.url};
  showGoal(result.record);
}).catch(error=>{goalUi.status.textContent='Goal: '+String(error?.message||error);});

const retryForm=document.getElementById('retry-form');
const retryInput=document.getElementById('retry-message');
const retrySave=document.getElementById('retry-save');
const retryStatus=document.getElementById('retry-status');
const {RETRY_MESSAGE_KEY,retryMessage}=ChatGPTGoalPolicy;

chrome.storage.local.get(RETRY_MESSAGE_KEY).then(settings=>{
  retryInput.value=retryMessage(settings[RETRY_MESSAGE_KEY]);
  retryInput.disabled=false;
  retrySave.disabled=false;
}).catch(()=>{retryStatus.textContent='Could not load the retry message.';});

retryForm.addEventListener('submit',async event=>{
  event.preventDefault();
  retrySave.disabled=true;
  try {
    const value=retryMessage(retryInput.value);
    await chrome.storage.local.set({[RETRY_MESSAGE_KEY]:value});
    retryInput.value=value;
    retryStatus.textContent='Saved.';
  } catch {
    retryStatus.textContent='Could not save. Try again.';
  } finally {
    retrySave.disabled=false;
  }
});
