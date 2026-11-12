/**
 * Prompt-chan's voice. Two tiers, best available wins:
 *
 * 1. The backend's /tts proxy (ElevenLabs, a real character voice) —
 *    active whenever the deployment has QUEST_SIM_TTS_API_KEY +
 *    _VOICE_ID configured.
 * 2. The browser's Web Speech voice pitched into anime-caster range —
 *    the zero-config fallback, also used the moment /tts answers 503.
 *
 * Off by default; the settings toggle is the enabling user gesture,
 * which also satisfies the autoplay policy.
 */

import { useSyncExternalStore } from 'react';
import { apiBaseUrl } from '../../services/sandboxApi';

const STORE_KEY = 'sbx-voice';
const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

let enabled = typeof window !== 'undefined' && localStorage.getItem(STORE_KEY) === '1';
const listeners = new Set();

export function setVoiceEnabled(on) {
  enabled = Boolean(on);
  try {
    localStorage.setItem(STORE_KEY, enabled ? '1' : '0');
  } catch { /* private mode — session-only toggle */ }
  if (!enabled) stopSpeaking();
  listeners.forEach((l) => l());
}

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useVoiceEnabled() {
  return useSyncExternalStore(subscribe, () => enabled);
}

// --- voice picking ----------------------------------------------------
// Ranked name preferences: bright female voices first, then any female-ish
// en voice, then whatever en default the platform has.
const PREFERRED = [
  /aria/i, /jenny/i, /zira/i, /samantha/i,
  /google uk english female/i, /google us english/i, /female/i,
];

let cachedVoice = null;
let cacheStamp = 0;

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (cachedVoice && cacheStamp === voices.length) return cachedVoice;
  const en = voices.filter((v) => v.lang?.toLowerCase().startsWith('en'));
  for (const re of PREFERRED) {
    const hit = en.find((v) => re.test(v.name));
    if (hit) {
      cachedVoice = hit;
      cacheStamp = voices.length;
      return hit;
    }
  }
  cachedVoice = en[0] ?? voices[0] ?? null;
  cacheStamp = voices.length;
  return cachedVoice;
}

// --- text prep --------------------------------------------------------
// Kaomoji and stray glyphs read as garbage; keep plain speech. Em-dashes
// become commas so she breathes instead of saying "dash".
function sanitize(text) {
  return (text ?? '')
    .replace(/[—–]/g, ', ')
    .replace(/[^\x20-\x7E]/g, ' ')     // kaomoji, box art, wide chars
    .replace(/\(\s*[^a-zA-Z0-9)]*\s*\)/g, ' ') // emptied kaomoji shells
    .replace(/\s+/g, ' ')
    .trim();
}

// --- playback ---------------------------------------------------------
// Cloud tier state: null = untested, true = serving, false = 503'd once
// (don't knock on an unconfigured door for every line).
let cloudAvailable = null;
let audioEl = null;
let requestSeq = 0; // stale fetch guard — only the newest line may play

function stopAudio() {
  if (audioEl) {
    audioEl.pause();
    if (audioEl.src.startsWith('blob:')) URL.revokeObjectURL(audioEl.src);
    audioEl.removeAttribute('src');
  }
}

function speakLocal(clean) {
  if (!supported) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.pitch = 1.85; // firmly into anime-cute range (2.0 is chipmunk)
  u.rate = 1.18;  // genki caster energy
  u.volume = 0.9;
  synth.speak(u);
}

async function speakCloud(clean, seq) {
  const res = await fetch(`${apiBaseUrl()}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clean }),
  });
  if (res.status === 503 || res.status === 404) {
    cloudAvailable = false; // unconfigured (or older) deployment — stop asking
    return false;
  }
  if (!res.ok) return false; // transient upstream trouble; retry next line
  cloudAvailable = true;
  const blob = await res.blob();
  if (seq !== requestSeq || !enabled) return true; // a newer line won
  stopAudio();
  audioEl = audioEl ?? new Audio();
  audioEl.src = URL.createObjectURL(blob);
  audioEl.volume = 0.9;
  await audioEl.play().catch(() => {});
  return true;
}

/** Speak a caster line, replacing whatever she was saying — a stale call
 * is worthless the moment a fresh one lands. */
export function speakLine(text) {
  if (!enabled) return;
  const clean = sanitize(text);
  if (!clean) return;
  const seq = ++requestSeq;
  stopAudio();
  if (supported) window.speechSynthesis.cancel();
  if (cloudAvailable !== false) {
    speakCloud(clean, seq).then((played) => {
      // first-ever call discovering an unconfigured /tts still speaks
      if (!played && seq === requestSeq) speakLocal(clean);
    }).catch(() => {
      if (seq === requestSeq) speakLocal(clean);
    });
  } else {
    speakLocal(clean);
  }
}

/** Cut her off — used when the camera goes underground mid-sentence. */
export function stopSpeaking() {
  requestSeq += 1;
  stopAudio();
  if (supported) window.speechSynthesis.cancel();
}
