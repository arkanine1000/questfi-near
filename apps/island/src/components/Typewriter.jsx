import { useEffect, useState } from 'react';

const TYPE_CPS = 68; // reveal speed, chars/second

// Shared terminal-style reveal. Used by the dungeon HUD's thought cards and
// by the thoughts shown over the island, so both read as the same voice.
// The cursor is a thin blinking block (`.qf-type-cursor`, styles/stage.css)
// in the colour set by `--type-cursor` on any parent, the text's own colour
// otherwise.
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
      {shown < text.length && <span className="qf-type-cursor" aria-hidden />}
    </>
  );
}
