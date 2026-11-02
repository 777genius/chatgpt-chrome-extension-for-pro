"use strict";

interface TickMessage {
  type: "CHATGPT_STATUS_TICK";
  url: string;
  frame: number;
}
interface TickAcknowledgement {
  ok?: boolean;
}
interface AnimationClockPorts<Handle> {
  send(tabId: number, message: TickMessage): TickAcknowledgement | undefined | Promise<TickAcknowledgement | undefined>;
  setTimeout(callback: () => void, milliseconds: number): Handle;
  clearTimeout(handle: Handle): void;
}
interface AnimationBinding {
  tabId: number;
  url: string;
  pending: boolean;
  generation: number;
}
interface StatusAnimation {
  set(tabId: number, url: string, loading: boolean): void;
  setEnabled(enabled: boolean): void;
  remove(tabId: number): void;
  dispose(): void;
}

const statusAnimationApi = Object.freeze({
  create<Handle>({ send, setTimeout, clearTimeout }: AnimationClockPorts<Handle>): Readonly<StatusAnimation> {
    if (![send, setTimeout, clearTimeout].every((value) => typeof value === "function")) {
      throw new TypeError("Animation clock adapters are required");
    }
    const bindings = new Map<number, AnimationBinding>();
    let timer: Handle | null = null;
    let frame = 0;
    let disposed = false;
    let enabled = true;

    function schedule(): void {
      if (!disposed && enabled && bindings.size && timer === null) timer = setTimeout(tick, 250);
    }
    function stopIfIdle(): void {
      if (!bindings.size && timer !== null) { clearTimeout(timer); timer = null; }
    }
    function retire(binding: AnimationBinding): void {
      if (bindings.get(binding.tabId) !== binding) return;
      bindings.delete(binding.tabId);
      stopIfIdle();
    }
    function tick(): void {
      timer = null;
      if (disposed || !enabled) return;
      const current = frame;
      frame = (frame + 1) % 8;
      for (const binding of bindings.values()) {
        if (binding.pending) continue;
        binding.pending = true;
        const generation = binding.generation;
        const settled = (failed: boolean): void => {
          if (disposed || bindings.get(binding.tabId) !== binding) return;
          binding.pending = false;
          if (failed && binding.generation === generation) retire(binding);
        };
        let result: ReturnType<typeof send>;
        try { result = send(binding.tabId, { type: "CHATGPT_STATUS_TICK", url: binding.url, frame: current }); }
        catch { settled(true); continue; }
        Promise.resolve(result).then((ack) => {
          settled(ack?.ok !== true);
        }, () => settled(true));
      }
      schedule();
    }

    return Object.freeze({
      set(tabId: number, url: string, loading: boolean): void {
        if (disposed || !Number.isInteger(tabId) || tabId < 0 || typeof url !== "string" || !url) return;
        const existing = bindings.get(tabId);
        if (loading === true) {
          if (existing?.url !== url) bindings.set(tabId, { tabId, url, pending: false, generation: 0 });
          else existing.generation++;
          schedule();
        } else if (existing?.url === url) retire(existing);
      },
      setEnabled(value: boolean): void {
        if (disposed) return;
        enabled = value === true;
        if (!enabled && timer !== null) { clearTimeout(timer); timer = null; }
        if (enabled) schedule();
      },
      remove(tabId: number): void {
        bindings.delete(tabId);
        stopIfIdle();
      },
      dispose(): void {
        disposed = true;
        bindings.clear();
        if (timer !== null) clearTimeout(timer);
        timer = null;
      },
    });
  },
});

(globalThis as typeof globalThis & { ChatGPTStatusAnimation: typeof statusAnimationApi }).ChatGPTStatusAnimation = statusAnimationApi;
