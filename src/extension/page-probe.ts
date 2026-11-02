"use strict";

// MAIN-world entry points are serialized by Chrome and MUST have no captured
// runtime dependencies. Type declarations disappear from the generated JS.
interface NativeMessage {
  type?: string; messageId?: string; message?: string; phase?: string;
  completed?: boolean; content?: string;
  contentReferences?: { model_dil_v2?: { fallbackMarkdown?: string } }[];
}
interface NativeEntry {
  id?: string; isMostRecentTurn?: boolean; isReadOnly?: boolean;
  showRequestUserInputStatus?: boolean; showPendingLoadingMessage?: boolean;
  errorMessage?: string;
  turn?: { status?: string; items?: NativeMessage[] };
}
interface NativeAttachment { name?: string; status?: string }
interface EditorMark {
  type?: string;
  attrs?: { isAutolink?: boolean; isGeneratedAutolink?: boolean; href?: string;
    title?: unknown; disabled?: unknown; literalMarkdownSource?: unknown;
    literalMarkdownOccurrenceId?: unknown; sourceAppId?: unknown };
}
interface EditorNode { type?: string; text?: string; marks?: EditorMark[]; content?: EditorNode[] }
interface EditorDocument { toJSON(): EditorNode }
interface ComposerController {
  view: { dom: Element; state?: { doc?: EditorDocument } };
  getChatGptPrompt(): { prompt?: string; systemHints?: readonly unknown[] };
  getPlainText(): string;
  submitReady: boolean;
  pendingSubmit?: unknown;
  pendingBrowserAutocompleteSubmission?: unknown;
  markdownEditor?: { serialize(doc: EditorDocument): string };
}
interface ReactFiber {
  return?: ReactFiber | null;
  memoizedProps?: {
    children?: unknown; entries?: NativeEntry[]; entry?: NativeEntry;
    isLoading?: boolean; isStartButtonAllowed?: boolean;
    composerController?: ComposerController;
    attachment?: NativeAttachment;
    conversationId?: string;
  };
}
interface RecoveryBinding {
  kind: "user" | "assistant-only"; url: string; entryId: string;
  assistantId: string; userId: string | null;
}
interface ChatErrorOutcome {
  ok?: boolean; action?: string; messages?: {role:string;text:string;id:string}[];
  recoveryBinding?: RecoveryBinding | null; incomplete?: boolean;
  reason?: string; idle?: boolean; stopped?: boolean; needsStop?: boolean;
  proof?: string;
}
interface ComposerOptions {
  action: "inspect" | "send"; url: string; text: string;
  requireMax?: boolean; fileName?: string;
}
interface HandoffOptions {
  sourceUrl: string; targetUrl?: string; submittedText: string;
  conversationAlias?: string;
}

// Serialized into ChatGPT's MAIN world by chrome.scripting. No closure state,
// cookies, network requests, or translated-string matching.
function inspectChatError(alertIndex: number = 0, captureHistory: boolean = false, recoveryAction: 'stop-recovery'|'inspect-recovery'|null = null, expectedUrl: string = '', expectedPromptKey: string = '', expectedRecoveryBinding: RecoveryBinding|null = null): ChatErrorOutcome {
  const alert = document.querySelectorAll('aside[role="alert"].text-danger, [role="status"]:has(.text-chatgpt-recovery)')[alertIndex];
  const button = alert?.querySelector('button');
  const origin = button || alert;
  if (!origin) return { action: 'unknown', messages: [] };
  const fiberKey = Object.keys(origin).find((key) => key.startsWith('__reactFiber$'));
  const observedFiber: unknown = fiberKey ? Reflect.get(origin, fiberKey) : null;
  let fiber:ReactFiber|null = observedFiber&&typeof observedFiber==='object' ? observedFiber as ReactFiber : null;
  const messageIds = new Set<string>();
  const visited = new Set<object>();
  function inspectElement(value: unknown, depth: number = 0): void {
    if (!value || typeof value !== 'object' || depth > 12 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => inspectElement(item, depth + 1));
    } else {
      const props:unknown=Reflect.get(value,'props');
      if(props&&typeof props==='object'){
        const id=Reflect.get(props,'id');
        if(typeof id==='string')messageIds.add(id);
        inspectElement(Reflect.get(props,'children'), depth+1);
      }
    }
  }
  let entries:NativeEntry[]|null = null;
  let recoveryEntry:NativeEntry|null = null;
  let inputDeliveryError = false;
  const alertContainer=alert.closest('[data-content-search-turn-key],[data-testid^="conversation-turn-"]');
  const alertContainerKey=alertContainer?.getAttribute('data-content-search-turn-key')||alertContainer?.getAttribute('data-testid');
  const errorCopy=alert.cloneNode(true) as Element;
  errorCopy.querySelectorAll('button,[role="button"],[aria-hidden="true"]').forEach(node=>node.remove());
  const visibleError=String(errorCopy.textContent||'').replace(/\s+/g,' ').trim();
  // Inspect the rendered button subtree only: scanning the component source
  // would match all possible error actions, including inactive branches.
  for (let i = 0; fiber && i < 45; i += 1, fiber = fiber.return) {
    const props = fiber.memoizedProps || {};
    if (i < 9) inspectElement(props.children);
    if (captureHistory && Array.isArray(props.entries)) entries = props.entries;
    const entry=props.entry;
    const candidate=entry?.isMostRecentTurn===true?entry:Array.isArray(props.entries)?props.entries.at(-1):null;
    if(candidate?.isMostRecentTurn===true&&candidate.isReadOnly===false)recoveryEntry=candidate;
    // Active-turn input delivery errors may omit the retry button altogether.
    // Bind to the native latest writable turn and its exact rendered error;
    // no language-specific phrase or arbitrary red text authorizes a retry.
    if(i<16 && entry?.id&&alertContainerKey===entry.id && entry.isMostRecentTurn===true && entry.isReadOnly===false &&
        entry.showRequestUserInputStatus===true && entry.showPendingLoadingMessage===false &&
        ['in_progress','complete'].includes(entry.turn?.status||'') && typeof entry.errorMessage==='string' &&
        entry.errorMessage.replace(/\s+/g,' ').trim()===visibleError && visibleError) inputDeliveryError=true;
  }
  // The owner's recovery policy follows the rendered native action: an
  // explicit Start new chat also transfers Unknown error through the existing
  // history handoff. Without that action, its native fallback retries in place.
  const unknownServerError=Boolean(fiberKey) && /^unknown error[.!]?$/i.test(visibleError);
  const action = messageIds.has('chatgptConversations.responseError.startNewChat') ? 'new-chat'
    : unknownServerError || messageIds.has('chatgptConversations.responseError.retry') ||
      (alert.querySelector('.text-chatgpt-recovery') && messageIds.has('errors.network.reconnecting_fallback')) || inputDeliveryError ? 'retry' : 'unknown';
  const recoverySurface=Boolean(alert.querySelector('.text-chatgpt-recovery'))&&messageIds.has('errors.network.reconnecting_fallback');
  const nativeUsers=(recoveryEntry?.turn?.items||[]).filter(item=>item.type==='user-message');
  const nativeAssistant=(recoveryEntry?.turn?.items||[]).filter(item=>item.type==='assistant-message'&&typeof item.messageId==='string'&&item.messageId).at(-1);
  const nativeUser=nativeUsers.at(-1);
  const recoveryContainer=alert.closest('[data-content-search-turn-key],[data-testid^="conversation-turn-"]');
  const recoveryContainerKey=recoveryContainer?.getAttribute('data-content-search-turn-key')||recoveryContainer?.getAttribute('data-testid');
  let recoveryBinding: RecoveryBinding | null = null;
  if (recoverySurface && recoveryEntry?.id && recoveryContainerKey===recoveryEntry.id &&
      nativeAssistant?.messageId && (!nativeUser || nativeUser.messageId)) {
    recoveryBinding = {
      kind: nativeUsers.length ? 'user' : 'assistant-only',
      url: location.origin+location.pathname, entryId: recoveryEntry.id,
      assistantId: nativeAssistant.messageId, userId: nativeUser?.messageId||null,
    };
  }
  if (recoveryAction === 'stop-recovery'||recoveryAction==='inspect-recovery') {
    const root = document.querySelector('[data-app-shell-active-page="true"]') || document;
    const chatRoute=(value:string):string=>{try{const u=new URL(value);return u.origin==='https://chatgpt.com'?u.origin+(u.pathname==='/'?'/':u.pathname.replace(/\/$/,'')):'';}catch{return '';}};
    if (!chatRoute(expectedUrl)||chatRoute(location.href)!==chatRoute(expectedUrl) || !root.contains(alert) || !alert.getClientRects().length ||
        !alert.querySelector('.text-chatgpt-recovery') || !messageIds.has('errors.network.reconnecting_fallback')) {
      return {ok:false,reason:'Статус прерванного соединения не подтверждён'};
    }
    const latestUser = Array.from(root.querySelectorAll('[data-chatgpt-search-unit-key$=":user"], [data-message-author-role="user"], [data-turn="user"]')).at(-1);
    const latestUserKey=latestUser?.getAttribute('data-testid')||latestUser?.getAttribute('data-chatgpt-search-unit-key');
    const observedBinding=recoveryBinding,requestedBinding=expectedRecoveryBinding;
    const sameRecovery=Boolean(observedBinding&&requestedBinding&&
      (['kind','url','entryId','assistantId','userId'] as const).every(key=>observedBinding[key]===requestedBinding[key]));
    const assistantOnly=sameRecovery&&recoveryBinding?.kind==='assistant-only'&&!latestUser&&expectedPromptKey===location.pathname;
    if(expectedRecoveryBinding&&!sameRecovery)return {ok:false,reason:'Нативный ответ перед восстановлением изменился'};
    if(expectedPromptKey&&!assistantOnly&&(!latestUserKey||location.pathname+'|'+latestUserKey!==expectedPromptKey))return {ok:false,reason:'Запрос пользователя перед остановкой изменился'};
    if (latestUser && (alert.contains(latestUser) || (alert.compareDocumentPosition(latestUser) & 4))) return {ok:false,reason:'Обнаружен более новый запрос пользователя'};
    // This stop icon was verified in the real composer. Exact SVG structure
    // avoids translated labels; unknown future icons fail closed.
    const stop = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"], [data-composer-body] button[type="button"]:has(svg.icon-primary-action path[d^="M4.5 5.75C4.5"])')).find(node=>node.getClientRects().length);
    if (!stop) {
      // A stale turn can remain in_progress after streaming ended. Require the
      // native voice control's explicit idle flags and the real editor controller,
      // never the absence of a Stop selector or a translated label alone.
      const visible=(node:Element|null|undefined):boolean=>Boolean(node?.isConnected&&node.getClientRects().length&&!node.closest('[inert],[aria-hidden="true"],[data-app-shell-active-page="false"]'));
      const voice=Array.from(root.querySelectorAll<HTMLButtonElement>('[data-composer-body] button')).find(node=>visible(node)&&!node.disabled&&node.getAttribute('aria-disabled')!=='true'&&node.getAttribute('aria-busy')!=='true'&&node.querySelector('use[href$="#codex-icon-voice-regular-20"]'));
      let nativeVoiceIdle=false;
      const voiceFiber=voice&&Object.keys(voice).find(key=>key.startsWith('__reactFiber$'));
      const voiceObserved:unknown=voiceFiber&&voice?Reflect.get(voice,voiceFiber):null;
      for(let current:ReactFiber|null=voiceObserved&&typeof voiceObserved==='object'?voiceObserved as ReactFiber:null,i=0;current&&i<16;i++,current=current.return??null){
        const props=current.memoizedProps;
        if(props?.isLoading===false&&props.isStartButtonAllowed===true)nativeVoiceIdle=true;
      }
      const editor=Array.from(root.querySelectorAll('#prompt-textarea[contenteditable="true"],textarea#prompt-textarea,[data-composer-markdown][contenteditable="true"]')).find(visible);
      let controller:ComposerController|null=null;
      for(let node=editor;node&&!controller;node=node.parentElement){
        const key=Object.keys(node).find(name=>name.startsWith('__reactFiber$'));
        const observed:unknown=key?Reflect.get(node,key):null;
        for(let current:ReactFiber|null=observed&&typeof observed==='object'?observed as ReactFiber:null,i=0;current&&i<16;i++,current=current.return??null){
          const candidate=current.memoizedProps?.composerController;
          if(candidate?.view?.dom===editor&&typeof candidate.getChatGptPrompt==='function'){controller=candidate;break;}
        }
      }
      if(sameRecovery&&voice&&nativeVoiceIdle&&controller&&controller.pendingSubmit==null&&controller.pendingBrowserAutocompleteSubmission==null&&typeof controller.submitReady==='boolean')return {ok:true,stopped:false,idle:true,proof:'native-voice-idle',recoveryBinding};
      return {ok:false,stopped:false,reason:'Нативная остановка или свободный редактор не подтверждены; автопродолжение отменено'};
    }
    if(recoveryAction==='inspect-recovery')return {ok:true,stopped:false,idle:false,needsStop:true,recoveryBinding};
    if (stop.disabled || stop.getAttribute('aria-disabled') === 'true') return {ok:false,reason:'Остановка временно недоступна'};
    stop.click();
    return {ok:true,stopped:true};
  }
  if (!captureHistory || action !== 'new-chat') return { action, messages: [], recoveryBinding };
  if (!entries) return { action, messages: [], incomplete: true };
  function messageText(item:NativeMessage):string {
    if (item.type === 'user-message') return typeof item.message === 'string' ? item.message : '';
    const fallbacks = (item.contentReferences || []).map((ref) => ref.model_dil_v2?.fallbackMarkdown).filter((text) => typeof text === 'string' && text.trim());
    if (fallbacks.length) return fallbacks.join('\n\n');
    const text = typeof item.content === 'string' ? item.content : '';
    // Never forward a placeholder as if it were the full assistant response.
    return /::chatgpt-content-reference\{/.test(text) ? '' : text;
  }
  const all:{role:'user'|'assistant';text:string;id:string}[]=[];
  for (const entry of entries) {
    for (const item of entry.turn?.items || []) {
      const role = item.type === 'user-message' ? 'user'
        : item.type === 'assistant-message' && (!item.phase || item.phase === 'final_answer') ? 'assistant' : null;
      if (role) all.push({ role, text: messageText(item), id: item.messageId || `${entry.id}:${all.length}` });
    }
  }
  const selected = new Set<number>();
  for (const role of ['user', 'assistant']) {
    all.map((item, index) => ({ item, index })).filter(({ item }) => item.role === role).slice(-2)
      .forEach(({ index }) => selected.add(index));
  }
  const messages = all.filter((_, index) => selected.has(index));
  return { action, messages, incomplete: messages.some((item) => !item.text.trim()) ||
    messages.filter((item) => item.role === 'user').length !== 2 ||
    messages.filter((item) => item.role === 'assistant').length !== 2 };
}

function inspectChatAttachment(fileName:string):{status:string} {
  const page = document.querySelector('[data-app-shell-active-page="true"]') || document;
  const root = page.querySelector('[data-composer-attachments]');
  if (!root) return { status: 'missing' };
  const label = Array.from(root.querySelectorAll('*')).find((node) => !node.children.length && node.textContent === fileName);
  if (!label) return { status: 'missing' };
  const key = Object.keys(label).find((name) => name.startsWith('__reactFiber$'));
  const observed:unknown=key?Reflect.get(label,key):null;
  for (let fiber:ReactFiber|null=observed&&typeof observed==='object'?observed as ReactFiber:null, i = 0; fiber && i < 20; i += 1, fiber = fiber.return) {
    const attachment = fiber.memoizedProps?.attachment;
    if (attachment?.name === fileName) return { status: attachment.status || 'unknown' };
  }
  return { status: 'unknown' };
}

// Read-only acknowledgement of an already clicked handoff. The composer being
// empty or a route changing is insufficient: require the exact native payload
// in the active conversation's React entries and a permanent destination.
function inspectHandoffAcceptance(options:HandoffOptions) {
  function canonical(value:string):string {
    try {const url=new URL(value);return url.origin==='https://chatgpt.com'&&/^\/c\/[a-z0-9-]+\/?$/.test(url.pathname)
      ? `${url.origin}${url.pathname.replace(/\/$/,'')}`:'';} catch {return '';}
  }
  const targetUrl=canonical(location.href);
  if(!targetUrl||targetUrl===canonical(options.sourceUrl)||typeof options.submittedText!=='string'||!options.submittedText) return {ok:true,accepted:false};
  const previousTarget=canonical(options.targetUrl);
  if(previousTarget&&previousTarget!==targetUrl)return {ok:true,accepted:false};
  const root=document.querySelector('[data-app-shell-active-page="true"]')||document;
  const visible=(node:Element|null|undefined):boolean=>Boolean(node?.isConnected&&node.getClientRects().length&&!node.closest('[inert], [aria-hidden="true"], [data-app-shell-active-page="false"]'));
  const aliases=new Set<string>();
  const chatId=new URL(targetUrl).pathname.split('/').at(-1);
  let nativeMismatch=false;
  for(const node of root.querySelectorAll('header button')) {
    if(!visible(node))continue;
    const key=Object.keys(node).find(name=>name.startsWith('__reactFiber$'));
    const observed:unknown=key?Reflect.get(node,key):null;
    for(let fiber:ReactFiber|null=observed&&typeof observed==='object'?observed as ReactFiber:null,i=0;fiber&&i<20;i++,fiber=fiber.return??null) {
      const id=fiber.memoizedProps?.conversationId;
      if(typeof id==='string'&&id.startsWith('local-chatgpt:'))aliases.add(id);
      else if(typeof id==='string'&&id&&id!==chatId)nativeMismatch=true;
    }
  }
  if(nativeMismatch||(options.conversationAlias&&aliases.size&&(!aliases.has(options.conversationAlias)||aliases.size!==1)))return {ok:true,accepted:false};
  const anchors=Array.from(root.querySelectorAll('[data-composer-body], [data-turn-key], [data-testid^="conversation-turn-"], [data-message-author-role], [data-chatgpt-search-unit-key]')).filter(visible).slice(0,24);
  const inspected=new Set<ReactFiber>();
  for(const node of anchors) {
    const key=Object.keys(node).find(name=>name.startsWith('__reactFiber$'));
    const observed:unknown=key?Reflect.get(node,key):null;
    for(let fiber:ReactFiber|null=observed&&typeof observed==='object'?observed as ReactFiber:null,i=0;fiber&&i<50;i++,fiber=fiber.return??null) {
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
function controlChatComposer(options:ComposerOptions) {
  const root = document.querySelector('[data-app-shell-active-page="true"]') || document;
  const visible = (node:Element) => Boolean(node?.isConnected && node.getClientRects().length);
  const editor = Array.from(root.querySelectorAll('#prompt-textarea[contenteditable="true"], textarea#prompt-textarea, [data-composer-markdown][contenteditable="true"]')).find(visible);
  if (!editor || location.href !== options.url) return { ok: false, reason: 'Чат или поле сообщения изменились' };
  let controller:ComposerController|null = null;
  for (let node = editor; node && !controller; node = node.parentElement) {
    const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
    const observed:unknown=key?Reflect.get(node,key):null;
    for (let fiber:ReactFiber|null=observed&&typeof observed==='object'?observed as ReactFiber:null, depth = 0; fiber && depth < 16; fiber = fiber.return, depth += 1) {
      const candidate = fiber.memoizedProps?.composerController;
      if (candidate?.view?.dom === editor && typeof candidate.getChatGptPrompt === 'function') { controller = candidate; break; }
    }
  }
  if (!controller) return { ok: false, reason: 'Не удалось проверить состояние редактора ChatGPT' };
  const confirmedController=controller;
  function visibleText():string {
    const directValue:unknown=Reflect.get(editor,'value');
    if (directValue !== undefined) return typeof directValue==='string'?directValue:'';
    if (!editor.querySelector('p, div, br, li')) return editor.textContent || '';
    const copy = editor.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"], .ProseMirror-widget, svg, button').forEach(node=>node.remove());
    function text(node:Node):string {
      if (node.nodeType === 3) return node.textContent || '';
      if (node.nodeType !== 1) return '';
      const elementNode=node as Element;
      if (elementNode.tagName === 'BR') return elementNode.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
      return Array.from(node.childNodes).map(text).join(['UL','OL'].includes(elementNode.tagName) ? '\n' : '');
    }
    return Array.from(copy.childNodes).map(text).join('\n');
  }
  const actualPrompt = confirmedController.getChatGptPrompt();
  const prompt = actualPrompt?.prompt;
  const plainMatches = confirmedController.getPlainText() === options.text && visibleText() === options.text;
  function literalSerializationMatches():boolean {
    // Native Markdown mode escapes punctuation and wraps generated URL links.
    // Permit the native serialization only for an independently checked plain
    // document: no mentions, hidden nodes, custom links, formatting or hints.
    const doc = confirmedController.view.state?.doc;
    if (!doc?.toJSON || typeof confirmedController.markdownEditor?.serialize !== 'function' ||
        actualPrompt.systemHints?.length) return false;
    const value = doc.toJSON();
    if (value.type !== 'doc' || value.marks?.length || !Array.isArray(value.content)) return false;
    const lines:string[]=[];
    for (const paragraph of value.content) {
      if (paragraph.type !== 'paragraph' || paragraph.marks?.length) return false;
      let line = '';
      for (const node of paragraph.content || []) {
        if (node.type !== 'text' || typeof node.text !== 'string') return false;
        for (const mark of node.marks || []) {
          const attrs = mark.attrs || {};
          if (mark.type !== 'link' || attrs.isAutolink !== true || attrs.isGeneratedAutolink !== true ||
              attrs.href !== node.text || (typeof attrs.href!=='string'||!/^https?:\/\//.test(attrs.href)) || attrs.title || attrs.disabled ||
              attrs.literalMarkdownSource || attrs.literalMarkdownOccurrenceId || attrs.sourceAppId) return false;
        }
        line += node.text;
      }
      lines.push(line);
    }
    return lines.join('\n') === options.text && confirmedController.markdownEditor.serialize(doc) === prompt;
  }
  const promptMatches = typeof prompt === 'string' && (prompt === options.text || (plainMatches && literalSerializationMatches()));
  const matches = plainMatches && promptMatches;
  const ready = confirmedController.submitReady === true && confirmedController.pendingSubmit == null;
  const effort = Array.from(root.querySelectorAll('[data-composer-navigation-target="reasoning"][data-selected-reasoning-effort]')).find(visible)?.getAttribute('data-selected-reasoning-effort') || null;
  if (options.action === 'inspect') return {ok:true,matches,plainMatches,promptMatches,ready,effort,promptChars:typeof prompt==='string'?prompt.length:null};
  if (options.action !== 'send' || !matches || !ready || (options.requireMax && effort !== 'max')) {
    return {ok:false,reason:'Текст, готовность редактора или уровень рассуждения не подтверждены',matches,ready,effort};
  }
  const attachments = root.querySelector('[data-composer-attachments]');
  if (attachments?.children.length && !options.fileName) return {ok:false,reason:'В поле есть пользовательское вложение'};
  if (options.fileName) {
    const found = new Set<NativeAttachment>();
    for (const node of attachments?.querySelectorAll('*') || []) {
      const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
      const observed:unknown=key?Reflect.get(node,key):null;
      for(let fiber:ReactFiber|null=observed&&typeof observed==='object'?observed as ReactFiber:null,i=0;fiber&&i<5;i++,fiber=fiber.return??null){
        const attachment=fiber.memoizedProps?.attachment;
        if(attachment?.name)found.add(attachment);
      }
    }
    if(found.size!==1 || !Array.from(found).every(file=>file.name===options.fileName&&file.status==='ready')) return {ok:false,reason:'Вложение истории не подтверждено или есть лишние файлы'};
  }
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-testid="send-button"], button#composer-submit-button, [data-composer-body] button[type="submit"]')).find(visible);
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return {ok:false,reason:'Кнопка отправки недоступна'};
  // No await between checking the actual prompt and clicking its own button.
  const clickedAt=Date.now();
  button.click();
  let conversationAlias='';
  try {const id=decodeURIComponent(new URL(location.href).pathname.split('/').at(-1)||'');if(/^local-chatgpt:[a-z0-9-]+$/.test(id))conversationAlias=id;}catch{}
  return {ok:true,clicked:true,effort,promptChars:typeof prompt==='string'?prompt.length:null,submittedText:prompt,clickedAt,conversationAlias};
}
