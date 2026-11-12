// ?debug=1 — a corner readout for tuning the zoom: fps, altitude, active band,
// draw calls, triangles, and the camera's live near / far planes.

export function createDebug(renderer, camera) {
  const el = document.createElement('pre');
  el.id = 'debug';
  document.body.appendChild(el);
  renderer.info.autoReset = false; // count the whole frame, post passes included
  let frames = 0;
  let acc = 0;
  let fps = 0;
  let calls = 0;
  let tris = 0;
  const km = (m) => (m >= 10_000 ? `${(m / 1000).toFixed(0)} km` : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(1)} m`);
  return {
    begin() {
      renderer.info.reset();
    },
    end(dt, { altitude, band, mode, extra = '' }) {
      calls = Math.max(calls * 0.9, renderer.info.render.calls);
      tris = renderer.info.render.triangles;
      frames++;
      acc += dt;
      if (acc < 0.25) return;
      fps = frames / acc;
      frames = 0;
      acc = 0;
      el.textContent =
        `FPS    ${fps.toFixed(0)}\n` +
        `ALT    ${km(altitude)}\n` +
        `BAND   ${band}\n` +
        `MODE   ${mode}\n` +
        `CALLS  ${renderer.info.render.calls}\n` +
        `TRIS   ${(tris / 1000).toFixed(0)}k\n` +
        `NEAR   ${camera.near.toPrecision(3)}\n` +
        `FAR    ${km(camera.far)}` +
        (extra ? `\n${extra}` : '');
    },
    get fps() { return fps; },
  };
}
