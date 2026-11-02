"use strict";

type ResultKind = "loading" | "deferred" | "success" | "error";
interface StatusReceipt { epoch: string; order: number }
interface VisualStatus {
  kind: ResultKind;
  unread?: boolean;
  eventAt?: number;
  receipt?: StatusReceipt | null;
}
interface StatusView {
  ok?: boolean;
  url: string;
  revision: number;
  status: VisualStatus | null;
}
interface StatusTick { url: string; frame: number }
interface IndicatorPorts {
  document: Document;
  getUrl(): string;
  load(url: string): Promise<StatusView>;
  alive?(): boolean;
}
interface StatusIndicator {
  accept(value: StatusView): boolean;
  refresh(): Promise<void>;
  tick(value: StatusTick): boolean;
  dispose(): void;
  loadingStartedAt(): number | null;
  loadingGeneration(): { startedAt: number | undefined; startReceipt: StatusReceipt | null } | null;
}
const statusIndicatorApi = Object.freeze({
  create({ document, getUrl, load, alive = () => true }: IndicatorPorts): Readonly<StatusIndicator> {
    let disposed = false, url = "", revision = -1, request = 0, frame = 0;
    let status: VisualStatus | null = null;
    let icon: HTMLLinkElement | null = null;
    const window = document.defaultView;
    if (!window) throw new Error("Status indicator requires an attached document");
    const ownedAttribute = "data-chatgpt-notifier-status";
    const retiredAttribute = "data-chatgpt-notifier-status-retired";
    // An old isolated context may leave only our own stale favicon metadata.
    for (const stale of document.querySelectorAll<HTMLLinkElement>("link[" + ownedAttribute + "]")) {
      stale.setAttribute(retiredAttribute, "");
      stale.remove();
    }

    const nativeIcons = new Map<HTMLLinkElement, { originalRel: string; maskedRel: string }>();
    const withoutIcon = (rel: string): string => rel
      .split(/([\t\n\f\r ]+)/).map((token) => /^icon$/i.test(token) ? "" : token).join("");
    function restoreNativeIcons(): void {
      for (const [node, saved] of nativeIcons) {
        if (node.getAttribute("rel") === saved.maskedRel) node.setAttribute("rel", saved.originalRel);
      }
      nativeIcons.clear();
    }
    function maskNativeIcons(): void {
      const head = document.head;
      for (const [node, saved] of nativeIcons) {
        if (!node.isConnected || !head?.contains(node)) {
          if (node.getAttribute("rel") === saved.maskedRel) node.setAttribute("rel", saved.originalRel);
          nativeIcons.delete(node);
        } else if (node.hasAttribute(ownedAttribute) || node.getAttribute("rel") !== saved.maskedRel) {
          nativeIcons.delete(node);
        }
      }
      if (!head) return;
      for (const node of head.querySelectorAll<HTMLLinkElement>("link[rel]")) {
        if (node.hasAttribute(ownedAttribute)) continue;
        const originalRel = node.getAttribute("rel");
        if (originalRel === null) continue;
        const maskedRel = withoutIcon(originalRel);
        if (maskedRel === originalRel) continue;
        nativeIcons.set(node, { originalRel, maskedRel });
        node.setAttribute("rel", maskedRel);
      }
    }
    function dispose(): void {
      if (disposed) return;
      disposed = true;
      request++;
      observer.disconnect();
      window.removeEventListener("popstate", route);
      icon?.remove();
      icon = null; status = null;
      restoreNativeIcons();
    }
    function active(): boolean {
      try {
        const foreign = document.querySelector("link[" + ownedAttribute + "]");
        if (!disposed && alive() && !icon?.hasAttribute(retiredAttribute) &&
            (!foreign || foreign === icon)) return true;
      } catch { /* invalid extension context */ }
      dispose();
      return false;
    }
    const canonical = (value: string): string => {
      try {
        const u = new URL(value);
        return u.origin === "https://chatgpt.com" && /^\/c\/[a-z0-9-]+\/?$/.test(u.pathname)
          ? u.origin + u.pathname.replace(/\/$/, "") : "";
      } catch { return ""; }
    };
    const deferredIcon = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="white" stroke="#64748b" stroke-width="4"/><path d="M32 15v18l-11 10" fill="none" stroke="#475569" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    );
    const icons = {
      error: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#dc2626" stroke="white" stroke-width="3"/><path d="M22 22l20 20m0-20L22 42" fill="none" stroke="white" stroke-width="7" stroke-linecap="round"/></svg>',
      success: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#16a34a" stroke="white" stroke-width="3"/><path d="M17 32l10 10 21-22" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    };
    const terminalIcons: Record<string, string> = {};
    for (const [kind, svg] of Object.entries(icons)) {
      terminalIcons[kind + ":seen"] = "data:image/svg+xml," + encodeURIComponent(svg);
      terminalIcons[kind + ":unread"] = "data:image/svg+xml," + encodeURIComponent(svg.replace(
        "</svg>", '<circle data-chatgpt-unread="true" cx="54" cy="10" r="7" fill="#2563eb" stroke="white" stroke-width="2"/></svg>',
      ));
    }
    const frames = Array.from({ length: 8 }, (_, index) => "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="white"/><circle cx="32" cy="32" r="21" fill="none" stroke="#dbeafe" stroke-width="8"/><path d="M32 11a21 21 0 0 1 21 21" fill="none" stroke="#2563eb" stroke-width="8" stroke-linecap="round" transform="rotate(' + index * 45 + ' 32 32)"/></svg>',
    ));
    function tick(value: StatusTick): boolean {
      if (!active() || status?.kind !== "loading" || canonical(getUrl()) !== url ||
          value?.url !== url || !Number.isInteger(value.frame) || value.frame < 0 ||
          value.frame >= frames.length) return false;
      frame = value.frame;
      render();
      return true;
    }
    function render(): void {
      if (!active() || !status) {
        icon?.remove();
        icon = null;
        restoreNativeIcons();
        return;
      }
      if (!document.head) return;
      maskNativeIcons();
      if (!icon) {
        icon = document.createElement("link");
        icon.rel = "icon";
        icon.type = "image/svg+xml";
        icon.sizes = "any";
        icon.setAttribute(ownedAttribute, "");
      }
      const href = status.kind === "loading" ? frames[frame] :
        status.kind === "deferred" ? deferredIcon :
          terminalIcons[status.kind + ":" + (status.unread === true ? "unread" : "seen")];
      if (href && icon.getAttribute("href") !== href) icon.setAttribute("href", href);
      const links = document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]');
      if (!icon.isConnected || links[links.length - 1] !== icon) document.head.append(icon);
    }
    function accept(value: StatusView): boolean {
      if (!active() || !url || canonical(getUrl()) !== url || value?.url !== url ||
          !Number.isSafeInteger(value.revision) || value.revision < revision) return false;
      if (value.status !== null && !["error", "success", "loading", "deferred"]
        .includes(value.status?.kind)) return false;
      revision = value.revision;
      status = value.status;
      render();
      return true;
    }
    async function refresh(): Promise<void> {
      if (!active()) return;
      const current = canonical(getUrl());
      if (current !== url) { url = current; revision = -1; status = null; render(); }
      const ticket = ++request;
      if (!url) return;
      try {
        const value = await load(url);
        if (ticket === request && value?.ok) accept(value);
      } catch { /* transient read failure */ }
    }
    let observingHead = false;
    function observeHead(): void {
      if (document.head && !observingHead) {
        observer.disconnect();
        observer.observe(document.head, { childList: true, subtree: true,
          attributes: true, attributeFilter: ["href", "rel"] });
        observingHead = true;
      }
    }
    const observer = new window.MutationObserver(() => {
      if (!active()) return;
      observeHead();
      if (canonical(getUrl()) !== url) void refresh();
      else render();
    });
    observeHead();
    if (!observingHead) observer.observe(document, { childList: true, subtree: true });
    const route = (): void => { void refresh(); };
    window.addEventListener("popstate", route);
    void refresh();
    return Object.freeze({
      accept, refresh, tick, dispose,
      loadingStartedAt: () => status?.kind === "loading" ? status.eventAt ?? null : null,
      loadingGeneration: () => status?.kind === "loading"
        ? { startedAt: status.eventAt, startReceipt: status.receipt ? { ...status.receipt } : null }
        : null,
    });
  },
});
(globalThis as typeof globalThis & { ChatGPTStatusIndicator: typeof statusIndicatorApi })
  .ChatGPTStatusIndicator = statusIndicatorApi;
