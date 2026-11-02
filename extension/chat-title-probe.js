'use strict';

// MAIN-world adapter. Uses the observed native menu and form, never the chat
// composer. Every effect is bound to the saved destination and one operation.
function controlChatTitle(options) {
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length && !node.closest('[inert], [aria-hidden="true"], [data-app-shell-active-page="false"]'));
  // executeScript serializes this function into MAIN, so its route guard must
  // be self-contained. Query strings and fragments do not change a chat ID.
  const chatUrl = value => {
    try {
      const url=new URL(value);
      return url.origin==='https://chatgpt.com'&&/^\/c\/[a-z0-9-]+\/?$/.test(url.pathname)
        ? `${url.origin}${url.pathname.replace(/\/$/,'')}` : '';
    } catch { return ''; }
  };
  if (options.action==='cancel') {
    const state=globalThis.__chatgptNotifierTitleOperation;
    if(state?.id===options.operationId) {
      const candidates=Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"] form input')).filter(visible);
      const input=state.input||(state.selected&&candidates.length===1?candidates[0]:null);
      if(chatUrl(location.href)===state.url && input && [state.title,state.previousTitle].includes(input.value)) input.closest('form')?.querySelector('button[type="button"]')?.click();
      if(chatUrl(location.href)===state.url && !state.selected) {
        const menu=Array.from(document.querySelectorAll('[role="menu"]')).find(n=>visible(n)&&n.getAttribute('aria-labelledby')===state.triggerId);
        menu?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
      }
      delete globalThis.__chatgptNotifierTitleOperation;
    }
    return {ok:true};
  }
  if (!chatUrl(options.url) || chatUrl(location.href)!==chatUrl(options.url)) return {ok:false,reason:'chat-changed'};
  options={...options,url:chatUrl(options.url)};
  const chatId = new URL(options.url).pathname.split('/').at(-1);
  const root=document.querySelector('[data-app-shell-active-page="true"]')||document;
  const actions = Array.from(document.querySelectorAll('header button[aria-haspopup="menu"]')).find(node=>visible(node) && node.querySelector('use[href*="ellipsis-horizontal"]'));
  let ready = false;
  let streaming = false;
  const nativeConversationIds=new Set();
  // Native share control exposes server readiness for this conversation.
  for (const node of document.querySelectorAll('header button')) {
    if (!visible(node)) continue;
    const key = Object.keys(node).find(key=>key.startsWith('__reactFiber$'));
    for (let fiber=key&&node[key],i=0;fiber&&i<18;i++,fiber=fiber.return) {
      const props=fiber.memoizedProps;
      if(props?.isStreaming===true&&typeof props.conversationId==='string'&&
          (props.conversationId===chatId||/^local-chatgpt:/.test(props.conversationId)))streaming=true;
      if (props?.isReady===true && typeof props.conversationId==='string') {
        nativeConversationIds.add(props.conversationId);
        // Native isReady can become true while the share/action control is
        // still disabled for the first streaming response. That menu omits
        // Rename entirely; wait for its real enabled state before opening it.
        if(!node.disabled&&node.getAttribute('aria-disabled')!=='true'&&props.isStreaming!==true&&
            (props.conversationId===chatId || /^local-chatgpt:/.test(props.conversationId)))ready=true;
      }
    }
  }
  // Newly-created chats can have a failed/unfetched GET query even after the
  // native header isReady becomes true. Do not refetch or require that cache;
  // when canonical data exists, use it to reject an inconsistent binding.
  let canonicalMismatch=false;
  const clients=new Set();
  const anchor=root.querySelector('[data-composer-body]')||root.querySelector('[data-turn-key]');
  const key=anchor&&Object.keys(anchor).find(key=>key.startsWith('__reactFiber$'));
  for(let fiber=key&&anchor[key],i=0;fiber&&i<40;i++,fiber=fiber.return) {
    if(fiber.memoizedProps?.queryClient?.getQueryCache)clients.add(fiber.memoizedProps.queryClient);
    for(let hook=fiber.memoizedState,j=0;hook&&j<35;j++,hook=hook.next) {
      const client=hook.memoizedState?.current?.queryClient;
      if(client?.getQueryCache)clients.add(client);
    }
  }
  for(const client of clients) {
    const query=client.getQueryCache().getAll().find(q=>q.queryKey?.[0]==='chatgpt-conversation'&&q.queryKey[1]===chatId);
    if(query?.state?.data?.conversation_id && query.state.data.conversation_id!==chatId)canonicalMismatch=true;
  }
  ready=ready&&!canonicalMismatch&&!streaming;
  if (options.action === 'inspect') return {ok:true,ready:ready&&Boolean(actions),streaming,title:document.title,url:location.href,
    conversationId:nativeConversationIds.size===1?Array.from(nativeConversationIds)[0]:null};
  if (Number.isFinite(options.expiresAt)&&Date.now()>=options.expiresAt) return {ok:false,reason:'title-deadline-exceeded'};
  let state=globalThis.__chatgptNotifierTitleOperation;
  if (options.action==='open') {
    if (!ready || !actions) return {ok:false,reason:'chat-not-ready'};
    if (document.title!==options.previousTitle || Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some(visible)) return {ok:false,reason:'title-or-form-changed'};
    if (state && state.id!==options.operationId) return {ok:false,reason:'another-title-operation'};
    state={id:options.operationId,url:options.url,title:options.title,previousTitle:options.previousTitle,triggerId:actions.id,createdAt:Date.now()};
    globalThis.__chatgptNotifierTitleOperation=state;
    if (actions.getAttribute('data-state')!=='open') {
      actions.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse',ctrlKey:false}));
      actions.click();
    }
    return {ok:true};
  }
  if (!state || state.id!==options.operationId || state.url!==options.url || state.title!==options.title || Date.now()-state.createdAt>60000) return {ok:false,reason:'title-operation-changed'};
  if (options.action==='select') {
    const menu=Array.from(document.querySelectorAll('[role="menu"]')).find(n=>visible(n)&&n.getAttribute('aria-labelledby')===state.triggerId);
    const rename=Array.from(menu?.querySelectorAll('[role="menuitem"]')||[]).find(n=>Array.from(n.querySelectorAll('[style]')).some(icon=>{
      try {return decodeURIComponent(icon.style.maskImage||'').includes('M11.7313 4.20472');} catch {return false;}
    }));
    if (!rename || rename.getAttribute('aria-disabled')==='true') return {ok:false,retryable:true,reason:'rename-menu-not-ready'};
    rename.click();
    state.selected=true;
    return {ok:true};
  }
  if (!state.selected) return {ok:false,reason:'rename-not-selected'};
  const inputs=Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"] form input')).filter(visible);
  const input=state.input || (inputs.length===1&&inputs[0]);
  const form=input?.closest('form');
  if (!input || !visible(input) || !form || !form.querySelector('h2') || form.querySelectorAll('input').length!==1 ||
      !form.querySelector('button[type="submit"]') || form.querySelectorAll('button').length!==2) return {ok:false,retryable:true,reason:'rename-form-not-ready'};
  if (options.action==='fill') {
    if (input.value!==state.previousTitle || document.title!==state.previousTitle) return {ok:false,reason:'title-edited-by-user'};
    state.input=input;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,state.title);
    input.dispatchEvent(new Event('input',{bubbles:true}));
    return {ok:true};
  }
  if (options.action==='save') {
    if (state.saved || state.input!==input || input.value!==state.title || document.title!==state.previousTitle) return {ok:false,reason:'title-form-changed'};
    const key=Object.keys(input).find(key=>key.startsWith('__reactProps$'));
    if (!key || input[key]?.value!==state.title) return {ok:false,retryable:true,reason:'title-model-not-ready'};
    const save=form.querySelector('button[type="submit"]');
    if (!visible(save) || save.disabled) return {ok:false,retryable:true,reason:'title-save-not-ready'};
    state.saved=true;
    save.click();
    state.input=null;
    delete globalThis.__chatgptNotifierTitleOperation;
    return {ok:true,clicked:true};
  }
  return {ok:false,reason:'unknown-title-action'};
}
