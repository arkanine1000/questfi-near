/**
 * WebAudio-synthesized crawler cues — the project ships zero audio assets,
 * so every cue is built from oscillators at trigger time. On by default:
 * the AudioContext starts suspended under autoplay policy, but reaching the
 * crawler always involves page gestures, so ensureCtx()'s resume() succeeds
 * by the first cue that matters.
 */

let ctx = null;
let muted = false;

export function isSfxMuted() {
  return muted;
}

export function setSfxMuted(m) {
  muted = m;
  if (!muted) ensureCtx();
}

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** One enveloped oscillator sweep. */
function tone({ freq = 440, to = null, dur = 0.15, type = 'square', gain = 0.1, delay = 0 }) {
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to != null) osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// A musette-tuned chord: every reed doubled a few cents sharp so the pair
// beats against itself. That wobble is most of what makes an accordion
// sound like an accordion rather than an organ.
const MUSETTE_DETUNE = 1.006;

function reedChord({ freqs, dur, gain, delay }) {
  for (const freq of freqs) {
    tone({ freq, dur, type: 'sawtooth', gain, delay });
    tone({ freq: freq * MUSETTE_DETUNE, dur, type: 'triangle', gain, delay });
  }
}

/** Play the cue for a beat kind. No-op while muted or without WebAudio. */
export function playCue(kind) {
  if (muted || !ensureCtx()) return;
  switch (kind) {
    case 'move': // soft footstep thump
      tone({ freq: 95, to: 55, dur: 0.09, type: 'sine', gain: 0.12 });
      break;
    case 'attack': // blade zap
      tone({ freq: 240, to: 70, dur: 0.12, type: 'square', gain: 0.07 });
      break;
    case 'accordion': // the War Accordion is played, not swung
      // Two stabs of an A-minor chord over a bass drone, timed to the two
      // squeezes the bellows rig does across the same beat.
      reedChord({ freqs: [220, 440, 523, 659], dur: 0.17, gain: 0.035, delay: 0 });
      reedChord({ freqs: [220, 440, 523, 659], dur: 0.19, gain: 0.03, delay: 0.2 });
      break;
    case 'block': // parry clink — bright metallic double-tap
      tone({ freq: 1150, to: 700, dur: 0.07, type: 'square', gain: 0.08 });
      tone({ freq: 620, dur: 0.05, type: 'triangle', gain: 0.06, delay: 0.045 });
      break;
    case 'damage': // low body blow
      tone({ freq: 130, to: 40, dur: 0.22, type: 'sawtooth', gain: 0.1 });
      break;
    case 'trap': // descending alarm
      tone({ freq: 420, to: 60, dur: 0.32, type: 'sawtooth', gain: 0.08 });
      break;
    case 'loot': // two-tone pickup chime
      tone({ freq: 660, dur: 0.1, type: 'triangle', gain: 0.1 });
      tone({ freq: 880, dur: 0.16, type: 'triangle', gain: 0.1, delay: 0.09 });
      break;
    case 'death': // long fall
      tone({ freq: 220, to: 30, dur: 0.6, type: 'sawtooth', gain: 0.1 });
      break;
    case 'victory': // rising arpeggio
      [523, 659, 784, 1046].forEach((f, i) => {
        tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.1, delay: i * 0.12 });
      });
      break;
    default:
      break;
  }
}
