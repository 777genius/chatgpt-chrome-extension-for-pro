'use strict';

globalThis.ChatGPTStatusAnimation=Object.freeze({
  create({send,setTimeout,clearTimeout}) {
    if(![send,setTimeout,clearTimeout].every(value=>typeof value==='function'))throw new TypeError('Animation clock adapters are required');
    const bindings=new Map();
    let timer=null,frame=0,disposed=false,enabled=true;
    function schedule() {
      if(!disposed&&enabled&&bindings.size&&timer===null)timer=setTimeout(tick,250);
    }
    function stopIfIdle() {
      if(!bindings.size&&timer!==null){clearTimeout(timer);timer=null;}
    }
    function retire(binding) {
      if(bindings.get(binding.tabId)!==binding)return;
      bindings.delete(binding.tabId);
      stopIfIdle();
    }
    function tick() {
      timer=null;
      if(disposed||!enabled)return;
      const current=frame;
      frame=(frame+1)%8;
      for(const binding of bindings.values()) {
        if(binding.pending)continue;
        binding.pending=true;
        let result;
        try {result=send(binding.tabId,{type:'CHATGPT_STATUS_TICK',url:binding.url,frame:current});}
        catch {retire(binding);continue;}
        Promise.resolve(result).then(ack=>{
          if(disposed||bindings.get(binding.tabId)!==binding)return;
          binding.pending=false;
          if(ack?.ok!==true)retire(binding);
        },()=>retire(binding));
      }
      schedule();
    }
    return Object.freeze({
      set(tabId,url,loading) {
        if(disposed||!Number.isInteger(tabId)||tabId<0||typeof url!=='string'||!url)return;
        const existing=bindings.get(tabId);
        if(loading===true) {
          if(existing?.url!==url)bindings.set(tabId,{tabId,url,pending:false});
          schedule();
        } else if(existing?.url===url)retire(existing);
      },
      setEnabled(value) {
        if(disposed)return;
        enabled=value===true;
        if(!enabled&&timer!==null){clearTimeout(timer);timer=null;}
        if(enabled)schedule();
      },
      remove(tabId) {
        bindings.delete(tabId);
        stopIfIdle();
      },
      dispose() {
        disposed=true;
        bindings.clear();
        if(timer!==null)clearTimeout(timer);
        timer=null;
      }
    });
  }
});
