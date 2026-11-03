"use strict";

// Title policy only. Chrome storage and the ChatGPT rename adapter belong to the Host.
interface ContinuationNaming {
  version: 1;
  sourceUrl: string;
  baseTitle: string;
  part: number;
  title: string;
}
interface ContinuationLineage extends ContinuationNaming {
  targetUrl: string;
  transferred: boolean;
  confirmed: boolean;
}
interface PlanNextTitle {
  sourceUrl: string;
  sourceTitle: string;
  lineage?: ContinuationLineage | null;
}

const handoffTitleApi = (() => {
  function chatUrl(value: string): string {
    try {
      const url = new URL(value);
      return url.origin === "https://chatgpt.com" && /^\/c\/[a-z0-9-]+\/?$/.test(url.pathname)
        ? url.origin + url.pathname.replace(/\/$/, "") : "";
    } catch { return ""; }
  }

  function validPart(part: number): boolean {
    return Number.isSafeInteger(part) && part >= 1;
  }
  function validNaming(value: ContinuationNaming | null): value is ContinuationNaming {
    return value?.version === 1 && chatUrl(value.sourceUrl) === value.sourceUrl &&
      typeof value.baseTitle === "string" && value.baseTitle.trim().length > 0 &&
      validPart(value.part) && value.title === value.baseTitle + " (" + value.part + ")";
  }

  function planNext({ sourceUrl, sourceTitle, lineage = null }: PlanNextTitle): ContinuationNaming {
    sourceUrl = chatUrl(sourceUrl);
    if (!sourceUrl || typeof sourceTitle !== "string" || !sourceTitle.trim()) {
      throw new Error("Source chat title is unavailable");
    }
    const continues = lineage?.version === 1 && (lineage.confirmed === true || lineage.transferred === true) &&
      lineage.targetUrl === sourceUrl &&
      typeof lineage.baseTitle === "string" && lineage.baseTitle.trim().length > 0 &&
      validPart(lineage.part) && lineage.title === lineage.baseTitle + " (" + lineage.part + ")";
    const baseTitle = continues && (!lineage.confirmed || sourceTitle === lineage.title)
      ? lineage.baseTitle : sourceTitle;
    const part = continues ? lineage.part + 1 : 1;
    if (!validPart(part)) throw new Error("Continuation number exhausted");
    return { version: 1, sourceUrl, baseTitle, part, title: baseTitle + " (" + part + ")" };
  }

  function confirm(naming: ContinuationNaming, targetUrl: string): ContinuationLineage {
    targetUrl = chatUrl(targetUrl);
    if (!validNaming(naming) || !targetUrl || targetUrl === naming.sourceUrl) {
      throw new Error("Invalid continuation title binding");
    }
    return { ...naming, targetUrl, transferred: true, confirmed: true };
  }

  return Object.freeze({ chatUrl, planNext, confirm });
})();

(globalThis as typeof globalThis & { ChatGPTHandoffTitle: typeof handoffTitleApi }).ChatGPTHandoffTitle = handoffTitleApi;
