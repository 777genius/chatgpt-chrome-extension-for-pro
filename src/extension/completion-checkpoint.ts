"use strict";

// Durable, prompt-bound checkpoint. Unknown outcome must never authorize a new
// send; a delayed receipt must not close a newer request.
interface CheckpointIntent {
  url: string;
  baselineKey: string;
  at: number;
}
interface CheckpointRequest {
  url: string;
  startedAt: number;
  requestId?: string | null;
}
interface CheckpointUpdate extends CheckpointRequest {
  baselineKey?: string;
  promptKey?: string;
  httpCompleted?: boolean;
}
interface CheckpointRecord extends Record<string, unknown> {
  schema?: number;
  state?: string;
  url?: string;
  startedAt?: number;
  attemptId?: string;
  requestId?: string | null;
  baselineKey?: string | null;
  promptKey?: string;
  httpCompleted?: boolean;
  pendingIntent?: CheckpointIntent;
}
interface CheckpointChromeStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, CheckpointRecord>): Promise<unknown>;
}
const checkpointHost = globalThis as typeof globalThis & {
  chrome: { storage: { local: CheckpointChromeStorage } };
};

function completionCheckpointUrl(value: string): string {
  try {
    const u = new URL(value);
    return u.origin === "https://chatgpt.com" &&
      (u.pathname === "/" || /^\/c\/[a-z0-9-]+\/?$/.test(u.pathname))
      ? u.origin + (u.pathname === "/" ? "/" : u.pathname.replace(/\/$/, ""))
      : "";
  } catch { return ""; }
}

const completionCheckpointWrites = new Map<number, Promise<unknown>>();
function completionCheckpointKey(tabId: number): string {
  return "chatgpt-completion-checkpoint:" + tabId;
}
function asCheckpointRecord(value: unknown): CheckpointRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as CheckpointRecord : null;
}
function completionCheckpointChange<T>(
  tabId: number,
  change: (record: CheckpointRecord | null) => { record?: CheckpointRecord; value: T },
): Promise<T> {
  const prior = completionCheckpointWrites.get(tabId) || Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    const key = completionCheckpointKey(tabId);
    const record = asCheckpointRecord((await checkpointHost.chrome.storage.local.get(key))[key]);
    const result = change(record);
    if (result.record) await checkpointHost.chrome.storage.local.set({ [key]: result.record });
    return result.value;
  });
  completionCheckpointWrites.set(tabId, next);
  void next.finally(() => {
    if (completionCheckpointWrites.get(tabId) === next) completionCheckpointWrites.delete(tabId);
  }).catch(() => {});
  return next;
}
function completionCheckpointRead(tabId: number): Promise<CheckpointRecord | null> {
  return completionCheckpointChange(tabId, (record) => ({ value: record }));
}
function completionCheckpointIntent(tabId: number, intent: CheckpointIntent): Promise<boolean> {
  if (typeof intent.url !== "string" || typeof intent.baselineKey !== "string" ||
      !Number.isFinite(intent.at)) return Promise.resolve(false);
  return completionCheckpointChange(tabId, (current) => ({
    record: { ...current, schema: 1, pendingIntent: {
      url: intent.url, baselineKey: intent.baselineKey, at: intent.at,
    } },
    value: true,
  }));
}
function completionCheckpointStart(tabId: number, request: CheckpointRequest): Promise<CheckpointRecord> {
  return completionCheckpointChange(tabId, (current) => {
    const startedAt = current?.startedAt;
    if (typeof startedAt === "number" &&
        (startedAt > request.startedAt ||
          (startedAt === request.startedAt && current?.requestId === request.requestId))) {
      return { value: current! };
    }
    const intent = current?.pendingIntent;
    const matches = intent && intent.url === request.url &&
      request.startedAt >= intent.at && request.startedAt - intent.at <= 10000;
    const record: CheckpointRecord = {
      schema: 1, state: "active", url: request.url, startedAt: request.startedAt,
      attemptId: String(request.startedAt), requestId: request.requestId || null,
      baselineKey: matches ? intent.baselineKey : null, promptKey: "", httpCompleted: false,
    };
    return { record, value: record };
  });
}
function completionCheckpointUpdate(tabId: number, update: CheckpointUpdate): Promise<boolean> {
  return completionCheckpointChange(tabId, (current) => {
    if (!current || current.state !== "active" || current.startedAt !== update.startedAt ||
        (current.requestId && current.requestId !== update.requestId)) return { value: false };
    const allocating = current.url === "https://chatgpt.com/" &&
      /^https:\/\/chatgpt\.com\/c\/[a-z0-9-]+$/.test(update.url);
    if (current.url !== update.url && !allocating) return { value: false };
    if (update.baselineKey !== undefined && typeof update.baselineKey !== "string") return { value: false };
    if (current.baselineKey !== null && update.baselineKey !== undefined &&
        current.baselineKey !== update.baselineKey) return { value: false };
    if (current.promptKey && update.promptKey &&
        current.promptKey !== update.promptKey) return { value: false };
    const baselineKey = current.baselineKey ?? update.baselineKey ?? null;
    const promptKey = update.promptKey || current.promptKey;
    if (promptKey && ((!baselineKey && baselineKey !== "") ||
      promptKey === baselineKey)) return { value: false };
    const record: CheckpointRecord = {
      ...current, url: update.url, baselineKey, promptKey,
      httpCompleted: current.httpCompleted || update.httpCompleted === true,
    };
    return { record, value: true };
  });
}
function completionCheckpointFinish(
  tabId: number, startedAt: number, state: string, requestId: string | null = null,
): Promise<boolean> {
  return completionCheckpointChange(tabId, (current) => {
    if (!current) return { value: true }; // pre-checkpoint historical requests
    if (current.state !== "active" || current.startedAt !== startedAt ||
        (current.requestId && current.requestId !== requestId)) return { value: false };
    const { pendingIntent: _pendingIntent, ...metadata } = current;
    return { record: { ...metadata, state }, value: true };
  });
}
