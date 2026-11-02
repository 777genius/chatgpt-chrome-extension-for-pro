"use strict";

// Read-only activity log viewer. Durable storage ownership stays in the worker,
// and untrusted page data is rendered as textContent, never via innerHTML.
interface JournalChrome {
  runtime: { sendMessage(message: {type: "CHATGPT_JOURNAL_READ"}): Promise<unknown> };
}
declare const chrome: JournalChrome;
interface JournalEntry extends Record<string, unknown> {
  kind: string;
  sequence?: number;
  recordedAt?: number | string;
  title?: string;
  sourceUrl?: string;
  sourceChatId?: string;
  targetUrl?: string;
  targetChatId?: string;
}
interface JournalView {
  ok: boolean;
  events: JournalEntry[];
  meta?: { startedAt?: number | string };
  storageError?: string;
  error?: string;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asJournalView(value: unknown): JournalView {
  if (!isRecord(value)) throw new Error("Журнал недоступен");
  if (value.ok !== true) {
    throw new Error(typeof value.error === "string" ? value.error : "Журнал недоступен");
  }
  const entries: unknown[] = Array.isArray(value.events) ? value.events : [];
  const events = entries.filter((entry): entry is JournalEntry =>
    isRecord(entry) && typeof entry.kind === "string");
  const meta = isRecord(value.meta) ? value.meta : undefined;
  const startedAt = meta?.startedAt;
  return {
    ok: true,
    events,
    meta: typeof startedAt === "string" || typeof startedAt === "number" ? { startedAt } : undefined,
    storageError: typeof value.storageError === "string" ? value.storageError : undefined,
  };
}
function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error("Missing journal element: " + id);
  return found;
}
const filterField = element("filter");
if (!(filterField instanceof HTMLInputElement)) throw new Error("Invalid journal filter input");
const journalFilter: HTMLInputElement = filterField;

let journal: JournalView | null = null;
let journalExport: unknown = null;
let journalRefreshVersion = 0;
let limit = 200;
const labels: Record<string, string> = {
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
function render(): void {
  const query = journalFilter.value.trim().toLowerCase();
  const entries = (journal?.events || []).filter((e) =>
    !query || JSON.stringify(e).toLowerCase().includes(query)).reverse();
  const root = element("events");
  root.replaceChildren();
  for (const entry of entries.slice(0, limit)) {
    const article = document.createElement("article");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "#"+entry.sequence+" · "+
      new Date(entry.recordedAt ?? 0).toLocaleString()+" · "+
      (labels[entry.kind] || entry.kind)+" · "+(entry.title || "ChatGPT");
    if (/failed|blocked/.test(entry.kind)) summary.className = "error";
    details.append(summary);
    const ids = document.createElement("p");
    const targets: readonly (readonly [string, string | undefined])[] = [
      ["Чат", entry.sourceChatId], ["Новый чат", entry.targetChatId],
    ];
    for (const [label, id] of targets) {
      if (!id) continue;
      const link = document.createElement("a");
      link.textContent = label + ": " + id;
      link.href = "https://chatgpt.com/c/" + encodeURIComponent(id);
      link.target = "_blank";
      link.rel = "noopener";
      ids.append(link, document.createElement("br"));
    }
    details.append(ids);
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(entry, null, 2);
    details.append(pre);
    article.append(details);
    root.append(article);
  }
  const start = journal?.meta?.startedAt;
  element("status").textContent = entries.length + " событий · журнал с " +
    (start ? new Date(start).toLocaleString() : "—") +
    "\nПрошлые автоповторы до начала журнала недоступны." +
    (journal?.storageError ? "\n⚠️ Ошибка записи: " + journal.storageError : "");
  element("more").hidden = entries.length <= limit;
}
async function refresh(): Promise<boolean> {
  const currentRefresh = ++journalRefreshVersion;
  try {
    const composed = (globalThis as typeof globalThis & {
      ChatGPTJournalModular?: { read(transport: {
        sendMessage(message: { type: "CHATGPT_JOURNAL_READ" }): Promise<unknown>;
      }): Promise<unknown> };
    }).ChatGPTJournalModular;
    if (!composed) throw new Error("Journal composition has not been loaded");
    const raw = await composed.read({
      sendMessage: (message) => chrome.runtime.sendMessage(message),
    });
    const latest = asJournalView(raw);
    if (currentRefresh !== journalRefreshVersion) return false;
    journal = latest;
    journalExport = raw;
    render();
    return true;
  } catch (error: unknown) {
    if (currentRefresh !== journalRefreshVersion) return false;
    // A failed refresh must not let Export hand out a previously loaded
    // snapshot as though it were the current durable journal.
    journal = null;
    journalExport = null;
    element("events").replaceChildren();
    element("more").hidden = true;
    element("status").textContent = "Не удалось прочитать журнал: " +
      (error instanceof Error ? error.message : String(error));
    return false;
  }
}
element("refresh").addEventListener("click", () => { void refresh(); });
element("filter").addEventListener("input", () => { limit = 200; render(); });
element("more").addEventListener("click", () => { limit += 200; render(); });
element("export").addEventListener("click", async () => {
  const refreshed = await refresh();
  if (!refreshed || !journal || !journalExport) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(journalExport, null, 2)], {
    type: "application/json;charset=utf-8",
  }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "chatgpt-journal-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});
void refresh();
