'use strict';
// Read only the submitted user message, never headers, credentials or raw body
// storage. An ambiguous/large/non-text request cannot witness Goal consent.
globalThis.ChatGPTGoalRequestProof=Object.freeze({
  read(details) {
    const chunks=details?.requestBody?.raw;
    if(!Array.isArray(chunks)||!chunks.length||chunks.some(p=>!p.bytes))return null;
    const size=chunks.reduce((n,p)=>n+p.bytes.byteLength,0);
    if(!size||size>262144)return null;
    try {
      const bytes=new Uint8Array(size);let offset=0;
      for(const p of chunks){bytes.set(new Uint8Array(p.bytes),offset);offset+=p.bytes.byteLength;}
      const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      if(body.action!=='next'||!Array.isArray(body.messages))return null;
      const users=body.messages.filter(m=>m?.author?.role==='user');
      if(users.length!==1)return null;
      const user=users[0],parts=user.content?.parts;
      if(!/^[a-z0-9-]{16,64}$/i.test(user.id||'')||user.content?.content_type!=='text'||
          !Array.isArray(parts)||parts.length!==1||typeof parts[0]!=='string'||!parts[0].trim()||parts[0].length>10000)return null;
      return {userId:user.id,userText:parts[0]};
    }catch{return null;}
  }
});
