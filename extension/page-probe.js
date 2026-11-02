'use strict';

// Serialized into ChatGPT's MAIN world by chrome.scripting. No closure state,
// cookies, network requests, or translated-string matching.
function inspectChatError(alertIndex = 0, captureHistory = false, recoveryAction = null, expectedUrl = '', expectedPromptKey = '') {
  const alert = document.querySelectorAll('aside[role="alert"].text-danger, [role="status"]:has(.text-chatgpt-recovery)')[alertIndex];
  const button = alert?.querySelector('button');
  const origin = button || alert;
  if (!origin) return { action: 'unknown', messages: [] };
  const fiberKey = Object.keys(origin).find((key) => key.startsWith('__reactFiber$'));
  let fiber = fiberKey && origin[fiberKey];
  const messageIds = new Set();
  const visited = new Set();
  function inspectElement(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => inspectElement(item, depth + 1));
    } else {
      if (typeof value.props?.id === 'string') messageIds.add(value.props.id);
      inspectElement(value.props?.children, depth + 1);
    }
  }
  let entries = null;
  let inputDeliveryError = false;
  const errorCopy=alert.cloneNode(true);
  errorCopy.querySelectorAll('button,[role="button"],[aria-hidden="true"]').forEach(node=>node.remove());
  const visibleError=String(errorCopy.textContent||'').replace(/\s+/g,' ').trim();
  // Inspect the rendered button subtree only: scanning the component source
  // would match all possible error actions, including inactive branches.
  for (let i = 0; fiber && i < 45; i += 1, fiber = fiber.return) {
    const props = fiber.memoizedProps || {};
    if (i < 9) inspectElement(props.children);
    if (captureHistory && Array.isArray(props.entries)) entries = props.entries;
    const entry=props.entry;
    // Active-turn input delivery errors may omit the retry button altogether.
    // Bind to the native latest writable turn and its exact rendered error;
    // no language-specific phrase or arbitrary red text authorizes a retry.
    if(i<16 && entry?.isMostRecentTurn===true && entry.isReadOnly===false &&
        entry.showRequestUserInputStatus===true && entry.showPendingLoadingMessage===false &&
        entry.turn?.status==='in_progress' && typeof entry.errorMessage==='string' &&
        entry.errorMessage.replace(/\s+/g,' ').trim()===visibleError && visibleError) inputDeliveryError=true;
  }
  // The server's untranslated fallback can offer Start new chat even though
  // no length limit was reported. That CTA must not turn Unknown error into
  // a handoff. Require the native React error surface, then retry in place.
  const unknownServerError=Boolean(fiberKey) && /^unknown error[.!]?$/i.test(visibleError);
  const action = unknownServerError ? 'retry' : messageIds.has('chatgptConversations.responseError.startNewChat') ? 'new-chat'
    : messageIds.has('chatgptConversations.responseError.retry') ||
      (alert.querySelector('.text-chatgpt-recovery') && messageIds.has('errors.network.reconnecting_fallback')) || inputDeliveryError ? 'retry' : 'unknown';
  if (recoveryAction === 'stop-recovery') {
    const root = document.querySelector('[data-app-shell-active-page="true"]') || document;
    const chatRoute=value=>{try{const u=new URL(value);return u.origin==='https://chatgpt.com'?u.origin+(u.pathname==='/'?'/':u.pathname.replace(/\/$/,'')):'';}catch{return '';}};
    if (!chatRoute(expectedUrl)||chatRoute(location.href)!==chatRoute(expectedUrl) || !root.contains(alert) || !alert.getClientRects().length ||
        !alert.querySelector('.text-chatgpt-recovery') || !messageIds.has('errors.network.reconnecting_fallback')) {
      return {ok:false,reason:'Статус прерванного соединения не подтверждён'};
    }
    const latestUser = Array.from(root.querySelectorAll('[data-chatgpt-search-unit-key$=":user"], [data-message-author-role="user"], [data-turn="user"]')).at(-1);
    const latestUserKey=latestUser?.getAttribute('data-testid')||latestUser?.getAttribute('data-chatgpt-search-unit-key');
    if(expectedPromptKey&&(!latestUserKey||location.pathname+'|'+latestUserKey!==expectedPromptKey))return {ok:false,reason:'Запрос пользователя перед остановкой изменился'};
    if (latestUser && (alert.contains(latestUser) || (alert.compareDocumentPosition(latestUser) & 4))) return {ok:false,reason:'Обнаружен более новый запрос пользователя'};
    // This stop icon was verified in the real composer. Exact SVG structure
    // avoids translated labels; unknown future icons fail closed.
    const stop = Array.from(root.querySelectorAll('button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"], [data-composer-body] button[type="button"]:has(svg.icon-primary-action path[d^="M4.5 5.75C4.5"])')).find(node=>node.getClientRects().length);
    if (!stop) return {ok:false,stopped:false,reason:'Нативная кнопка остановки не найдена; автопродолжение отменено'};
    if (stop.disabled || stop.getAttribute('aria-disabled') === 'true') return {ok:false,reason:'Остановка временно недоступна'};
    stop.click();
    return {ok:true,stopped:true};
  }
  if (!captureHistory || action !== 'new-chat') return { action, messages: [] };
  if (!entries) return { action, messages: [], incomplete: true };
  function messageText(item) {
    if (item.type === 'user-message') return typeof item.message === 'string' ? item.message : '';
    const fallbacks = (item.contentReferences || []).map((ref) => ref.model_dil_v2?.fallbackMarkdown).filter((text) => typeof text === 'string' && text.trim());
    if (fallbacks.length) return fallbacks.join('\n\n');
    const text = typeof item.content === 'string' ? item.content : '';
    // Never forward a placeholder as if it were the full assistant response.
    return /::chatgpt-content-reference\{/.test(text) ? '' : text;
  }
  const all = [];
  for (const entry of entries) {
    for (const item of entry.turn?.items || []) {
      const role = item.type === 'user-message' ? 'user'
        : item.type === 'assistant-message' && (!item.phase || item.phase === 'final_answer') ? 'assistant' : null;
      if (role) all.push({ role, text: messageText(item), id: item.messageId || `${entry.id}:${all.length}` });
    }
  }
  const selected = new Set();
  for (const role of ['user', 'assistant']) {
    all.map((item, index) => ({ item, index })).filter(({ item }) => item.role === role).slice(-2)
      .forEach(({ index }) => selected.add(index));
  }
  const messages = all.filter((_, index) => selected.has(index));
  return { action, messages, incomplete: messages.some((item) => !item.text.trim()) ||
    messages.filter((item) => item.role === 'user').length !== 2 ||
    messages.filter((item) => item.role === 'assistant').length !== 2 };
}

function inspectChatAttachment(fileName) {
  const page = document.querySelector('[data-app-shell-active-page="true"]') || document;
  const root = page.querySelector('[data-composer-attachments]');
  if (!root) return { status: 'missing' };
  const label = Array.from(root.querySelectorAll('*')).find((node) => !node.children.length && node.textContent === fileName);
  if (!label) return { status: 'missing' };
  const key = Object.keys(label).find((name) => name.startsWith('__reactFiber$'));
  for (let fiber = key && label[key], i = 0; fiber && i < 20; i += 1, fiber = fiber.return) {
    const attachment = fiber.memoizedProps?.attachment;
    if (attachment?.name === fileName) return { status: attachment.status || 'unknown' };
  }
  return { status: 'unknown' };
}

// Read-only acknowledgement of an already clicked handoff. The composer being
// empty or a route changing is insufficient: require the exact native payload
// in the active conversation's React entries and a permanent destination.
function inspectHandoffAcceptance(options) {
  function canonical(value) {
    try {const url=new URL(value);return url.origin==='https://chatgpt.com'&&/^\/c\/[a-z0-9-]+\/?$/.test(url.pathname)
      ? `${url.origin}${url.pathname.replace(/\/$/,'')}`:'';} catch {return '';}
  }
  const targetUrl=canonical(location.href);
  if(!targetUrl||targetUrl===canonical(options.sourceUrl)||typeof options.submittedText!=='string'||!options.submittedText) return {ok:true,accepted:false};
  const previousTarget=canonical(options.targetUrl);
  if(previousTarget&&previousTarget!==targetUrl)return {ok:true,accepted:false};
  const root=document.querySelector('[data-app-shell-active-page="true"]')||document;
  const visible=node=>Boolean(node?.isConnected&&node.getClientRects().length&&!node.closest('[inert], [aria-hidden="true"], [data-app-shell-active-page="false"]'));
  const aliases=new Set();
  const chatId=new URL(targetUrl).pathname.split('/').at(-1);
  let nativeMismatch=false;
  for(const node of root.querySelectorAll('header button')) {
    if(!visible(node))continue;
    const key=Object.keys(node).find(name=>name.startsWith('__reactFiber$'));
    for(let fiber=key&&node[key],i=0;fiber&&i<20;i++,fiber=fiber.return) {
      const id=fiber.memoizedProps?.conversationId;
      if(typeof id==='string'&&id.startsWith('local-chatgpt:'))aliases.add(id);
      else if(typeof id==='string'&&id&&id!==chatId)nativeMismatch=true;
    }
  }
  if(nativeMismatch||(options.conversationAlias&&aliases.size&&(!aliases.has(options.conversationAlias)||aliases.size!==1)))return {ok:true,accepted:false};
  const anchors=Array.from(root.querySelectorAll('[data-composer-body], [data-turn-key], [data-testid^="conversation-turn-"], [data-message-author-role], [data-chatgpt-search-unit-key]')).filter(visible).slice(0,24);
  const inspected=new Set();
  for(const node of anchors) {
    const key=Object.keys(node).find(name=>name.startsWith('__reactFiber$'));
    for(let fiber=key&&node[key],i=0;fiber&&i<50;i++,fiber=fiber.return) {
      if(inspected.has(fiber))continue;inspected.add(fiber);
      const entries=fiber.memoizedProps?.entries;
      if(!Array.isArray(entries))continue;
      for(const entry of entries)for(const item of entry.turn?.items||[]) {
        if(item.type==='user-message'&&item.message===options.submittedText&&typeof item.messageId==='string'&&item.messageId) {
          return {ok:true,accepted:true,targetUrl,messageId:item.messageId,entryId:entry.id||null};
        }
      }
    }
  }
  return {ok:true,accepted:false};
}

// Atomic validation + one click in the page's world. DOM text alone can be
// ahead of React/ProseMirror and must never authorize sending a user's draft.
function controlChatComposer(options) {
  const root = document.querySelector('[data-app-shell-active-page="true"]') || document;
  const visible = (node) => Boolean(node?.isConnected && node.getClientRects().length);
  const editor = Array.from(root.querySelectorAll('#prompt-textarea[contenteditable="true"], textarea#prompt-textarea, [data-composer-markdown][contenteditable="true"]')).find(visible);
  if (!editor || location.href !== options.url) return { ok: false, reason: 'Чат или поле сообщения изменились' };
  let controller = null;
  for (let node = editor; node && !controller; node = node.parentElement) {
    const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
    for (let fiber = key && node[key], depth = 0; fiber && depth < 16; fiber = fiber.return, depth += 1) {
      const candidate = fiber.memoizedProps?.composerController;
      if (candidate?.view?.dom === editor && typeof candidate.getChatGptPrompt === 'function') { controller = candidate; break; }
    }
  }
  if (!controller) return { ok: false, reason: 'Не удалось проверить состояние редактора ChatGPT' };
  function visibleText() {
    if (editor.value !== undefined) return editor.value;
    if (!editor.querySelector('p, div, br, li')) return editor.textContent || '';
    const copy = editor.cloneNode(true);
    copy.querySelectorAll('[aria-hidden="true"], .ProseMirror-widget, svg, button').forEach(node=>node.remove());
    function text(node) {
      if (node.nodeType === 3) return node.textContent || '';
      if (node.nodeType !== 1) return '';
      if (node.tagName === 'BR') return node.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
      return Array.from(node.childNodes).map(text).join(['UL','OL'].includes(node.tagName) ? '\n' : '');
    }
    return Array.from(copy.childNodes).map(text).join('\n');
  }
  const actualPrompt = controller.getChatGptPrompt();
  const prompt = actualPrompt?.prompt;
  const plainMatches = controller.getPlainText() === options.text && visibleText() === options.text;
  function literalSerializationMatches() {
    // Native Markdown mode escapes punctuation and wraps generated URL links.
    // Permit the native serialization only for an independently checked plain
    // document: no mentions, hidden nodes, custom links, formatting or hints.
    const doc = controller.view.state?.doc;
    if (!doc?.toJSON || typeof controller.markdownEditor?.serialize !== 'function' ||
        actualPrompt.systemHints?.length) return false;
    const value = doc.toJSON();
    if (value.type !== 'doc' || value.marks?.length || !Array.isArray(value.content)) return false;
    const lines = [];
    for (const paragraph of value.content) {
      if (paragraph.type !== 'paragraph' || paragraph.marks?.length) return false;
      let line = '';
      for (const node of paragraph.content || []) {
        if (node.type !== 'text' || typeof node.text !== 'string') return false;
        for (const mark of node.marks || []) {
          const attrs = mark.attrs || {};
          if (mark.type !== 'link' || attrs.isAutolink !== true || attrs.isGeneratedAutolink !== true ||
              attrs.href !== node.text || !/^https?:\/\//.test(attrs.href) || attrs.title || attrs.disabled ||
              attrs.literalMarkdownSource || attrs.literalMarkdownOccurrenceId || attrs.sourceAppId) return false;
        }
        line += node.text;
      }
      lines.push(line);
    }
    return lines.join('\n') === options.text && controller.markdownEditor.serialize(doc) === prompt;
  }
  const promptMatches = typeof prompt === 'string' && (prompt === options.text || (plainMatches && literalSerializationMatches()));
  const matches = plainMatches && promptMatches;
  const ready = controller.submitReady === true && controller.pendingSubmit == null;
  const effort = Array.from(root.querySelectorAll('[data-composer-navigation-target="reasoning"][data-selected-reasoning-effort]')).find(visible)?.getAttribute('data-selected-reasoning-effort') || null;
  if (options.action === 'inspect') return {ok:true,matches,plainMatches,promptMatches,ready,effort,promptChars:typeof prompt==='string'?prompt.length:null};
  if (options.action !== 'send' || !matches || !ready || (options.requireMax && effort !== 'max')) {
    return {ok:false,reason:'Текст, готовность редактора или уровень рассуждения не подтверждены',matches,ready,effort};
  }
  const attachments = root.querySelector('[data-composer-attachments]');
  if (attachments?.children.length && !options.fileName) return {ok:false,reason:'В поле есть пользовательское вложение'};
  if (options.fileName) {
    const found = new Set();
    for (const node of attachments?.querySelectorAll('*') || []) {
      const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
      for(let fiber=key&&node[key],i=0;fiber&&i<5;i++,fiber=fiber.return){
        const attachment=fiber.memoizedProps?.attachment;
        if(attachment?.name)found.add(attachment);
      }
    }
    if(found.size!==1 || !Array.from(found).every(file=>file.name===options.fileName&&file.status==='ready')) return {ok:false,reason:'Вложение истории не подтверждено или есть лишние файлы'};
  }
  const button = Array.from(root.querySelectorAll('button[data-testid="send-button"], button#composer-submit-button, [data-composer-body] button[type="submit"]')).find(visible);
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return {ok:false,reason:'Кнопка отправки недоступна'};
  // No await between checking the actual prompt and clicking its own button.
  const clickedAt=Date.now();
  button.click();
  let conversationAlias='';
  try {const id=decodeURIComponent(new URL(location.href).pathname.split('/').at(-1)||'');if(/^local-chatgpt:[a-z0-9-]+$/.test(id))conversationAlias=id;}catch{}
  return {ok:true,clicked:true,effort,promptChars:prompt.length,submittedText:prompt,clickedAt,conversationAlias};
}
