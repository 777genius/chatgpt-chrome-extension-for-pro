'use strict';

// Session storage survives worker suspension but is reset by extension reload.
// Attach once per extension load, rather than scanning every tab per worker wake.
globalThis.ChatGPTWatcherBootstrap=Object.freeze({
  create({session,version,install}) {
    if(!session?.get||!session?.set)return null;
    const key='chatgpt-watchers:attached';
    let pending=null,ready=false;
    return Object.freeze({
      ensure() {
        if(ready)return Promise.resolve(false);
        if(pending)return pending;
        pending=(async()=>{
          if((await session.get(key))[key]?.version===version){ready=true;return false;}
          await install();
          await session.set({[key]:{version}});
          ready=true;return true;
        })().finally(()=>{pending=null;});
        return pending;
      }
    });
  }
});
