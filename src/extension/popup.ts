"use strict";

// Popup owns only the user-facing controls. The service worker remains the
// exclusive authority for durable handoff, notification and send operations.
interface PopupChrome {
  runtime: {
    sendMessage(message: Record<string, unknown>): Promise<unknown>;
    getURL(relativePath: string): string;
  };
  tabs: { create(options: { url: string }): Promise<unknown> };
}
declare const chrome: PopupChrome;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error("Missing popup element: " + id);
  return found as T;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const button = element<HTMLButtonElement>("test");
const status = element<HTMLElement>("status");

button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "Dispatching both channels...";
  try {
    const result = record(await chrome.runtime.sendMessage({ type: "TEST_BOTH" }));
    if (!result?.ok) throw new Error(typeof result?.error === "string" ? result.error : "Unknown error");
    status.textContent = "Sound + desktop notification dispatched.";
  } catch (error: unknown) {
    status.textContent = "Test failed: " + errorText(error);
  } finally {
    button.disabled = false;
  }
});

element<HTMLButtonElement>("handoff").addEventListener("click", async () => {
  const result = record(await chrome.runtime.sendMessage({ type: "CHATGPT_HANDOFF_DOWNLOAD" }));
  if (!result?.ok || typeof result.text !== "string") {
    status.textContent = "В этой вкладке пока нет сохранённой передачи.";
    return;
  }
  const text = result.text + (typeof result.draft === "string" && result.draft
    ? "\n\n--- Неотправленный черновик ---\n" + result.draft : "");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "chat-handoff-recovery.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

element<HTMLButtonElement>("journal").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("journal.html") });
});

const titleRecovery = element<HTMLElement>("title-recovery");
const recoverTitle = element<HTMLButtonElement>("recover-title");
interface RecoveryInfo {
  operationId: string;
  tabId: number;
  targetUrl: string;
  desiredTitle: string;
}
let recoveryInfo: RecoveryInfo | null = null;
void chrome.runtime.sendMessage({ type: "CHATGPT_HANDOFF_TITLE_INFO" }).then((info) => {
  const value = record(info);
  if (!value?.ok || !value.available ||
      typeof value.operationId !== "string" || typeof value.tabId !== "number" ||
      typeof value.targetUrl !== "string" || typeof value.desiredTitle !== "string") return;
  recoveryInfo = {
    operationId: value.operationId, tabId: value.tabId,
    targetUrl: value.targetUrl, desiredTitle: value.desiredTitle,
  };
  element<HTMLElement>("desired-title").textContent = value.desiredTitle;
  titleRecovery.hidden = false;
}).catch(() => {});

recoverTitle.addEventListener("click", async () => {
  const target = recoveryInfo;
  if (!target || recoverTitle.disabled) return;
  recoverTitle.disabled = true;
  status.textContent = "Восстанавливаем название...";
  try {
    const result = record(await chrome.runtime.sendMessage({
      type: "CHATGPT_HANDOFF_RENAME_RECOVER",
      operationId: target.operationId, tabId: target.tabId,
      targetUrl: target.targetUrl, desiredTitle: target.desiredTitle,
    }));
    if (!result?.ok || result.skipped || result.available === false) {
      throw new Error(typeof result?.reason === "string" ? result.reason : "Восстановление больше недоступно");
    }
    status.textContent = "Название чата восстановлено.";
    titleRecovery.hidden = true;
  } catch (error: unknown) {
    status.textContent = "Название не восстановлено: " + errorText(error);
  }
});
