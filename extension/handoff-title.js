'use strict';

// Policy only. Storage and the observed ChatGPT rename adapter live in the worker.
globalThis.ChatGPTHandoffTitle = (() => {
  function chatUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === 'https://chatgpt.com' && /^\/c\/[^/]+\/?$/.test(url.pathname)
        ? `${url.origin}${url.pathname.replace(/\/$/, '')}` : '';
    } catch { return ''; }
  }

  function validPart(part) { return Number.isSafeInteger(part) && part >= 1; }
  function validNaming(value) {
    return value?.version === 1 && chatUrl(value.sourceUrl) === value.sourceUrl &&
      typeof value.baseTitle === 'string' && value.baseTitle.trim().length > 0 &&
      validPart(value.part) && value.title === `${value.baseTitle} (${value.part})`;
  }

  function planNext({ sourceUrl, sourceTitle, lineage = null }) {
    sourceUrl = chatUrl(sourceUrl);
    if (!sourceUrl || typeof sourceTitle !== 'string' || !sourceTitle.trim()) {
      throw new Error('Source chat title is unavailable');
    }
    // Confirmed lineage binds the count to the exact chat, even if its owner
    // renamed it. Strip only the exact title we previously assigned; every
    // character of a different current title becomes the new literal base.
    const continues = lineage?.version === 1 && (lineage.confirmed === true || lineage.transferred === true) &&
      lineage.targetUrl === sourceUrl &&
      typeof lineage.baseTitle === 'string' && lineage.baseTitle.trim().length > 0 &&
      validPart(lineage.part) && lineage.title === `${lineage.baseTitle} (${lineage.part})`;
    const baseTitle = continues && (!lineage.confirmed || sourceTitle === lineage.title) ? lineage.baseTitle : sourceTitle;
    const part = continues ? lineage.part + 1 : 1;
    if (!validPart(part)) throw new Error('Continuation number exhausted');
    return { version: 1, sourceUrl, baseTitle, part, title: `${baseTitle} (${part})` };
  }

  function confirm(naming, targetUrl) {
    targetUrl = chatUrl(targetUrl);
    if (!validNaming(naming) || !targetUrl || targetUrl === naming.sourceUrl) {
      throw new Error('Invalid continuation title binding');
    }
    return { ...naming, targetUrl, transferred:true, confirmed: true };
  }

  return Object.freeze({ chatUrl, planNext, confirm });
})();
