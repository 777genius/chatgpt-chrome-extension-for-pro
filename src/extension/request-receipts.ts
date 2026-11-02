"use strict";

// A bounded worker-local/session cache, not the durable journal.
interface CachedRequestReceipt extends Record<string, unknown> {
  tabId: number;
  cachedAt: number;
  requestId?: string | null;
  startedAt?: number;
  url?: string;
  consumed?: boolean;
}
type StorageRecord = Record<string, unknown>;
interface ReceiptStorage {
  get(key: string): Promise<StorageRecord>;
  set(value: StorageRecord): Promise<unknown>;
}
const receiptChrome = globalThis as typeof globalThis & {
  chrome: { storage: { session?: ReceiptStorage; local: ReceiptStorage } };
};
const requestReceiptStorage = receiptChrome.chrome.storage.session || receiptChrome.chrome.storage.local;
const REQUEST_RECEIPTS_KEY = "chatgpt-request-receipts";
let requestReceiptWrites: Promise<unknown> = Promise.resolve();

function isCachedRequestReceipt(value: unknown): value is CachedRequestReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as StorageRecord;
  return Number.isFinite(entry.cachedAt) && typeof entry.tabId === "number";
}
function changeRequestReceipts<Result>(
  change: (records: CachedRequestReceipt[]) => { write?: boolean; value: Result },
): Promise<Result> {
  const next = requestReceiptWrites.catch(() => {}).then(async () => {
    const saved = (await requestReceiptStorage.get(REQUEST_RECEIPTS_KEY))[REQUEST_RECEIPTS_KEY];
    const candidates: unknown[] = Array.isArray(saved) ? saved : [];
    const records = candidates.filter(isCachedRequestReceipt)
      .filter((item) => Date.now() - item.cachedAt < 86400000);
    const result = change(records);
    if (result.write) await requestReceiptStorage.set({ [REQUEST_RECEIPTS_KEY]: records.slice(-128) });
    return result.value;
  });
  requestReceiptWrites = next;
  return next;
}
function rememberRequestReceipt(
  tabId: number,
  request: Record<string, unknown> & { requestId?: string | null; startedAt?: number; url?: string },
): Promise<CachedRequestReceipt> {
  return changeRequestReceipts((records) => {
    const duplicate = records.findIndex((item) =>
      item.tabId === tabId && item.requestId === request.requestId &&
      item.startedAt === request.startedAt);
    if (duplicate >= 0) return { value: records[duplicate]! };
    const entry: CachedRequestReceipt = { ...request, tabId, cachedAt: Date.now() };
    records.push(entry);
    return { write: true, value: entry };
  });
}
function readRequestReceipt(
  tabId: number,
  { requestId, startedAt, url, consume = false }: {
    requestId?: string | null; startedAt?: number; url?: string; consume?: boolean;
  } = {},
): Promise<CachedRequestReceipt | null> {
  return changeRequestReceipts((records) => {
    const candidates = records.filter((item) => item.tabId === tabId &&
      (!url || !item.url || item.url === url));
    const entry = requestId ? candidates.find((item) => item.requestId === requestId) :
      startedAt !== undefined
        ? candidates.find((item) => !item.requestId && item.startedAt === startedAt)
        : candidates.at(-1);
    if (!entry || (startedAt !== undefined && entry.startedAt !== startedAt) ||
        (consume && entry.consumed)) return { value: null };
    if (consume) entry.consumed = true;
    return { write: consume, value: entry };
  });
}
function forgetRequestReceipts(tabId: number): Promise<void> {
  return changeRequestReceipts((records) => {
    for (let i = records.length - 1; i >= 0; i--) if (records[i]?.tabId === tabId) records.splice(i, 1);
    return { write: true, value: undefined };
  });
}
