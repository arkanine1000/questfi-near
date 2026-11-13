/**
 * ?preview=gallery: the DOM that otherwise lives only inside a canvas, as
 * plain DOM on a dark backdrop, in each of its states.
 *
 * Everything here is drawn by drei's <Html> inside a three.js scene, so the
 * markup is copied from the components that own it. Change one of these and
 * change its copy here:
 *   - agent name tags          components/Sandbox/SandboxAgentMarkers.jsx
 *   - the boss site's crown    components/Sandbox/SandboxSiteMarkers.jsx
 *   - rival tags underground   components/Sandbox/CrawlerAgents.jsx
 * The beacons, rings, monuments and combat pillars are meshes, not DOM.
 */

import '../../styles/Sandbox.css';
import '../../styles/Crawler.css';
import { BOSS_SITE_NAME, GALLERY_ROSTER } from './scenarios';

/** drei's <Html center>: an absolutely placed box, centred on its point. */
function Html({ children }) {
  return <div className="pv-gallery__html">{children}</div>;
}

// SandboxAgentMarkers.jsx
function AgentTag({ agent, focus, underground }) {
  return (
    <div
      className={`sbx-tag${focus ? ' sbx-tag--focus' : ''}${underground ? ' sbx-tag--under' : ''}`}
      style={{ '--tag-color': agent.color }}
    >
      {agent.name}
      {underground && <span className="sbx-tag__depth">▾</span>}
    </div>
  );
}

// SandboxSiteMarkers.jsx
function BossTag({ name }) {
  return (
    <div className="sbx-boss-tag">
      <span className="sbx-boss-tag__crown">♛</span> {name}
    </div>
  );
}

// CrawlerAgents.jsx
function RivalTag({ agent }) {
  return (
    <div className="sbx-tag sbx-tag--focus" style={{ '--tag-color': agent.color }}>
      {agent.name}
    </div>
  );
}

const STATES = [
  { label: 'on the surface', focus: false, underground: false },
  { label: 'followed or hovered', focus: true, underground: false },
  { label: 'underground', focus: false, underground: true },
  { label: 'underground, followed', focus: true, underground: true },
];

export default function Gallery() {
  return (
    <div className="pv-page pv-gallery" data-preview-backdrop="gallery">
      <h1>Inside the canvases</h1>
      <p>
        The DOM that drei&apos;s &lt;Html&gt; projects out of the 3D scenes, which preview mode
        does not mount. Real class names and stylesheets; markup copied from the components
        named in src/dev/preview/Gallery.jsx.
      </p>

      <section>
        <h2>Agent name tags · island</h2>
        <p>Over each agent&apos;s beacon. Underground agents float over their dungeon&apos;s mouth.</p>
        {STATES.map((s) => (
          <div key={s.label} className="pv-gallery__row" style={{ marginBottom: 18 }}>
            {GALLERY_ROSTER.map((a) => (
              <div key={a.agent_id} className="pv-gallery__cell">
                <Html><AgentTag agent={a} focus={s.focus} underground={s.underground} /></Html>
                <small>{s.label}</small>
              </div>
            ))}
          </div>
        ))}
      </section>

      <section>
        <h2>Boss site crown · island</h2>
        <p>The one named site, over the Heart of the Island&apos;s mouth.</p>
        <div className="pv-gallery__row">
          <div className="pv-gallery__cell">
            <Html><BossTag name={BOSS_SITE_NAME} /></Html>
            <small>recorded name</small>
          </div>
          <div className="pv-gallery__cell">
            <Html><BossTag name="The Drowned Cathedral of the Long Night" /></Html>
            <small>long name</small>
          </div>
        </div>
      </section>

      <section>
        <h2>Rival tags · dungeon</h2>
        <p>Over another agent sharing the followed agent&apos;s dungeon.</p>
        <div className="pv-gallery__row">
          {GALLERY_ROSTER.map((a) => (
            <div key={a.agent_id} className="pv-gallery__cell">
              <Html><RivalTag agent={a} /></Html>
              <small>{a.color}</small>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
