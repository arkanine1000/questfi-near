/**
 * Boot-up projection timing — the hologram "powers on" in layers when the
 * scene mounts (and again on every map switch, since the Canvas remounts and
 * the r3f clock restarts). Each visual layer multiplies its intensity /
 * scale by bootRamp(clock.elapsedTime, BOOT.<layer>).
 */
export const BOOT = {
  terrain: [0.2, 1.0],
  grid: [1.0, 0.9],
  props: [1.5, 1.0],
  relics: [2.2, 0.8],
  agents: [2.7, 0.9],
  ambient: [3.4, 1.2],
};

/** Smoothstep 0..1 across [delay, delay+duration]; instant under reduced motion. */
export function bootRamp(t, [delay, duration], reducedMotion = false) {
  if (reducedMotion) return 1;
  const x = Math.min(Math.max((t - delay) / duration, 0), 1);
  return x * x * (3 - 2 * x);
}
