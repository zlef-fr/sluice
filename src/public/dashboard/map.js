// A dependency-free geographic scatter: plots [id,lat,lon,colorVal] tuples onto a
// <canvas> with an equirectangular projection (aspect-corrected by mid-latitude),
// colours each point along a ramp, and hit-tests clicks back to a record id. Pan
// (drag), zoom (wheel + pinch) and double-click-to-reset are built in via a view
// transform applied at draw time, so it stays a single self-contained canvas — no
// tiles, no external map library. Pass interactive:false for a static locator.
export function createScatter(canvas, { ramp, onPick, interactive = true }) {
  const ctx = canvas.getContext('2d');
  let data = null;          // { points, color:{min,max} }
  let bbox = null;
  let base = [];            // parallel [{bx,by,id,c}] in base (unzoomed) CSS pixels
  let cssW = 0, cssH = 0, dpr = 1;
  let highlight = null;     // id to ring (detail mini-map)
  const view = { scale: 1, tx: 0, ty: 0 }; // pan/zoom transform

  canvas.style.touchAction = 'none';
  if (interactive) canvas.style.cursor = 'grab';

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

  // Size the canvas to the data's geographic aspect and project points to base
  // (unzoomed) pixel coords. Runs on setData / resize only — draw() just applies
  // the current pan/zoom on top, so interaction is cheap.
  function layout() {
    if (!data || !data.points.length) return;
    cssW = canvas.clientWidth || 600;
    const midLat = (bbox.laMin + bbox.laMax) / 2;
    const geoW = (bbox.loMax - bbox.loMin) * Math.cos(midLat * Math.PI / 180);
    const geoH = (bbox.laMax - bbox.laMin);
    cssH = Math.max(240, Math.min(680, cssW * (geoH / geoW)));
    dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.height = cssH + 'px';
    base = new Array(data.points.length);
    for (let i = 0; i < data.points.length; i++) {
      const p = data.points[i];
      const bx = ((p[2] - bbox.loMin) / (bbox.loMax - bbox.loMin)) * cssW;
      const by = (1 - (p[1] - bbox.laMin) / (bbox.laMax - bbox.laMin)) * cssH;
      base[i] = { bx, by, id: p[0], c: p[3] };
    }
    draw();
  }

  // Keep the (scaled) content overlapping the viewport so it can't be lost.
  function clampView() {
    const cw = cssW * view.scale, ch = cssH * view.scale;
    const m = Math.min(60, cssW * 0.2);
    view.tx = cw <= cssW ? (cssW - cw) / 2 : Math.min(m, Math.max(cssW - cw - m, view.tx));
    view.ty = ch <= cssH ? (cssH - ch) / 2 : Math.min(m, Math.max(cssH - ch - m, view.ty));
  }

  let raf = 0;
  function scheduleDraw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

  function draw() {
    if (!data || !base.length) return;
    clampView();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const { min, max } = data.color || { min: 0, max: 1 };
    const span = (max - min) || 1;
    const r = (data.points.length > 6000 ? 1.6 : data.points.length > 1500 ? 2.2 : 3.2)
      * Math.min(2.4, Math.sqrt(view.scale));

    ctx.globalAlpha = 0.82;
    for (const b of base) {
      const sx = b.bx * view.scale + view.tx;
      const sy = b.by * view.scale + view.ty;
      if (sx < -4 || sy < -4 || sx > cssW + 4 || sy > cssH + 4) continue; // cull offscreen
      ctx.beginPath();
      ctx.fillStyle = b.c == null ? 'rgba(150,150,160,.55)' : ramp((b.c - min) / span);
      ctx.arc(sx, sy, r, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (highlight != null) {
      const b = base.find((p) => String(p.id) === String(highlight));
      if (b) {
        const sx = b.bx * view.scale + view.tx, sy = b.by * view.scale + view.ty;
        ctx.beginPath(); ctx.arc(sx, sy, 7, 0, 6.2832); ctx.lineWidth = 2.5; ctx.strokeStyle = ramp(1); ctx.stroke();
        ctx.beginPath(); ctx.arc(sx, sy, 3, 0, 6.2832); ctx.fillStyle = ramp(1); ctx.fill();
      }
    }
  }

  function pickAt(sx, sy) {
    const bx = (sx - view.tx) / view.scale;
    const by = (sy - view.ty) / view.scale;
    const thr = (10 / view.scale) ** 2; // 10px screen tolerance at any zoom
    let best = null, bd = thr;
    for (const b of base) {
      const dx = b.bx - bx, dy = b.by - by, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = b; }
    }
    return best ? best.id : null;
  }

  // Zoom about a canvas-space anchor so the point under it stays put.
  function zoomAt(cx, cy, factor) {
    const ns = Math.max(1, Math.min(60, view.scale * factor));
    if (ns === view.scale) return;
    const bx = (cx - view.tx) / view.scale, by = (cy - view.ty) / view.scale;
    view.scale = ns;
    view.tx = cx - bx * ns;
    view.ty = cy - by * ns;
    scheduleDraw();
  }

  function reset() { view.scale = 1; view.tx = 0; view.ty = 0; scheduleDraw(); }

  // ── interaction ──────────────────────────────────────────────────────────
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  if (interactive) {
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });

    const pts = new Map();
    let panStart = null, moved = false, pinch = null;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        panStart = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
        moved = false; canvas.style.cursor = 'grabbing';
      } else if (pts.size === 2) {
        const a = [...pts.values()];
        pinch = { d: dist(a[0], a[1]) || 1, scale: view.scale };
        panStart = null;
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const a = [...pts.values()];
        const nd = dist(a[0], a[1]);
        const r = canvas.getBoundingClientRect();
        const mx = (a[0].x + a[1].x) / 2 - r.left, my = (a[0].y + a[1].y) / 2 - r.top;
        const target = pinch.scale * (nd / pinch.d);
        zoomAt(mx, my, target / view.scale);
      } else if (panStart) {
        const dx = e.clientX - panStart.x, dy = e.clientY - panStart.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        view.tx = panStart.tx + dx; view.ty = panStart.ty + dy;
        scheduleDraw();
      }
    });
    const endPtr = (e) => {
      const had = pts.delete(e.pointerId);
      if (pinch && pts.size < 2) pinch = null;
      if (panStart && pts.size === 0) {
        if (!moved && had) { // a tap/click, not a drag → pick
          const r = canvas.getBoundingClientRect();
          const id = pickAt(e.clientX - r.left, e.clientY - r.top);
          if (id != null && onPick) onPick(id);
        }
        panStart = null; canvas.style.cursor = 'grab';
      }
    };
    canvas.addEventListener('pointerup', endPtr);
    canvas.addEventListener('pointercancel', endPtr);
    canvas.addEventListener('dblclick', (e) => { e.preventDefault(); reset(); });
  }

  let rt;
  const onResize = () => { clearTimeout(rt); rt = setTimeout(() => { reset(); layout(); }, 120); };
  window.addEventListener('resize', onResize);

  return {
    setData(d) { data = d; bbox = d && d.points.length ? computeBbox(d.points) : null; view.scale = 1; view.tx = 0; view.ty = 0; layout(); },
    setHighlight(id) { highlight = id; scheduleDraw(); },
    zoomBy(f) { zoomAt(cssW / 2, cssH / 2, f); },
    reset,
    redraw: layout,
    destroy() { window.removeEventListener('resize', onResize); },
  };
}
