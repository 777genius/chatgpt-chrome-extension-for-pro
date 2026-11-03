"use strict";

// MAIN-world adapter: every rename effect is tied to one persisted operation,
// the exact destination URL, and the native React menu/form state.
// The function must remain serializable by chrome.scripting.executeScript.
interface TitleOptions {
  action: "inspect" | "open" | "select" | "fill" | "save" | "cancel";
  url: string;
  operationId: string;
  title: string;
  previousTitle: string;
  expiresAt?: number;
  finalCleanup?: boolean;
}
interface TitleOperation {
  id: string;
  url: string;
  title: string;
  previousTitle: string;
  triggerId: string | null;
  form?: HTMLFormElement | null;
  sidebarFallback?: boolean;
  sidebarToggle?: HTMLButtonElement | null;
  createdAt: number;
  selected?: boolean;
  saved?: boolean;
  input?: HTMLInputElement | null;
}
interface NativeQuery {
  queryKey?: readonly unknown[];
  state?: { data?: { conversation_id?: string } };
}
interface NativeQueryClient {
  getQueryCache(): { getAll(): NativeQuery[] };
}
interface ReactTitleFiber {
  return?: ReactTitleFiber | null;
  memoizedProps?: {
    isStreaming?: boolean;
    conversationId?: string;
    isReady?: boolean;
    queryClient?: NativeQueryClient;
  };
  memoizedState?: {
    current?: { queryClient?: NativeQueryClient };
    next?: ReactTitleFiber["memoizedState"] | null;
  } | null;
}
interface TitleProbeResult {
  ok: boolean;
  reason?: string;
  retryable?: boolean;
  clicked?: boolean;
  pending?: boolean;
  ready?: boolean;
  streaming?: boolean;
  title?: string;
  url?: string;
  conversationId?: string | null;
}

function controlChatTitle(options: TitleOptions): TitleProbeResult {
  const globals = globalThis as typeof globalThis & {
    __chatgptNotifierTitleOperation?: TitleOperation;
  };
  const visible = (node: Element | null | undefined): boolean =>
    Boolean(node?.isConnected && node.getClientRects().length &&
      !node.closest('[inert], [aria-hidden="true"], [data-app-shell-active-page="false"]'));
  const chatUrl = (value: string): string => {
    try {
      const url = new URL(value);
      return url.origin === "https://chatgpt.com" && /^\/c\/[a-z0-9-]+\/?$/.test(url.pathname)
        ? url.origin + url.pathname.replace(/\/$/, "") : "";
    } catch { return ""; }
  };
  // Only read private React observations from this exact DOM node.
  const fiberOf = (node: Element): ReactTitleFiber | null => {
    const key = Object.keys(node).find((value) => value.startsWith("__reactFiber$"));
    const value: unknown = key ? Reflect.get(node, key) : null;
    return value !== null && typeof value === "object" ? value as ReactTitleFiber : null;
  };
  if (options.action === "cancel") {
    const state = globals.__chatgptNotifierTitleOperation;
    if (state?.id === options.operationId) {
      const candidates = Array.from(document.querySelectorAll<HTMLInputElement>(
        '[role="dialog"][aria-modal="true"] form input')).filter(visible);
      const input = state.input || (state.saved ? state.form?.querySelector<HTMLInputElement>('input') : state.selected && candidates.length === 1 ? candidates[0] : null);
      if (chatUrl(location.href) === state.url && input &&
          [state.title, state.previousTitle].includes(input.value)) {
        input.closest("form")?.querySelector<HTMLButtonElement>('button[type="button"]')?.click();
      }
      if (chatUrl(location.href) === state.url && !state.selected) {
        const menu = Array.from(document.querySelectorAll('[role="menu"]')).find((node) =>
          visible(node) && node.getAttribute("aria-labelledby") === state.triggerId);
        menu?.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", code: "Escape", bubbles: true,
        }));
      }
      const ownDialog = state.form?.closest('[role="dialog"][aria-modal="true"]');
      const ownClosing = chatUrl(location.href) === state.url &&
        state.sidebarToggle && ownDialog && visible(ownDialog) &&
        input && [state.title, state.previousTitle].includes(input.value);
      if (ownClosing && !options.finalCleanup) return { ok: true, pending: true };
      if (chatUrl(location.href) === state.url && state.sidebarToggle &&
          visible(state.sidebarToggle) && state.sidebarToggle.getAttribute('aria-expanded') === 'true' &&
          !Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some(visible)) {
        state.sidebarToggle.click();
      }
      delete globals.__chatgptNotifierTitleOperation;
    }
    return { ok: true };
  }
  if (!chatUrl(options.url) || chatUrl(location.href) !== chatUrl(options.url)) {
    return { ok: false, reason: "chat-changed" };
  }
  options = { ...options, url: chatUrl(options.url) };
  const chatId = new URL(options.url).pathname.split("/").at(-1);
  const root = document.querySelector('[data-app-shell-active-page="true"]') || document;
  const actions = Array.from(document.querySelectorAll<HTMLButtonElement>(
    'header button[aria-haspopup="menu"]')).find((node) =>
    visible(node) && node.querySelector('use[href*="ellipsis-horizontal"]'));
  let ready = false;
  let streaming = false;
  const nativeConversationIds = new Set<string>();
  for (const node of document.querySelectorAll<HTMLButtonElement>("header button")) {
    if (!visible(node)) continue;
    for (let fiber = fiberOf(node), i = 0; fiber && i < 18; i++, fiber = fiber.return ?? null) {
      const props = fiber.memoizedProps;
      if (props?.isStreaming === true && typeof props.conversationId === "string" &&
          (props.conversationId === chatId || /^local-chatgpt:/.test(props.conversationId))) {
        streaming = true;
      }
      if (props?.isReady === true && typeof props.conversationId === "string") {
        nativeConversationIds.add(props.conversationId);
        if (!node.disabled && node.getAttribute("aria-disabled") !== "true" &&
            props.isStreaming !== true && (props.conversationId === chatId ||
            /^local-chatgpt:/.test(props.conversationId))) ready = true;
      }
    }
  }
  let canonicalMismatch = false;
  const clients = new Set<NativeQueryClient>();
  const anchor = root.querySelector("[data-composer-body]") || root.querySelector("[data-turn-key]");
  for (let fiber = anchor && fiberOf(anchor), i = 0; fiber && i < 40;
    i++, fiber = fiber.return ?? null) {
    if (fiber.memoizedProps?.queryClient?.getQueryCache) clients.add(fiber.memoizedProps.queryClient);
    for (let hook = fiber.memoizedState, j = 0; hook && j < 35; j++, hook = hook.next ?? null) {
      const client = hook.current?.queryClient;
      if (client?.getQueryCache) clients.add(client);
    }
  }
  for (const client of clients) {
    const query = client.getQueryCache().getAll().find((q) =>
      q.queryKey?.[0] === "chatgpt-conversation" && q.queryKey[1] === chatId);
    if (query?.state?.data?.conversation_id && query.state.data.conversation_id !== chatId) {
      canonicalMismatch = true;
    }
  }
  ready = ready && !canonicalMismatch && !streaming;
  if (options.action === "inspect") return {
    ok: true, ready: ready && Boolean(actions), streaming, title: document.title,
    url: location.href,
    conversationId: nativeConversationIds.size === 1 ? Array.from(nativeConversationIds)[0] : null,
  };
  if (typeof options.expiresAt === "number" && Number.isFinite(options.expiresAt) &&
      Date.now() >= options.expiresAt) {
    return { ok: false, reason: "title-deadline-exceeded" };
  }
  let state = globals.__chatgptNotifierTitleOperation;
  if (options.action === "open") {
    if (!ready || !actions) return { ok: false, reason: "chat-not-ready" };
    if (document.title !== options.previousTitle ||
        Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some(visible)) {
      return { ok: false, reason: "title-or-form-changed" };
    }
    if (state && state.id !== options.operationId) return { ok: false, reason: "another-title-operation" };
    state = {
      id: options.operationId, url: options.url, title: options.title,
      previousTitle: options.previousTitle, triggerId: actions.id, createdAt: Date.now(),
    };
    globals.__chatgptNotifierTitleOperation = state;
    if (actions.getAttribute("data-state") !== "open") {
      actions.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, button: 0, pointerType: "mouse", ctrlKey: false,
      }));
      actions.click();
    }
    return { ok: true };
  }
  if (!state || state.id !== options.operationId || state.url !== options.url ||
      state.title !== options.title || Date.now() - state.createdAt > 60000) {
    return { ok: false, reason: "title-operation-changed" };
  }
  if (options.action === "select") {
    let menu: Element | null | undefined = Array.from(document.querySelectorAll('[role="menu"]')).find((node) =>
      Boolean(state.triggerId) && visible(node) && node.getAttribute("aria-labelledby") === state.triggerId);
    const rename = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])
      .find((node) => Array.from(node.querySelectorAll<HTMLElement>("[style]")).some((icon) => {
        try { return decodeURIComponent(icon.style.maskImage || "").includes("M11.7313 4.20472"); }
        catch { return false; }
      }));
    if (!rename && !state.selected) {
      // The server-bound sidebar can expose Rename before the header does.
      // Never use translated text or a different chat's sidebar menu.
      if (document.title !== state.previousTitle ||
          Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some(visible)) {
        return { ok: false, reason: "title-or-form-changed" };
      }
      const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[aria-current="page"][href]'))
        .find((node) => visible(node) && chatUrl(node.href) === state.url);
      const row = link?.closest('[data-sidebar-cycle-item]');
      const toggle = Array.from(document.querySelectorAll<HTMLButtonElement>('header button'))
        .find((node) => visible(node) && !node.disabled &&
          node.querySelector('use[href$="#codex-icon-sidebar-hidden-light-16"]'));
      if (!state.sidebarFallback && (row || toggle)) {
        menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        state.sidebarFallback = true;
        state.triggerId = null;
        menu = null;
      }
      if (state.sidebarFallback && !state.triggerId) {
        if (Array.from(document.querySelectorAll('[role="menu"]')).some(visible)) {
          return { ok: false, retryable: true, reason: "another-menu-open" };
        }
        if (!row && toggle && !state.sidebarToggle) {
          state.sidebarToggle = toggle;
          toggle.click();
          return { ok: false, retryable: true, reason: "sidebar-opening" };
        }
        const trigger = Array.from(row?.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]') || [])
          .find((node) => visible(node) && !node.disabled && !!node.id &&
            !!node.querySelector('use[href*="ellipsis-horizontal"]'));
        if (trigger) {
          state.triggerId = trigger.id;
          trigger.dispatchEvent(new PointerEvent("pointerdown",
            { bubbles: true, button: 0, pointerType: "mouse", ctrlKey: false }));
          trigger.click();
        }
      }
      return { ok: false, retryable: true, reason: "rename-menu-not-ready" };
    }
    if (!rename || rename.getAttribute("aria-disabled") === "true") {
      return { ok: false, retryable: true, reason: "rename-menu-not-ready" };
    }
    rename.click();
    state.selected = true;
    return { ok: true };
  }
  if (!state.selected) return { ok: false, reason: "rename-not-selected" };
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(
    '[role="dialog"][aria-modal="true"] form input')).filter(visible);
  const input = state.input || (inputs.length === 1 ? inputs[0] : null);
  const form = input?.closest("form");
  if (!input || !visible(input) || !form || !form.querySelector("h2") ||
      form.querySelectorAll("input").length !== 1 ||
      !form.querySelector('button[type="submit"]') ||
      form.querySelectorAll("button").length !== 2) {
    return { ok: false, retryable: true, reason: "rename-form-not-ready" };
  }
  if (options.action === "fill") {
    if (input.value !== state.previousTitle || document.title !== state.previousTitle) {
      return { ok: false, reason: "title-edited-by-user" };
    }
    state.input = input;
    state.form = form;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return { ok: false, reason: "title-model-not-ready" };
    setter.call(input, state.title);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true };
  }
  if (options.action === "save") {
    if (state.saved || state.input !== input || input.value !== state.title ||
        document.title !== state.previousTitle) {
      return { ok: false, reason: "title-form-changed" };
    }
    const key = Object.keys(input).find((value) => value.startsWith("__reactProps$"));
    const props: unknown = key ? Reflect.get(input, key) : null;
    if (!key || !props || typeof props !== "object" ||
        Reflect.get(props, "value") !== state.title) {
      return { ok: false, retryable: true, reason: "title-model-not-ready" };
    }
    const save = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!save || !visible(save) || save.disabled) {
      return { ok: false, retryable: true, reason: "title-save-not-ready" };
    }
    state.saved = true;
    save.click();
    state.input = null;
    if (!state.sidebarToggle) delete globals.__chatgptNotifierTitleOperation;
    return { ok: true, clicked: true };
  }
  return { ok: false, reason: "unknown-title-action" };
}
