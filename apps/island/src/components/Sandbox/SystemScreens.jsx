/**
 * The screens that are not the game: connecting, the server not answering,
 * and a phone held upright. Each is a curtain over the island, which keeps
 * rendering behind it.
 */

import { useSandbox } from '../../context/SandboxContext';
import { publicUrl } from '../../services/publicUrl';
import { IconWarn } from '../ui/icons';
import '../../styles/system.css';

/** Connecting: the island's name over a loading line, Agent World's way. */
export function BootCurtain() {
  return (
    <div className="qf-sys qf-sys--boot" role="status">
      <div className="qf-sys-boot">
        <img className="qf-sys-logo" src={publicUrl('/brand/quest-logo.png')} alt="" aria-hidden />
        <p className="qf-sys-boot__name">Agent Island</p>
        <p className="qf-sys-boot__line">Raising the island…</p>
        <div className="qf-bar qf-bar--thin qf-sys-boot__bar" aria-hidden><i /></div>
      </div>
    </div>
  );
}

/**
 * The server is not answering. Retrying is a reload (everything is fetched
 * afresh); going back lets go of the world in view and returns to the
 * season list, which says for itself whether the island is answering.
 */
export function OfflineOverlay() {
  const { detachWorld } = useSandbox();
  return (
    <div className="qf-sys qf-sys--offline">
      <section className="qf-panel qf-panel--red qf-sys-lost" role="alert" aria-labelledby="qf-sys-lost-title">
        <IconWarn size={30} className="qf-sys-lost__icon" />
        <h1 id="qf-sys-lost-title" className="qf-sys-lost__title">Signal lost</h1>
        <p className="qf-body qf-sys-lost__say">
          The island isn&apos;t answering. Check that the backend is up, then reload.
        </p>
        <div className="qf-btn-row qf-sys-lost__acts">
          <button type="button" className="qf-btn qf-btn--primary" onClick={() => window.location.reload()}>
            Retry
          </button>
          <button type="button" className="qf-btn qf-btn--quiet" onClick={() => detachWorld()}>
            Back to seasons
          </button>
        </div>
      </section>
    </div>
  );
}

/* Phones held upright get a polite bounce: the broadcast is widescreen.
   Pure CSS gate (system.css shows it only in portrait on a narrow screen);
   the installed PWA locks landscape. */
export function RotateGate() {
  return (
    <div className="qf-sys-rotate" role="status">
      <img className="qf-sys-logo" src={publicUrl('/brand/quest-logo.png')} alt="" aria-hidden />
      <span className="qf-sys-rotate__phone" aria-hidden />
      <p className="qf-sys-rotate__say">
        Rotate your device
        <span>the island broadcasts in widescreen</span>
      </p>
    </div>
  );
}
