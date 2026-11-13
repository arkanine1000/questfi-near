/**
 * The house colours for code that draws outside the stylesheets: canvases
 * and SVG built in JavaScript. They mirror the tokens in styles/tokens.css;
 * change both together.
 */

export const PALETTE = {
  bg: '#010603',
  green: '#35ff7d',
  greenBright: '#7dffb0',
  greenDeep: '#0a3d1e',
  ink: '#dfffe8',
  inkHi: '#eafff1',
  inkSoft: '#b8ffd4',
  dim: 'rgba(159, 255, 200, 0.62)',
  line: 'rgba(53, 255, 125, 0.5)',
  lineSoft: 'rgba(53, 255, 125, 0.24)',
  panel: 'rgba(2, 22, 10, 0.8)',
  amber: '#ffd678',
  red: '#ff5d5d',
  ice: '#9be8ff',
};

/** A house colour with its own alpha: rgba(PALETTE.green, 0.3). */
export function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
