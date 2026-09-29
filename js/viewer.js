// Renderizador 2D em <canvas> com zoom (roda do mouse / pinça), pan (arrastar)
// e seleção de objetos por clique.

const HIGHLIGHT = '#22d3ee';
const HOVER = '#fbbf24';

export class Viewer extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scene = null;
    this.hiddenLayers = new Set();
    this.view = { cx: 0, cy: 0, s: 1 };
    this.origin = [0, 0];
    this.selected = null;
    this.hover = null;
    this.units = '';
    this.fmt = (v) => v.toFixed(2);
    this.dirty = true;
    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._resize();
    const loop = () => {
      if (this.dirty) {
        this.dirty = false;
        this._render();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------ cena
  setScene(scene) {
    this.scene = scene;
    this.selected = null;
    this.hover = null;
    const e = scene.extents;
    // coordenadas relativas a uma origem local evitam perda de precisão
    // em desenhos georreferenciados (coordenadas muito grandes)
    this.origin = [(e[0] + e[2]) / 2, (e[1] + e[3]) / 2];
    this._buildBatches();
    this.fit();
  }

  setHiddenLayers(set) {
    this.hiddenLayers = set;
    if (this.selected && set.has(this.selected.layer)) this.select(null);
    this._buildBatches();
    this.redraw();
  }

  isItemVisible(it) {
    return !this.hiddenLayers.has(it.layer);
  }

  _buildBatches() {
    const strokes = new Map();
    const fills = new Map();
    const [ox, oy] = this.origin;
    const texts = [];
    const points = [];
    if (!this.scene) return;
    for (const it of this.scene.items) {
      if (!this.isItemVisible(it)) continue;
      for (const f of it.fills) {
        const key = f.color + '|' + f.alpha;
        let p = fills.get(key);
        if (!p) fills.set(key, (p = new Path2D()));
        for (const r of f.rings) addPath(p, r, true, ox, oy);
      }
      for (const s of it.strokes) {
        let p = strokes.get(s.color);
        if (!p) strokes.set(s.color, (p = new Path2D()));
        addPath(p, s.pts, s.closed, ox, oy);
      }
      for (const t of it.texts) texts.push(t);
      for (const pt of it.points) points.push(pt);
    }
    this.batches = { strokes, fills, texts, points };
  }

  // ------------------------------------------------------------ vista
  get width() {
    return this.canvas.clientWidth;
  }
  get height() {
    return this.canvas.clientHeight;
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.parentElement.clientWidth;
    const h = this.canvas.parentElement.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.redraw();
    this._emitView();
  }

  redraw() {
    this.dirty = true;
  }

  fit() {
    if (!this.scene) return;
    this.zoomToBox(this.scene.extents, 0.06);
  }

  zoomToBox(b, margin = 0.15) {
    const w = Math.max(b[2] - b[0], 1e-9);
    const h = Math.max(b[3] - b[1], 1e-9);
    const s = Math.min(this.width / (w * (1 + 2 * margin)), this.height / (h * (1 + 2 * margin)));
    this.view = { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, s: isFinite(s) && s > 0 ? s : 1 };
    this.redraw();
    this._emitView();
  }

  zoomAt(factor, sx, sy) {
    const [wx, wy] = this.toWorld(sx, sy);
    const s = Math.min(Math.max(this.view.s * factor, 1e-12), 1e12);
    this.view.s = s;
    // mantém o ponto sob o cursor fixo
    this.view.cx = wx - (sx - this.width / 2) / s;
    this.view.cy = wy + (sy - this.height / 2) / s;
    this.redraw();
    this._emitView();
  }

  zoom(factor) {
    this.zoomAt(factor, this.width / 2, this.height / 2);
  }

  toWorld(sx, sy) {
    const { cx, cy, s } = this.view;
    return [cx + (sx - this.width / 2) / s, cy - (sy - this.height / 2) / s];
  }

  toScreen(wx, wy) {
    const { cx, cy, s } = this.view;
    return [(wx - cx) * s + this.width / 2, this.height / 2 - (wy - cy) * s];
  }

  visibleBox() {
    const [x0, y1] = this.toWorld(0, 0);
    const [x1, y0] = this.toWorld(this.width, this.height);
    return [x0, y0, x1, y1];
  }

  _emitView() {
    clearTimeout(this._viewTimer);
    this._viewTimer = setTimeout(() => this.dispatchEvent(new Event('viewchange')), 120);
  }

  // ------------------------------------------------------------ seleção
  select(item, { zoom = false } = {}) {
    this.selected = item;
    if (item && zoom) {
      const b = item.bbox;
      const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.001 || 1;
      this.zoomToBox([b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad], 0.35);
    }
    this.redraw();
    this.dispatchEvent(new CustomEvent('select', { detail: item }));
  }

  hitTest(sx, sy) {
    if (!this.scene) return null;
    const [x, y] = this.toWorld(sx, sy);
    const tol = 6 / this.view.s;
    let best = null;
    let bestD = Infinity;
    let bestA = Infinity;
    for (const it of this.scene.items) {
      const b = it.bbox;
      if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) continue;
      if (!this.isItemVisible(it)) continue;
      let d = Infinity;
      for (const s of it.strokes) d = Math.min(d, distToPolyline(x, y, s.pts, s.closed));
      for (const f of it.fills) if (inRings(x, y, f.rings)) d = Math.min(d, f.alpha >= 1 ? 0 : tol * 0.9);
      for (const t of it.texts) if (inRing(x, y, t.corners)) d = Math.min(d, 0);
      for (const p of it.points) d = Math.min(d, Math.hypot(p.x - x, p.y - y));
      if (d > tol) continue;
      const area = (b[2] - b[0]) * (b[3] - b[1]);
      if (d < bestD - 1e-9 * tol || (Math.abs(d - bestD) <= 1e-9 * tol && area < bestA)) {
        best = it;
        bestD = d;
        bestA = area;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ eventos
  _bindEvents() {
    const c = this.canvas;
    const pointers = new Map();
    let drag = null;
    let pinch = null;

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const k = e.deltaMode === 1 ? 0.05 : 0.0015;
      this.zoomAt(Math.exp(-e.deltaY * k), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        drag = { x: e.clientX, y: e.clientY, moved: false };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
        drag = null;
      }
    });

    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomAt(d / pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        pinch.d = d;
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (drag.moved || Math.abs(dx) + Math.abs(dy) > 3) {
          drag.moved = true;
          c.style.cursor = 'grabbing';
          this.view.cx -= dx / this.view.s;
          this.view.cy += dy / this.view.s;
          drag.x = e.clientX;
          drag.y = e.clientY;
          this.redraw();
          this._emitView();
        }
        return;
      }
      const [wx, wy] = this.toWorld(sx, sy);
      this.dispatchEvent(new CustomEvent('cursor', { detail: { x: wx, y: wy } }));
      if (!this._hoverPending) {
        this._hoverPending = true;
        requestAnimationFrame(() => {
          this._hoverPending = false;
          const h = this.hitTest(sx, sy);
          if (h !== this.hover) {
            this.hover = h;
            c.style.cursor = h ? 'pointer' : 'crosshair';
            this.redraw();
            this.dispatchEvent(new CustomEvent('hover', { detail: { item: h, x: sx, y: sy } }));
          } else if (h) {
            this.dispatchEvent(new CustomEvent('hover', { detail: { item: h, x: sx, y: sy } }));
          }
        });
      }
    });

    const up = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && !drag.moved && pointers.size === 0) {
        const r = c.getBoundingClientRect();
        this.select(this.hitTest(e.clientX - r.left, e.clientY - r.top));
      }
      if (pointers.size === 0) drag = null;
      c.style.cursor = this.hover ? 'pointer' : 'crosshair';
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => {
      if (this.hover) {
        this.hover = null;
        this.redraw();
      }
      this.dispatchEvent(new CustomEvent('hover', { detail: { item: null } }));
    });
    c.addEventListener('dblclick', (e) => {
      const r = c.getBoundingClientRect();
      const it = this.hitTest(e.clientX - r.left, e.clientY - r.top);
      if (it) this.select(it, { zoom: true });
      else this.zoomAt(2, e.clientX - r.left, e.clientY - r.top);
    });
  }

  // ------------------------------------------------------------ desenho
  _worldTransform() {
    const dpr = window.devicePixelRatio || 1;
    const { cx, cy, s } = this.view;
    const [ox, oy] = this.origin;
    return [s * dpr, 0, 0, -s * dpr, dpr * (this.width / 2 - (cx - ox) * s), dpr * (this.height / 2 + (cy - oy) * s)];
  }

  _render() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.scene || !this.batches) return;

    const s = this.view.s;
    const t = this._worldTransform();
    ctx.setTransform(...t);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const [key, path] of this.batches.fills) {
      const [color, alpha] = key.split('|');
      ctx.globalAlpha = +alpha;
      ctx.fillStyle = color;
      ctx.fill(path, 'evenodd');
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1 / s;
    for (const [color, path] of this.batches.strokes) {
      ctx.strokeStyle = color;
      ctx.stroke(path);
    }

    // pontos (cruz de tamanho fixo na tela)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1;
    for (const p of this.batches.points) {
      const [x, y] = this.toScreen(p.x, p.y);
      if (x < -5 || y < -5 || x > this.width + 5 || y > this.height + 5) continue;
      ctx.strokeStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(x - 3, y);
      ctx.lineTo(x + 3, y);
      ctx.moveTo(x, y - 3);
      ctx.lineTo(x, y + 3);
      ctx.stroke();
    }

    this._renderTexts(this.batches.texts);

    if (this.hover && this.hover !== this.selected) this._renderItem(this.hover, HOVER, 2, false);
    if (this.selected) this._renderItem(this.selected, HIGHLIGHT, 2.5, true);
  }

  _renderTexts(texts, colorOverride) {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const s = this.view.s;
    const [vx0, vy0, vx1, vy1] = this.visibleBox();
    for (const t of texts) {
      const px = t.h * s;
      if (px < 1.5) continue;
      const c = t.corners;
      if (Math.max(c[0], c[2], c[4], c[6]) < vx0 || Math.min(c[0], c[2], c[4], c[6]) > vx1) continue;
      if (Math.max(c[1], c[3], c[5], c[7]) < vy0 || Math.min(c[1], c[3], c[5], c[7]) > vy1) continue;
      const [x, y] = this.toScreen(t.x, t.y);
      ctx.setTransform(dpr, 0, 0, dpr, x * dpr, y * dpr);
      ctx.rotate(-t.rot);
      if (t.wf !== 1) ctx.scale(t.wf, 1);
      ctx.fillStyle = colorOverride ?? t.color;
      ctx.font = `${px}px "Segoe UI", Arial, sans-serif`;
      ctx.textAlign = t.align;
      ctx.textBaseline = t.base;
      ctx.fillText(t.str, 0, 0);
    }
  }

  _renderItem(it, color, width, withDims) {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const [ox, oy] = this.origin;
    ctx.setTransform(...this._worldTransform());
    const p = new Path2D();
    for (const s of it.strokes) addPath(p, s.pts, s.closed, ox, oy);
    const fp = new Path2D();
    for (const f of it.fills) for (const r of f.rings) addPath(fp, r, true, ox, oy);
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = color;
    ctx.fill(fp, 'evenodd');
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = width / this.view.s;
    ctx.stroke(p);
    ctx.stroke(fp);
    this._renderTexts(it.texts, color);
    for (const pt of it.points) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const [x, y] = this.toScreen(pt.x, pt.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 5, y - 5, 10, 10);
    }
    if (withDims) this._renderDims(it, color);
  }

  /** Caixa envolvente tracejada com as cotas de largura e altura. */
  _renderDims(it, color) {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [x0, y0] = this.toScreen(it.bbox[0], it.bbox[3]);
    const [x1, y1] = this.toScreen(it.bbox[2], it.bbox[1]);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 - 0.5, y0 - 0.5, x1 - x0 + 1, y1 - y0 + 1);
    ctx.restore();

    const u = this.units ? ' ' + this.units : '';
    const label = (text, x, y, rot = 0) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.font = '600 12px "Segoe UI", Arial, sans-serif';
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = 'rgba(8, 47, 73, 0.92)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -10, w, 20, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e0f2fe';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 0, 0.5);
      ctx.restore();
    };
    // linhas de cota
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y1 + 14);
    ctx.lineTo(x1, y1 + 14);
    ctx.moveTo(x1 + 14, y0);
    ctx.lineTo(x1 + 14, y1);
    ctx.stroke();
    label('L ' + this.fmt(it.m.width) + u, (x0 + x1) / 2, y1 + 14);
    label('A ' + this.fmt(it.m.height) + u, x1 + 14, (y0 + y1) / 2, -Math.PI / 2);
  }
}

// ------------------------------------------------------------ utilitários
function addPath(p, pts, closed, ox, oy) {
  p.moveTo(pts[0] - ox, pts[1] - oy);
  for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i] - ox, pts[i + 1] - oy);
  if (closed) p.closePath();
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToPolyline(x, y, pts, closed) {
  let d = Infinity;
  const n = pts.length;
  for (let i = 2; i < n; i += 2) d = Math.min(d, distToSeg(x, y, pts[i - 2], pts[i - 1], pts[i], pts[i + 1]));
  if (closed && n >= 4) d = Math.min(d, distToSeg(x, y, pts[n - 2], pts[n - 1], pts[0], pts[1]));
  if (n === 2) d = Math.hypot(x - pts[0], y - pts[1]);
  return d;
}

function inRing(x, y, pts) {
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRings(x, y, rings) {
  let c = 0;
  for (const r of rings) if (inRing(x, y, r)) c++;
  return c % 2 === 1;
}
