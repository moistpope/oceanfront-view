// Builds the road network's meshes (roadnetgeom.js) off the page's thread for roadnet.js: {seq, layer,
// leftTraffic, usLines} in, {seq, arrays} back with the arrays' buffers handed over rather than copied.
import { roadArrays } from './roadnetgeom.js';

self.onmessage = (e) => {
  const { seq, layer, leftTraffic, usLines } = e.data;
  const arrays = roadArrays(layer, leftTraffic, usLines);
  const buffers = [];
  for (const k in arrays) buffers.push(arrays[k].pos.buffer, arrays[k].idx.buffer);
  self.postMessage({ seq, arrays }, buffers);
};
