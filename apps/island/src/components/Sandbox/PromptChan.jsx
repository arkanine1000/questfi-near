/**
 * Prompt-chan, the island's caster, as a broadcast lower third in the
 * stage's bottom band, over the god view and the dungeon feed alike: her
 * camera on the left (head and shoulders, cut from the same sprite frames),
 * her caption beside it. She comes in with a line, holds it long enough to
 * read, then falls quiet: the caption goes and her camera dims until the
 * next line.
 *
 * Names in her lines are live: click one to ride that challenger. The
 * caster is a camera director who doesn't know it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { speakLine, stopSpeaking } from './promptChanVoice';
import { publicUrl } from '../../services/publicUrl';

// Reading time: base + per-character, clamped so a monologue can't park
// her on screen for half a minute.
const holdMs = (text) => Math.min(14000, 3800 + (text?.length ?? 0) * 55);

// --- sprite booth ----------------------------------------------------
// Each mood carries a talk cycle (mouth flap) and a rest pose she
// settles into once the line has been delivered; gestures are short
// intros played before the flap starts.
const MOODS = {
  neutral: {
    talk: [publicUrl('/prompt-chan/talk-1.webp'), publicUrl('/prompt-chan/talk-2.webp')],
    rest: publicUrl('/prompt-chan/talk-1.webp'),
  },
  happy: {
    // happy-3 raises a fist — a hand pose, so it holds like a gesture
    // instead of strobing in a mouth flap.
    talk: [publicUrl('/prompt-chan/happy-1.webp'), publicUrl('/prompt-chan/happy-3.webp')],
    holdMs: 3200,
    rest: publicUrl('/prompt-chan/happy-2.webp'), // the eyes-closed grin
  },
  surprised: {
    // A gasp is a pose, not a chatter: one small-o beat, then the big O
    // held for a few seconds — flapping it reads as jitter.
    talk: [publicUrl('/prompt-chan/surprised-1.webp'), publicUrl('/prompt-chan/surprised-2.webp')],
    holdMs: 3200,
    rest: publicUrl('/prompt-chan/surprised-3.webp'), // the hand-to-cheek shock
  },
};
const GESTURE = {
  point: publicUrl('/prompt-chan/gesture-point.webp'),
  wave: publicUrl('/prompt-chan/gesture-wave.webp'),
};
// A gesture is a pose, same as the gasp — a raised arm that vanishes in
// under a second reads as a glitch, so she holds it before speaking.
const GESTURE_MS = 2800;
const FLAP_MS = 150;

// Speech lasts a stretch proportional to the line; holdMs stays the
// single source of stage time, so she always rests before fading.
const speakMs = (text) => Math.min(6500, 1500 + (text?.length ?? 0) * 45);

// She never labels her own moods, so punctuation and kaomoji are the
// most honest signal we have. "?!"-class bursts read as shock; stacked
// bangs and sparkles read as delight; everything else is booth-neutral.
const moodFor = (text = '') => {
  if (/\?!|!\?|Σ|⊙|O{3,}H/u.test(text)) return 'surprised';
  if (/!{2,}|[☆♪♡✧]|\b(GG|MVP|WINS?|VICTORY)\b/iu.test(text)) return 'happy';
  return 'neutral';
};

const SPRITES = [
  ...new Set([
    ...Object.values(MOODS).flatMap((m) => [...m.talk, m.rest]),
    ...Object.values(GESTURE),
  ]),
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Marra", "Marra-chan", "Dain-sama" — the honorific rides the link.
const HONORIFIC = '(?:-(?:chan|kun|sama|san|senpai|dono))?';

/** Her line with challenger names turned into follow links. */
export function CastLine({ text, roster, onFollow }) {
  const parts = useMemo(() => {
    if (!roster?.length || !text) return [text];
    const byName = new Map(roster.map((a) => [a.name.toLowerCase(), a]));
    const names = [...roster]
      .sort((a, b) => b.name.length - a.name.length)
      .map((a) => escapeRe(a.name))
      .join('|');
    const pattern = new RegExp(`\\b(${names})${HONORIFIC}\\b`, 'gi');
    const out = [];
    let cursor = 0;
    for (const m of text.matchAll(pattern)) {
      const agent = byName.get(m[1].toLowerCase());
      if (!agent) continue;
      if (m.index > cursor) out.push(text.slice(cursor, m.index));
      if (agent.alive) {
        out.push(
          <button
            key={`${m.index}-${agent.agent_id}`}
            type="button"
            className="qf-caster-name"
            style={{ '--agent': agent.color }}
            onClick={() => onFollow?.(agent)}
            title={`Follow ${agent.name}`}
          >
            {m[0]}
          </button>,
        );
      } else {
        out.push(m[0]); // the fallen get no camera
      }
      cursor = m.index + m[0].length;
    }
    out.push(text.slice(cursor));
    return out;
  }, [text, roster, onFollow]);

  return <>{parts}</>;
}

export default function PromptChan({ onFollow }) {
  const {
    commentary, roster, latestFrame, followedAgent,
  } = useSandbox();
  // Voice is an island-view thing: underground the dungeon feed owns the
  // audio stage, so she goes silent (and stays readable via the bubble
  // when back topside).
  const underground = followedAgent?.position?.kind === 'dungeon';
  const undergroundRef = useRef(underground);
  undergroundRef.current = underground;
  useEffect(() => {
    if (underground) stopSpeaking();
  }, [underground]);
  const [line, setLine] = useState(null); // kept mounted through fade-out
  const [live, setLive] = useState(false);
  const [sprite, setSprite] = useState(MOODS.neutral.rest);
  const hideTimer = useRef(null);
  const spokenOnce = useRef(false);

  // The choreography effect keys on the line alone — frames tick every
  // couple of seconds and must not restart her mid-flap.
  const stageRef = useRef({});
  stageRef.current = {
    roster,
    seasonOver: latestFrame?.phase === 'finished' || Boolean(latestFrame?.winner),
  };

  useEffect(() => {
    if (!commentary) {
      // A season swap clears commentary in context so a fresh mount
      // never inherits the previous season's sign-off — drop it here too.
      clearTimeout(hideTimer.current);
      setLine(null);
      setLive(false);
      return;
    }
    setLine(commentary);
    setLive(true);
    if (!undergroundRef.current) {
      speakLine(commentary.text); // no-op unless the voice toggle is on
    }
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setLive(false), holdMs(commentary.text));
  }, [commentary]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  // Warm the cache once so the first flap never flashes a blank frame.
  useEffect(() => {
    for (const src of SPRITES) {
      const img = new Image();
      img.src = src;
    }
  }, []);

  // Stage direction per line: optional gesture intro, then the mouth
  // flap for as long as she "speaks", then settle into the rest pose.
  useEffect(() => {
    if (!line) return undefined;
    const mood = MOODS[moodFor(line.text)];
    const { roster: cast, seasonOver } = stageRef.current;

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setSprite(mood.rest);
      return undefined;
    }

    // Wave hello on her first call and goodbye on the season sign-off;
    // point when she name-drops someone the camera can still follow.
    const lower = (line.text ?? '').toLowerCase();
    const gesture = !spokenOnce.current || seasonOver
      ? GESTURE.wave
      : cast?.some((a) => a.alive && lower.includes(a.name.toLowerCase()))
        ? GESTURE.point
        : null;
    spokenOnce.current = true;

    const timers = [];
    let flap = null;
    const startTalking = () => {
      setSprite(mood.talk[0]);
      if (mood.holdMs) {
        // beat on the first frame, then hold the last one before resting
        timers.push(setTimeout(() => setSprite(mood.talk[1]), FLAP_MS * 2));
        timers.push(setTimeout(() => setSprite(mood.rest), FLAP_MS * 2 + mood.holdMs));
        return;
      }
      let i = 0;
      flap = setInterval(() => {
        i += 1;
        setSprite(mood.talk[i % mood.talk.length]);
      }, FLAP_MS);
      timers.push(setTimeout(() => {
        clearInterval(flap);
        setSprite(mood.rest);
      }, speakMs(line.text)));
    };

    if (gesture) {
      setSprite(gesture);
      timers.push(setTimeout(startTalking, GESTURE_MS));
    } else {
      startTalking();
    }
    return () => {
      clearInterval(flap);
      timers.forEach(clearTimeout);
    };
  }, [line]);

  // Nothing until her first line: a server without a commentator has no
  // caster at all, rather than a camera that never speaks.
  if (!line) return null;
  return (
    <section className={`qf-caster${live ? ' is-live' : ''}`} aria-label="Prompt-chan, the caster">
      <div className="qf-caster-cam qf-frame" aria-hidden>
        <img src={sprite} alt="" draggable="false" />
        <span className="qf-caster-live"><i className="qf-dot qf-dot--live" />Live</span>
      </div>
      <div className="qf-panel qf-caster-caption" aria-live="polite">
        <header className="qf-caster-head">
          <span className="qf-caster-who">Prompt-chan</span>
          <span className="qf-caster-role">Caster</span>
        </header>
        <p className="qf-caster-line">
          <CastLine text={line.text} roster={roster} onFollow={onFollow} />
        </p>
      </div>
    </section>
  );
}
