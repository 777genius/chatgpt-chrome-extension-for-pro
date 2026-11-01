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
  if (!result?.ok) { status.textContent = 'В этой вкладке пока нет сохранённой передачи.'; return; }
  const text = result.text + (result.draft ? `\n\n--- Неотправленный черновик ---\n${result.draft}` : '');
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
  status.textContent='Восстанавливаем название...';
  try {
    const result=await chrome.runtime.sendMessage({type:'CHATGPT_HANDOFF_RENAME_RECOVER',
      operationId:recoveryInfo.operationId,tabId:recoveryInfo.tabId,targetUrl:recoveryInfo.targetUrl,desiredTitle:recoveryInfo.desiredTitle});
    if(!result?.ok||result.skipped||result.available===false)throw new Error(result?.reason||'Восстановление больше недоступно');
    status.textContent='Название чата восстановлено.';
    titleRecovery.hidden=true;
  } catch(error) {
    status.textContent=`Название не восстановлено: ${error.message}`;
  }
});
