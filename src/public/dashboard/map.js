// A dependency-free geographic scatter: plots [id,lat,lon,colorVal] tuples onto a
// <canvas> with an equirectangular projection (aspect-corrected by mid-latitude),
// colours each point along a ramp, and hit-tests clicks back to a record id. No
// tiles, no external map library — self-contained so any themed dashboard gets a
// map for free.

export function createScatter(canvas, { ramp, onPick }) {
  const ctx = canvas.getContext('2d');
  let data = null;         // { points, color:{min,max} }
  let proj = [];           // parallel [{x,y,id}] in CSS pixels
  let bbox = null;
  let highlight = null;    // id to ring (detail mini-map)

  // Frame the main cluster with Tukey (IQR) fences rather than min/max or fixed
  // percentiles: outliers are usually asymmetric (e.g. France's overseas communes
  // are all far south, more than any small fixed % trims), and IQR fences adapt to
  // the distribution — they keep metropole + Corsica but clip the far-flung points,
  // which then render off-canvas. Fences are clamped to the real data extent so a
  // clean single-cluster dataset (no outliers) is unaffected.
  function tukey(sorted) {
    const q = (f) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(f * (sorted.length - 1))))];
    const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
    const lo = Math.max(sorted[0], q1 - 1.5 * iqr);
    const hi = Math.min(sorted[sorted.length - 1], q3 + 1.5 * iqr);
    return [lo, hi];
  }
  function computeBbox(points) {
    const [laMin, laMax] = tukey(points.map((p) => p[1]).sort((a, b) => a - b));
    const [loMin, loMax] = tukey(points.map((p) => p[2]).sort((a, b) => a - b));
    const pad = 0.04;
    const dLa = (laMax - laMin) || 1, dLo = (loMax - loMin) || 1;
    return { laMin: laMin - dLa * pad, laMax: laMax + dLa * pad, loMin: loMin - dLo * pad, loMax: loMax + dLo * pad };
  }

  function draw() {
    if (!data || !data.points.length) return;
    const cssW = canvas.clientWidth || 600;
    const midLat = (bbox.laMin + bbox.laMax) / 2;
    const geoW = (bbox.loMax - bbox.loMin) * Math.cos(midLat * Math.PI / 180);
    const geoH = (bbox.laMax - bbox.laMin);
    const cssH = Math.max(220, Math.min(680, cssW * (geoH / geoW)));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const { min, max } = data.color || { min: 0, max: 1 };
    const span = (max - min) || 1;
    proj = new Array(data.points.length);
    // Slightly larger dots when sparse, smaller when dense.
    const r = data.points.length > 6000 ? 1.6 : data.points.length > 1500 ? 2.2 : 3.2;

    for (let i = 0; i < data.points.length; i++) {
      const p = data.points[i];
      const x = ((p[2] - bbox.loMin) / (bbox.loMax - bbox.loMin)) * cssW;
      const y = (1 - (p[1] - bbox.laMin) / (bbox.laMax - bbox.laMin)) * cssH;
      proj[i] = { x, y, id: p[0] };
      ctx.beginPath();
      ctx.fillStyle = p[3] == null ? 'rgba(150,150,160,.55)' : ramp((p[3] - min) / span);
      ctx.globalAlpha = 0.82;
      ctx.arc(x, y, r, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (highlight != null) {
      const q = proj.find((p) => String(p.id) === String(highlight));
      if (q) {
        ctx.beginPath();
        ctx.arc(q.x, q.y, 7, 0, 6.2832);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = ramp(1);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(q.x, q.y, 3, 0, 6.2832);
        ctx.fillStyle = ramp(1);
        ctx.fill();
      }
    }
  }

  function pickAt(cssX, cssY) {
    let best = null, bestD = 100; // px² threshold ~10px radius
    for (const q of proj) {
      const dx = q.x - cssX, dy = q.y - cssY;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = q; }
    }
    return best ? best.id : null;
  }

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const id = pickAt(e.clientX - rect.left, e.clientY - rect.top);
    if (id != null && onPick) onPick(id);
  });

  let rt;
  const onResize = () => { clearTimeout(rt); rt = setTimeout(draw, 120); };
  window.addEventListener('resize', onResize);

  return {
    setData(d) { data = d; bbox = d && d.points.length ? computeBbox(d.points) : null; draw(); },
    setHighlight(id) { highlight = id; draw(); },
    redraw: draw,
    destroy() { window.removeEventListener('resize', onResize); },
  };
}
