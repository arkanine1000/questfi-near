/**
 * The screens that are not the game: connecting, the server not answering,
 * and a phone held upright.
 */

import { publicUrl } from '../../services/publicUrl';

export function BootCurtain() {
  return (
    <div className="sbx-boot" aria-label="Connecting">
      <span className="sbx-boot__pulse" />
    </div>
  );
}

export function OfflineOverlay() {
  return (
    <div className="sbx-lobby">
      <h1 className="sbx-lobby__title">Signal lost</h1>
      <p className="sbx-lobby__hint">
        The island isn't answering. Check that the backend is up, then reload.
      </p>
    </div>
  );
}

/* Phones held upright get a polite bounce: the broadcast is widescreen.
   Pure CSS gate; the installed PWA locks landscape. */
export function RotateGate() {
  return (
    <div className="sbx-rotate-gate" role="status">
      <img src={publicUrl('/brand/quest-logo.png')} alt="" />
      <p>
        Rotate your device
        <span>the island broadcasts in widescreen</span>
      </p>
    </div>
  );
}
