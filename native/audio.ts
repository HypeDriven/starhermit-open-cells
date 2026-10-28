// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event; the quiet desk
// ambience (brown noise lowpassed at 320 Hz, looped) and the adaptive music
// (a slow sine pad alternating two chords every 4 s with a 1.6 s glide, its
// filter opening and a fourth voice rising — 440 Hz, a third or a fifth
// higher near the end — as cards go home). The browser build ran both live
// (oscillators and a noise loop); here they are rendered once into clips
// (createClip, a slice a frame) and looped on the music bus (the runtime has
// no ambience bus; the ambience's gain folds in the old ambience slider's 40 %
// default against music's 50 %), and the pad's filter sweep becomes its level.
// The runtime's Options own the volumes, the mute and the voice limit. The
// oscillator blips the browser build synthesized while a sample decoded are
// not ported (a live synthesis graph makes clip loads fail on the engine's web
// runtime), so a clip still loading is silent. Clips load once the mixer runs
// (natively at once, in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

/** audio.js SAMPLE_BY_EVENT. */
const SFX: Record<string, string> = {
  select: "card-select", deselect: "card-deselect", pickup: "card-pickup", drop: "card-drop", cell: "cell-store",
  foundation: "foundation-build", invalid: "move-invalid", undo: "move-undo", hint: "hint-chime", "lesson-step": "lesson-step",
  win: "deal-win", lose: "deal-lose", achievement: "achievement-unlock", deal: "deal-start", star: "star-award",
};
export type Sfx = keyof typeof SFX;
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;

/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

/** audio.js play(event). */
export function play(event: Sfx): void {
  const file = SFX[event];
  if (!file || suspended) return;
  const clip = clips.get(file);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); }
  catch { clips.delete(file); if (!queue.includes(file)) queue.push(file); } // a clip the mixer lost: load it again
}

// -- the ambience and the music -----------------------------------------------------------------
const RATE = 22050;
const AMB_N = RATE * 2;
const amb = new Float32Array(AMB_N);
let ambPos = 0, ambLast = 0, ambS = 7, ambY = 0;
/** audio.js startAmbience: brown-ish noise (seed 7), then a one-pole 320 Hz lowpass run twice round so the loop joins. */
function renderAmbience(count: number): boolean {
  const k = 1 - Math.exp((-2 * Math.PI * 320) / RATE);
  const end = Math.min(2 * AMB_N, ambPos + count);
  for (; ambPos < end; ambPos++) {
    const i = ambPos % AMB_N;
    if (ambPos < AMB_N) {
      ambS = (Math.imul(ambS, 1664525) + 1013904223) >>> 0;
      const white = (ambS / 4294967296) * 2 - 1;
      ambLast = (ambLast + 0.02 * white) / 1.02;
      amb[i] = ambLast * 2.4;
    } else {
      ambY += k * (amb[i]! - ambY);
      amb[i] = ambY;
    }
  }
  return ambPos >= 2 * AMB_N;
}
const CHORDS = [[220, 277.2, 329.6], [196, 246.9, 293.7]];
const PAD_N = RATE * 8;
const pad = new Float32Array(PAD_N);
let padPos = 0;
const phase = [0, 0, 0];
/** audio.js startMusic: three sines at 0.05, gliding to the next chord over 1.6 s every 4 s (an 8 s cycle). */
function renderPad(count: number): boolean {
  const end = Math.min(PAD_N, padPos + count);
  for (; padPos < end; padPos++) {
    const t = padPos / RATE;
    const step = Math.floor(t / 4), local = t - step * 4;
    const from = CHORDS[(step + 1) % 2]!, to = CHORDS[step % 2]!;
    const k = Math.min(1, local / 1.6);
    let v = 0;
    for (let j = 0; j < 3; j++) {
      const f = from[j]! + (to[j]! - from[j]!) * k;
      phase[j] = (phase[j]! + f / RATE) % 1;
      v += Math.sin(phase[j]! * 2 * Math.PI) * 0.05;
    }
    pad[padPos] = v;
  }
  return padPos >= PAD_N;
}
/** The fourth voice: 440 Hz for exactly 440 cycles (1 s), pitched up for the end game. */
const VOICE = (() => {
  const n = RATE, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * 440 * i) / RATE) * 0.05;
  return out;
})();
let ambClip: AudioClip | null = null, padClip: AudioClip | null = null, voiceClip: AudioClip | null = null;
let ambVoice: Sound | null = null, padVoice: Sound | null = null, topVoice: Sound | null = null;
let intensity = 0;
const padGain = (): number => 1 + intensity * 0.6;
/** audio.js setMusicIntensity(0..1): the pad opens up and the fourth voice rises. */
export function setMusicIntensity(x: number): void {
  const next = Math.max(0, Math.min(1, x));
  if (next === intensity) return;
  intensity = next;
  try {
    padVoice?.fade(padGain(), 1);
    topVoice?.fade(intensity, 1);
    topVoice?.setPitch(intensity > 0.8 ? 1.5 : intensity > 0.5 ? 1.25 : 1);
  } catch { /* gone */ }
}
/** audio.js suspend/resume: the pause menu and a hidden window silence the desk. */
export function setSuspended(on: boolean): void {
  if (on === suspended) return;
  suspended = on;
  try {
    ambVoice?.fade(on ? 0 : 0.8, 0.2);
    padVoice?.fade(on ? 0 : padGain(), 0.2);
    topVoice?.fade(on ? 0 : intensity, 0.2);
  } catch { /* gone */ }
}

/** Each frame: the clips once the mixer runs (one at a time), then the ambience and the music. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of Object.values(SFX)) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
    }
    return;
  }
  if (loading) return;
  if (!ambClip) {
    if (!renderAmbience(8000)) return;
    try { ambClip = createClip([amb], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); ambPos = 0; }
    return;
  }
  if (!ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: suspended ? 0 : 0.8, loop: true }); } catch { ambVoice = null; }
    return;
  }
  if (!padClip) {
    if (!renderPad(6000)) return;
    try { padClip = createClip([pad], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); padPos = 0; }
    return;
  }
  if (!padVoice) {
    try { padVoice = playClip(padClip, { bus: "music", gain: suspended ? 0 : padGain(), loop: true }); } catch { padVoice = null; }
    return;
  }
  if (!voiceClip) {
    try { voiceClip = createClip([VOICE], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); }
    return;
  }
  if (!topVoice) {
    try {
      topVoice = playClip(voiceClip, { bus: "music", gain: suspended ? 0 : intensity, loop: true });
      topVoice.setPitch(intensity > 0.8 ? 1.5 : intensity > 0.5 ? 1.25 : 1);
    } catch { topVoice = null; }
  }
}
