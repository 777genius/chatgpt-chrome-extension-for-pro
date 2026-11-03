"use strict";

// The offscreen document owns its audio context. No extension storage or
// protected send authority is available through this adapter.
interface OffscreenChrome {
  runtime: {
    onMessage: {
      addListener(listener: (message: unknown) => void): void;
    };
  };
}
declare const chrome: OffscreenChrome;

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

function tone(ctx: AudioContext, frequency: number, start: number, duration: number, gainValue: number): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

async function playCompletionSound(): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  const now = ctx.currentTime + 0.02;
  tone(ctx, 740, now, 0.16, 0.18);
  tone(ctx, 988, now + 0.18, 0.22, 0.20);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && typeof message === "object" && "type" in message &&
      message.type === "PLAY_COMPLETION_SOUND") {
    playCompletionSound().catch((error: unknown) => {
      console.error("ChatGPT Ready Signal offscreen audio failed", error);
    });
  }
});
