import { useEffect, useRef, useState } from 'react';
import { CastLine } from './PromptChan';
import { publicUrl } from '../../services/publicUrl';

// Non-intrusive Prompt-chan presence for crawler view. Her full booth
// (sprite animation, TTS) is an overworld thing — this is just a small
// avatar blip above the weapon nameplate. Message stays hidden by
// default; the blip glows "unread" the moment new commentary lands, and
// clicking it reveals the message (marking it read) for a hold window
// before it collapses back to just the (now dim/read) blip. No queue —
// always the single latest message, replacing whatever was there before.
// Same CastLine as the overworld booth — name-drops still turn into
// color-coded follow links here, not just plain text.
const HOLD_MS = 6000;

export default function CrawlerPromptChanBlip({ commentary, roster, onFollow }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(false);
  const [line, setLine] = useState(null);
  const hideTimer = useRef(null);
  const lastId = useRef(null);

  useEffect(() => {
    if (!commentary || commentary.id === lastId.current) return;
    lastId.current = commentary.id;
    setLine(commentary.text);
    setUnread(true);
  }, [commentary]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  if (!line) return null;

  const handleClick = () => {
    setOpen(true);
    setUnread(false);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setOpen(false), HOLD_MS);
  };

  return (
    <div className="crawler-pchan">
      {open && (
        <div className="crawler-pchan__bubble" role="status">
          <CastLine text={line} roster={roster} onFollow={onFollow} />
        </div>
      )}
      <button
        type="button"
        className={`crawler-pchan__blip${unread ? ' is-unread' : ''}`}
        onClick={handleClick}
        title="Prompt-chan"
        aria-label={unread ? "Show Prompt-chan's new message" : "Show Prompt-chan's last message"}
      >
        <img src={publicUrl('/prompt-chan/talk-1.webp')} alt="" draggable="false" />
      </button>
    </div>
  );
}
