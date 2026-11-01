'use strict';
let journal = null;
let limit = 200;
const labels = {
  'tab.snapshot':'Состояние вкладки при запуске', 'watcher.unavailable':'Наблюдение недоступно (вкладка выгружена или недоступна)', 'attachment.status':'Состояние вложения',
  'draft.restore_deferred':'Черновик сохранён; восстановление отложено ради безопасности', 'reasoning.selected':'Установлен уровень «Очень высокий»',
  'send.authorized':'Проверен точный текст автоматической отправки',
  'recovery.stop_intent':'Подготовлена остановка зависшего ожидания', 'recovery.stop_result':'Результат остановки ожидания', 'recovery.stop_refused':'Остановка ожидания отменена',
  'journal.started': 'Начало журнала', 'extension.started': 'Расширение запущено',
  'watcher.started': 'Наблюдение за чатом включено', 'page.changed': 'Открыт другой чат',
  'error.detected': 'Обнаружена ошибка', 'retry.planned': 'Автоповтор запланирован',
  'retry.send_intent': 'Подготовлена отправка автоповтора', 'retry.clicked': 'Нажата отправка',
  'retry.confirmed': 'Отправка автоповтора подтверждена', 'retry.cancelled': 'Автоповтор отменён',
  'retry.failed': 'Автоповтор остановлен', 'retry.blocked': 'Достигнут лимит / автоповтор запрещён',
  'retry.manual_reset': 'Счётчик сброшен ручной отправкой', 'draft.saved': 'Черновик сохранён',
  'draft.restored': 'Черновик восстановлен', 'draft.restore_failed': 'Ошибка восстановления черновика',
  'request.started': 'Замечен запрос отправки', 'request.completed': 'Запрос завершён', 'request.failed': 'Сетевая ошибка',
  'handoff.navigating': 'История сохранена для нового чата', 'handoff.preparing': 'Подготовка нового чата',
  'handoff.sending': 'Подготовлена отправка истории', 'handoff.clicked': 'Нажата отправка истории',
  'handoff.sent': 'Передача истории подтверждена', 'handoff.failed': 'Передача остановлена',
  'handoff.imported': 'Предыдущая передача (сохранённое состояние)', 'notification.requested': 'Запрошено уведомление',
  'notification.result': 'Результат показа уведомления', 'response.complete': 'Ответ завершён',
  'tab.updated': 'Состояние вкладки изменилось', 'tab.closed': 'Вкладка закрыта'
};
function render() {
  const query = document.getElementById('filter').value.trim().toLowerCase();
  const entries = (journal?.events || []).filter(e => !query || JSON.stringify(e).toLowerCase().includes(query)).reverse();
  const root = document.getElementById('events'); root.replaceChildren();
  for (const entry of entries.slice(0, limit)) {
    const article = document.createElement('article'); const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `#${entry.sequence} · ${new Date(entry.recordedAt).toLocaleString()} · ${labels[entry.kind] || entry.kind} · ${entry.title || 'ChatGPT'}`;
    if (/failed|blocked/.test(entry.kind)) summary.className = 'error';
    details.append(summary);
    const ids = document.createElement('p');
    for (const [label,url,id] of [['Чат',entry.sourceUrl,entry.sourceChatId],['Новый чат',entry.targetUrl,entry.targetChatId]]) {
      if (!id) continue;
      const link = document.createElement('a'); link.textContent = `${label}: ${id}`; link.href = `https://chatgpt.com/c/${encodeURIComponent(id)}`; link.target = '_blank'; link.rel = 'noopener'; ids.append(link, document.createElement('br'));
    }
    details.append(ids);
    // Untrusted page text is always textContent, never HTML.
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(entry, null, 2); details.append(pre);
    article.append(details); root.append(article);
  }
  const start = journal?.meta?.startedAt;
  document.getElementById('status').textContent = `${entries.length} событий · журнал с ${start ? new Date(start).toLocaleString() : '—'}\nПрошлые автоповторы до начала журнала недоступны.${journal?.storageError ? '\n⚠️ Ошибка записи: ' + journal.storageError : ''}`;
  document.getElementById('more').hidden = entries.length <= limit;
}
async function refresh() {
  try { const result = await chrome.runtime.sendMessage({ type: 'CHATGPT_JOURNAL_READ' }); if (!result?.ok) throw new Error(result?.error || 'Журнал недоступен'); journal = result; render(); }
  catch(error) { document.getElementById('status').textContent = `Не удалось прочитать журнал: ${error.message}`; }
}
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('filter').addEventListener('input', () => { limit=200; render(); });
document.getElementById('more').addEventListener('click', () => { limit+=200; render(); });
document.getElementById('export').addEventListener('click', async () => {
  await refresh(); if (!journal) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(journal,null,2)],{type:'application/json;charset=utf-8'}));
  const link = document.createElement('a'); link.href=url; link.download=`chatgpt-journal-${new Date().toISOString().replace(/[:.]/g,'-')}.json`; link.click(); setTimeout(()=>URL.revokeObjectURL(url),10000);
});
void refresh();
