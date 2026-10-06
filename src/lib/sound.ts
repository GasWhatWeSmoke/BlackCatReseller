// Tiny WebAudio UI sound effects — short synthesized tones, no asset files. Subtle by
// design (low gain, <150ms). Muteable; the preference persists in localStorage.

const KEY = "bca-sound-muted";
const CHANGED = "bca-sound-muted-changed";
let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined" || typeof window.AudioContext === "undefined") return null;
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function isMuted(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(KEY) === "1";
}

export function setMuted(muted: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, muted ? "1" : "0");
  window.dispatchEvent(new Event(CHANGED));
}

export function toggleMuted(): boolean {
  const next = !isMuted();
  setMuted(next);
  return next;
}

export const SOUND_CHANGED_EVENT = CHANGED;

interface Tone { f: number; at: number; dur: number; gain?: number; type?: OscillatorType }

// Clean, distinct cues. Kept quiet (gain ≤ 0.06) so they never feel harsh.
const SOUNDS: Record<string, Tone[]> = {
  click: [{ f: 660, at: 0, dur: 0.045, gain: 0.045 }],
  select: [{ f: 620, at: 0, dur: 0.04, gain: 0.045 }, { f: 880, at: 0.05, dur: 0.05, gain: 0.045 }],
  toggle: [{ f: 520, at: 0, dur: 0.05, gain: 0.05 }],
  change: [{ f: 540, at: 0, dur: 0.035, gain: 0.03 }],
  save: [{ f: 660, at: 0, dur: 0.07, gain: 0.055 }, { f: 990, at: 0.07, dur: 0.11, gain: 0.055 }],
  error: [{ f: 300, at: 0, dur: 0.14, gain: 0.06, type: "sawtooth" }],
  // Run finished — a soft rising C–E–G chirp over a low purr undertone. The one
  // celebratory cue in the app (run-complete report card).
  complete: [
    { f: 130.8, at: 0, dur: 0.4, gain: 0.028, type: "sine" },
    { f: 523.25, at: 0, dur: 0.1, gain: 0.05, type: "triangle" },
    { f: 659.25, at: 0.09, dur: 0.1, gain: 0.05, type: "triangle" },
    { f: 783.99, at: 0.18, dur: 0.24, gain: 0.055, type: "triangle" },
  ],
};

export function playSound(name: keyof typeof SOUNDS | string): void {
  if (isMuted()) return;
  const c = getCtx();
  if (!c) return;
  const tones = SOUNDS[name] || SOUNDS.click;
  const now = c.currentTime;
  for (const tn of tones) {
    try {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = tn.type || "sine";
      osc.frequency.value = tn.f;
      const peak = tn.gain ?? 0.05;
      const start = now + tn.at;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + tn.dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(start);
      osc.stop(start + tn.dur + 0.03);
    } catch {
      /* ignore a single failed tone */
    }
  }
}
