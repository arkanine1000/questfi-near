import { useEffect, useState } from 'react';

const TYPE_CPS = 68; // reveal speed, chars/second

// Shared terminal-style reveal. Used by the crawler HUD's thought toasts
// and by the overworld follow-mode toasts, so both read as the same voice.
export default function Typewriter({ text, reducedMotion }) {
  const [shown, setShown] = useState(reducedMotion ? text?.length ?? 0 : 0);

  useEffect(() => {
    if (!text) return undefined;
    if (reducedMotion) {
      setShown(text.length);
      return undefined;
    }
    setShown(0);
    let raf;
    const start = performance.now();
    const step = (now) => {
      const n = Math.floor(((now - start) / 1000) * TYPE_CPS);
      setShown(Math.min(n, text.length));
      if (n < text.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, reducedMotion]);

  if (!text) return null;
  return (
    <>
      {text.slice(0, shown)}
      {shown < text.length && <span className="quest-panel__cursor">_</span>}
    </>
  );
}
