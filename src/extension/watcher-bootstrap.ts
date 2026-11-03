"use strict";

interface WatcherSessionStorage {
  get(key: string): Promise<Record<string, { version?: string } | undefined>>;
  set(value: Record<string, { version: string }>): Promise<unknown>;
}
interface WatcherBootstrapPorts {
  session: WatcherSessionStorage | null | undefined;
  version: string;
  install(): Promise<void>;
}
interface WatcherHandle {
  ensure(): Promise<boolean>;
}

// Session storage survives worker suspension but is reset on extension reload.
const watcherApi = Object.freeze({
  create({ session, version, install }: WatcherBootstrapPorts): Readonly<WatcherHandle> | null {
    if (!session?.get || !session?.set) return null;
    const key = "chatgpt-watchers:attached";
    let pending: Promise<boolean> | null = null;
    let ready = false;
    return Object.freeze({
      ensure(): Promise<boolean> {
        if (ready) return Promise.resolve(false);
        if (pending) return pending;
        pending = (async () => {
          if ((await session.get(key))[key]?.version === version) {
            ready = true;
            return false;
          }
          await install();
          await session.set({ [key]: { version } });
          ready = true;
          return true;
        })().finally(() => { pending = null; });
        return pending;
      },
    });
  },
});

(globalThis as typeof globalThis & { ChatGPTWatcherBootstrap: typeof watcherApi }).ChatGPTWatcherBootstrap = watcherApi;
