// Ordnance Survey's surveyed road surfaces (the roads layer's `surfaces`, osroads.js parseSurfaces) as a grid, for the
// road network to measure against (mapsurface.js fitToSurfaces: where the road's kerbs really are) and to keep OSM's
// lines off (roadnetgeom.js offSurfaces). Plain arrays, no DOM: it runs in the road network's worker.

export const CELL = 0.5;          // m
export const ROAD = 1, PAVE = 2;  // a cell's kind: OS's carriageway, or its pavement / central reservation

/** The surfaces over the layer's box (and a margin) as { kind(x, y), near(x, y, r) }, or null when there are none. */
export function surfaceGrid(surf, layer) {
  if (!surf || !surf.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { rings } of surf) for (const [x, y] of rings[0] || []) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (layer && layer.r > 0) {   // no bigger than the layer's box and a margin: a far polygon mustn't make a huge grid
    x0 = Math.max(x0, layer.cx - layer.r - 50); y0 = Math.max(y0, layer.cy - layer.r - 50);
    x1 = Math.min(x1, layer.cx + layer.r + 50); y1 = Math.min(y1, layer.cy + layer.r + 50);
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  const nx = Math.ceil((x1 - x0) / CELL) + 1, ny = Math.ceil((y1 - y0) / CELL) + 1;
  if (nx * ny > 8e6) return null;
  const g = new Uint8Array(nx * ny);
  // each polygon filled at its cells' centers, even-odd across its rings (holes stay as they were); the pavements
  // after the carriageway, so a cell both claim is pavement
  const order = [...surf.filter(p => p.kind === 'R'), ...surf.filter(p => p.kind !== 'R')];
  for (const { kind, rings } of order) {
    const v = kind === 'R' ? ROAD : PAVE;
    let ry0 = Infinity, ry1 = -Infinity;
    for (const [, y] of rings[0] || []) { ry0 = Math.min(ry0, y); ry1 = Math.max(ry1, y); }
    const j0 = Math.max(0, Math.ceil((ry0 - y0) / CELL - 0.5)), j1 = Math.min(ny - 1, Math.floor((ry1 - y0) / CELL - 0.5));
    for (let j = j0; j <= j1; j++) {
      const yc = y0 + (j + 0.5) * CELL, xs = [];
      for (const ring of rings) for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xa, ya] = ring[a], [xb, yb] = ring[b];
        if ((ya > yc) !== (yb > yc)) xs.push(xa + (yc - ya) * (xb - xa) / (yb - ya));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - x0) / CELL - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / CELL - 0.5));
        for (let i = i0; i <= i1; i++) g[j * nx + i] = v;
      }
    }
  }
  return {
    kind(x, y) {
      const i = Math.floor((x - x0) / CELL), j = Math.floor((y - y0) / CELL);
      return i < 0 || j < 0 || i >= nx || j >= ny ? 0 : g[j * nx + i];
    },
    /** Whether any surface lies within r m (a square) of (x, y). */
    near(x, y, r) {
      const ci = Math.floor((x - x0) / CELL), cj = Math.floor((y - y0) / CELL), k = Math.ceil(r / CELL);
      for (let j = Math.max(0, cj - k); j <= Math.min(ny - 1, cj + k); j++)
        for (let i = Math.max(0, ci - k); i <= Math.min(nx - 1, ci + k); i++) if (g[j * nx + i]) return true;
      return false;
    },
  };
}
