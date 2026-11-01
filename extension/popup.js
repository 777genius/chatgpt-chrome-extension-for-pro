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
