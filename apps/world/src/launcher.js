// The venue launcher: a game opens over the city in a full-screen frame
// (the lobby app, deep-linked to its world, or any other QuestFi game by
// URL). The city pauses underneath — no render, no sim — and resumes where
// it was when you come back. The frame may also post
// { type: 'questfi:exit' } to close itself.

export function createLauncher({ onOpen, onClose }) {
  const root = document.createElement('div');
  root.id = 'launcher';
  root.hidden = true;
  root.innerHTML = `
    <div class="ln-bar">
      <button class="ln-back">&lsaquo; BACK TO THE CITY</button>
      <span class="ln-title"></span>
      <span class="ln-hint">ESC releases the mouse · then BACK</span>
    </div>
    <div class="ln-frame-wrap">
      <iframe class="ln-frame" allow="pointer-lock; fullscreen; autoplay; gamepad" referrerpolicy="no-referrer-when-downgrade"></iframe>
    </div>
  `;
  document.body.appendChild(root);
  const frame = root.querySelector('.ln-frame');
  const title = root.querySelector('.ln-title');
  let current = null;

  function open(venue) {
    current = venue;
    title.textContent = `${venue.name} · ${venue.def.tagline}`;
    title.style.color = `#${venue.tint.toString(16).padStart(6, '0')}`;
    frame.src = venue.def.url;
    root.hidden = false;
    document.exitPointerLock?.();
    onOpen?.(venue);
  }
  function close() {
    if (!current) return;
    frame.src = 'about:blank';
    root.hidden = true;
    const v = current;
    current = null;
    onClose?.(v);
  }
  root.querySelector('.ln-back').addEventListener('click', close);
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'questfi:exit') close();
  });

  return {
    open,
    close,
    get isOpen() { return !!current; },
    get current() { return current; },
  };
}
