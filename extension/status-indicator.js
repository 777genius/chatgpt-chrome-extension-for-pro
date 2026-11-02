'use strict';

globalThis.ChatGPTStatusIndicator=Object.freeze({
  create({document,getUrl,load,alive=()=>true}) {
    let disposed=false,url='',revision=-1,status=null,icon=null,request=0;
    const window=document.defaultView;
    function dispose(){if(disposed)return;disposed=true;request++;observer.disconnect();window.removeEventListener('popstate',route);icon?.remove();icon=null;}
    function active(){try{if(!disposed&&alive())return true;}catch{}dispose();return false;}
    const canonical=value=>{
      try {const u=new URL(value);return u.origin==='https://chatgpt.com'&&/^\/c\/[a-z0-9-]+\/?$/.test(u.pathname)?u.origin+u.pathname.replace(/\/$/,''):'';}catch{return '';}
    };
    const icons={
      error:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#dc2626" stroke="white" stroke-width="3"/><path d="M22 22l20 20m0-20L22 42" fill="none" stroke="white" stroke-width="7" stroke-linecap="round"/></svg>',
      success:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#16a34a" stroke="white" stroke-width="3"/><path d="M17 32l10 10 21-22" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    };
    function render() {
      if(!active()||!status) {icon?.remove();icon=null;return;}
      if(!document.head)return;
      if(!icon){icon=document.createElement('link');icon.rel='icon';icon.type='image/svg+xml';icon.sizes='any';icon.setAttribute('data-chatgpt-notifier-status','');}
      const href='data:image/svg+xml,'+encodeURIComponent(icons[status.kind]);
      if(icon.getAttribute('href')!==href)icon.setAttribute('href',href);
      const links=document.head.querySelectorAll('link[rel~="icon"]');
      if(!icon.isConnected||links[links.length-1]!==icon)document.head.append(icon);
    }
    function accept(value) {
      if(!active()||!url||canonical(getUrl())!==url||value?.url!==url||!Number.isSafeInteger(value.revision)||value.revision<revision)return false;
      if(value.status!==null&&!['error','success'].includes(value.status?.kind))return false;
      revision=value.revision;status=value.status;render();return true;
    }
    async function refresh() {
      if(!active())return;
      const current=canonical(getUrl());
      if(current!==url){url=current;revision=-1;status=null;render();}
      const ticket=++request;
      if(!url)return;
      try {const value=await load(url);if(ticket===request&&value?.ok)accept(value);}catch{}
    }
    let observingHead=false;
    function observeHead(){
      if(document.head&&!observingHead){observer.disconnect();observer.observe(document.head,{childList:true,subtree:true,attributes:true,attributeFilter:['href','rel']});observingHead=true;}
    }
    const observer=new window.MutationObserver(()=>{
      if(!active())return;
      observeHead();
      if(canonical(getUrl())!==url)void refresh();else render();
    });
    observeHead();
    if(!observingHead)observer.observe(document,{childList:true,subtree:true});
    const route=()=>{void refresh();};
    window.addEventListener('popstate',route);
    void refresh();
    return Object.freeze({accept,refresh,dispose});
  }
});
