// Converte o banco de dados do libredwg-web (DwgDatabase) em primitivas 2D
// prontas para desenho (polilinhas, preenchimentos e textos em coordenadas do
// mundo) e calcula as dimensões de cada objeto.

import { aciToHex, rgbIntToHex } from './colors.js';

const TAU = Math.PI * 2;
const MAX_DEPTH = 10;
const IDENTITY = [1, 0, 0, 1, 0, 0];

// ---------------------------------------------------------------------------
// Matrizes afins 2D: [a, b, c, d, e, f] => x' = a*x + c*y + e ; y' = b*x + d*y + f
// ---------------------------------------------------------------------------
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x, y) => [1, 0, 0, 1, x, y];
const rotate = (a) => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0];
const MIRROR_X = [-1, 0, 0, 1, 0, 0];

/** Entidades 2D planas usam o sistema OCS; extrusão (0,0,-1) espelha o eixo X. */
function ocs(ent) {
  const z = ent.extrusionDirection?.z;
  return z != null && z < 0 ? MIRROR_X : IDENTITY;
}

const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

// ---------------------------------------------------------------------------
// Tesselação de curvas (em coordenadas locais)
// ---------------------------------------------------------------------------
function segCount(sweep) {
  return Math.max(4, Math.ceil((Math.abs(sweep) / TAU) * 96));
}

function arcPoints(cx, cy, r, a0, a1, out, skipFirst = false) {
  const n = segCount(a1 - a0);
  for (let i = skipFirst ? 1 : 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

function ellipsePoints(cx, cy, mx, my, ratio, t0, t1, out, skipFirst = false) {
  // eixo menor = eixo maior girado 90° * razão
  const nx = -my * ratio;
  const ny = mx * ratio;
  const n = segCount(t1 - t0);
  for (let i = skipFirst ? 1 : 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push(cx + mx * c + nx * s, cy + my * c + ny * s);
  }
  return out;
}

/** Arco definido por "bulge" entre dois vértices de polilinha (sem incluir p1). */
function bulgePoints(x1, y1, x2, y2, bulge, out) {
  const theta = 4 * Math.atan(bulge);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12 || Math.abs(bulge) < 1e-9) {
    out.push(x2, y2);
    return;
  }
  const r = chord / (2 * Math.sin(theta / 2));
  const h = r * Math.cos(theta / 2);
  const cx = (x1 + x2) / 2 - (h * dy) / chord;
  const cy = (y1 + y2) / 2 + (h * dx) / chord;
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  const n = segCount(theta);
  const ar = Math.abs(r);
  for (let i = 1; i < n; i++) {
    const a = a0 + (theta * i) / n;
    out.push(cx + ar * Math.cos(a), cy + ar * Math.sin(a));
  }
  out.push(x2, y2);
}

/** Vértices com bulge => lista plana [x0,y0,x1,y1,...]. */
function bulgePolyline(vertices, closed) {
  const out = [];
  const n = vertices.length;
  if (!n) return out;
  out.push(num(vertices[0].x), num(vertices[0].y));
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    bulgePoints(num(a.x), num(a.y), num(b.x), num(b.y), num(a.bulge), out);
  }
  if (closed && out.length >= 4) {
    // remove o ponto duplicado de fechamento (o traço fecha sozinho)
    const l = out.length;
    if (Math.abs(out[l - 2] - out[0]) < 1e-12 && Math.abs(out[l - 1] - out[1]) < 1e-12) out.length = l - 2;
  }
  return out;
}

/** Avaliação de B-spline/NURBS pelo algoritmo de De Boor. */
function splinePoints(degree, knots, cps, weights) {
  const n = cps.length;
  const p = degree;
  if (!n || !knots || knots.length !== n + p + 1 || p < 1) return null;
  const t0 = knots[p];
  const t1 = knots[n];
  if (!(t1 > t0)) return null;
  const samples = Math.min(1000, Math.max(24, n * 12));
  const out = [];
  const d = new Array(p + 1);
  for (let s = 0; s <= samples; s++) {
    const t = s === samples ? t1 - 1e-12 * (t1 - t0) : t0 + ((t1 - t0) * s) / samples;
    let k = p;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    for (let j = 0; j <= p; j++) {
      const i = k - p + j;
      const w = num(weights?.[i] ?? cps[i].weight, 1) || 1;
      d[j] = [num(cps[i].x) * w, num(cps[i].y) * w, w];
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = knots[i + p - r + 1] - knots[i];
        const alpha = den === 0 ? 0 : (t - knots[i]) / den;
        d[j] = [
          (1 - alpha) * d[j - 1][0] + alpha * d[j][0],
          (1 - alpha) * d[j - 1][1] + alpha * d[j][1],
          (1 - alpha) * d[j - 1][2] + alpha * d[j][2],
        ];
      }
    }
    out.push(d[p][0] / d[p][2], d[p][1] / d[p][2]);
  }
  return out;
}

const flat = (points) => {
  const out = [];
  for (const p of points) out.push(num(p.x), num(p.y));
  return out;
};

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------
function decodeSpecial(s) {
  return String(s ?? '')
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoO]/g, '')
    .replace(/%%%/g, '%');
}

export function cleanMText(s) {
  return decodeSpecial(s)
    .replace(/\\P/g, '\n')
    .replace(/\\S([^;]*?)[\^#/]([^;]*?);/g, '$1/$2')
    .replace(/\\[ACcFfHhQqTtWwp][^;\\]*;/g, '')
    .replace(/\\[LlOoKkNX]/g, '')
    .replace(/\\~/g, ' ')
    .replace(/\\\{/g, '\u0001')
    .replace(/\\\}/g, '\u0002')
    .replace(/[{}]/g, '')
    .replace(/\u0001/g, '{')
    .replace(/\u0002/g, '}')
    .replace(/\\\\/g, '\\');
}

// ---------------------------------------------------------------------------
// Construção da cena
// ---------------------------------------------------------------------------
class SceneBuilder {
  constructor(db) {
    this.db = db;
    this.layers = new Map();
    for (const l of db.tables?.LAYER?.entries ?? []) this.layers.set(l.name, l);
    this.blocks = new Map();
    for (const b of db.tables?.BLOCK_RECORD?.entries ?? []) this.blocks.set(b.name, b);
    this.warnings = new Set();
  }

  layerColor(name) {
    const l = this.layers.get(name);
    if (!l) return '#ffffff';
    const idx = Math.abs(num(l.colorIndex, 7));
    if (idx >= 1 && idx <= 255) return aciToHex(idx);
    if (l.color != null) return rgbIntToHex(l.color);
    return '#ffffff';
  }

  isLayerHidden(name) {
    const l = this.layers.get(name);
    return !!l && (l.off || l.frozen || num(l.colorIndex, 1) < 0);
  }

  resolveColor(ent, ctx) {
    if (ent.color != null) return rgbIntToHex(ent.color);
    const idx = num(ent.colorIndex, 256);
    if (idx === 0) return ctx.byBlockColor ?? '#ffffff';
    if (idx === 256 || idx < 0 || idx > 256) {
      const layer = ent.layer === '0' && ctx.layer ? ctx.layer : ent.layer;
      return this.layerColor(layer);
    }
    return aciToHex(idx);
  }

  // out = { strokes: [{pts, closed, color}], fills: [{rings, color, alpha}], texts: [...] }
  addStroke(out, m, pts, closed, color) {
    if (pts.length < 4) return;
    const t = new Float64Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i];
      const y = pts[i + 1];
      t[i] = m[0] * x + m[2] * y + m[4];
      t[i + 1] = m[1] * x + m[3] * y + m[5];
    }
    out.strokes.push({ pts: t, closed, color });
  }

  addFill(out, m, rings, color, alpha) {
    const tr = [];
    for (const pts of rings) {
      if (pts.length < 6) continue;
      const t = new Float64Array(pts.length);
      for (let i = 0; i < pts.length; i += 2) {
        t[i] = m[0] * pts[i] + m[2] * pts[i + 1] + m[4];
        t[i + 1] = m[1] * pts[i] + m[3] * pts[i + 1] + m[5];
      }
      tr.push(t);
    }
    if (tr.length) out.fills.push({ rings: tr, color, alpha });
  }

  addText(out, m, x, y, rot, h, str, align, base, color, widthFactor = 1) {
    if (!str || !(h > 0)) return;
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    const dx = m[0] * Math.cos(rot) + m[2] * Math.sin(rot);
    const dy = m[1] * Math.cos(rot) + m[3] * Math.sin(rot);
    const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    const hw = h * k;
    const wr = Math.atan2(dy, dx);
    // caixa aproximada para medição / seleção
    const w = str.length * hw * 0.6 * (widthFactor || 1);
    const x0 = align === 'center' ? -w / 2 : align === 'right' ? -w : 0;
    const [y0, y1] =
      base === 'middle' ? [-hw / 2, hw / 2] : base === 'top' ? [-hw, 0] : base === 'bottom' ? [0, hw] : [-0.2 * hw, hw];
    const c = Math.cos(wr);
    const s = Math.sin(wr);
    const corners = new Float64Array(8);
    [
      [x0, y0],
      [x0 + w, y0],
      [x0 + w, y1],
      [x0, y1],
    ].forEach(([lx, ly], i) => {
      corners[i * 2] = px + lx * c - ly * s;
      corners[i * 2 + 1] = py + lx * s + ly * c;
    });
    out.texts.push({ x: px, y: py, rot: wr, h: hw, str, align, base, color, corners, wf: widthFactor || 1 });
  }

  /** Converte uma entidade (e sub-entidades de blocos) em primitivas. */
  collect(ent, ctx, out) {
    if (!ent || ent.isVisible === false) return;
    if (ctx.depth > 0 && this.isLayerHidden(ent.layer)) return;
    const color = this.resolveColor(ent, ctx);
    const m = mul(ctx.m, ocs(ent));
    const W = ctx.m; // entidades definidas em WCS

    switch (ent.type) {
      case 'LINE':
        this.addStroke(out, W, [num(ent.startPoint?.x), num(ent.startPoint?.y), num(ent.endPoint?.x), num(ent.endPoint?.y)], false, color);
        break;

      case 'LWPOLYLINE': {
        const closed = (num(ent.flag) & 1) === 1;
        this.addStroke(out, m, bulgePolyline(ent.vertices ?? [], closed), closed, color);
        break;
      }

      case 'POLYLINE2D': {
        const closed = (num(ent.flag) & 1) === 1;
        const verts = (ent.vertices ?? []).filter((v) => !(num(v.flag) & 16)); // ignora pontos de controle
        this.addStroke(out, m, bulgePolyline(verts, closed), closed, color);
        break;
      }

      case 'POLYLINE3D': {
        const closed = (num(ent.flag) & 1) === 1;
        this.addStroke(out, W, flat(ent.vertices ?? []), closed, color);
        break;
      }

      case 'CIRCLE': {
        const pts = arcPoints(num(ent.center?.x), num(ent.center?.y), num(ent.radius), 0, TAU, []);
        pts.length -= 2;
        this.addStroke(out, m, pts, true, color);
        break;
      }

      case 'ARC': {
        let a0 = num(ent.startAngle);
        let a1 = num(ent.endAngle);
        while (a1 <= a0) a1 += TAU;
        this.addStroke(out, m, arcPoints(num(ent.center?.x), num(ent.center?.y), num(ent.radius), a0, a1, []), false, color);
        break;
      }

      case 'ELLIPSE': {
        let t0 = num(ent.startAngle);
        let t1 = num(ent.endAngle, TAU);
        while (t1 <= t0) t1 += TAU;
        const full = Math.abs(t1 - t0 - TAU) < 1e-6;
        const pts = ellipsePoints(num(ent.center?.x), num(ent.center?.y), num(ent.majorAxisEndPoint?.x), num(ent.majorAxisEndPoint?.y), num(ent.axisRatio, 1), t0, t1, []);
        if (full) pts.length -= 2;
        this.addStroke(out, W, pts, full, color);
        break;
      }

      case 'SPLINE': {
        let pts = null;
        if (ent.controlPoints?.length) pts = splinePoints(num(ent.degree, 3), ent.knots, ent.controlPoints, ent.weights);
        if (!pts && ent.fitPoints?.length) pts = flat(ent.fitPoints);
        if (!pts && ent.controlPoints?.length) pts = flat(ent.controlPoints);
        if (pts) this.addStroke(out, W, pts, (num(ent.flag) & 1) === 1, color);
        break;
      }

      case 'SOLID':
      case 'TRACE': {
        const c = [ent.corner1, ent.corner2, ent.corner4 ?? ent.corner3, ent.corner3].filter(Boolean);
        const pts = flat(c);
        this.addFill(out, m, [pts], color, 1);
        this.addStroke(out, m, pts, true, color);
        break;
      }

      case '3DFACE': {
        const c = [ent.corner1, ent.corner2, ent.corner3, ent.corner4].filter(Boolean);
        this.addStroke(out, W, flat(c), true, color);
        break;
      }

      case 'POINT': {
        const x = num(ent.position?.x);
        const y = num(ent.position?.y);
        out.points.push({ x: W[0] * x + W[2] * y + W[4], y: W[1] * x + W[3] * y + W[5], color });
        break;
      }

      case 'TEXT':
      case 'ATTRIB': {
        if (ent.type === 'ATTRIB' && (num(ent.flags) & 1)) break; // atributo invisível
        const str = decodeSpecial(ent.text);
        const h = num(ent.textHeight);
        const ha = num(ent.halign);
        const va = num(ent.valign);
        let p = ent.startPoint;
        let align = 'left';
        let base = 'alphabetic';
        if ((ha !== 0 || va !== 0) && ha !== 3 && ha !== 5 && ent.endPoint) {
          p = ent.endPoint;
          align = ha === 1 || ha === 4 ? 'center' : ha === 2 ? 'right' : 'left';
          base = ha === 4 ? 'middle' : ['alphabetic', 'bottom', 'middle', 'top'][va] ?? 'alphabetic';
        }
        this.addText(out, m, num(p?.x), num(p?.y), num(ent.rotation), h, str, align, base, color, num(ent.xScale, 1));
        break;
      }

      case 'MTEXT': {
        const lines = cleanMText(ent.text).split('\n');
        const h = num(ent.textHeight, 1);
        const ap = num(ent.attachmentPoint, 1);
        const col = (ap - 1) % 3;
        const row = Math.floor((ap - 1) / 3);
        const spacing = h * 1.667 * num(ent.lineSpacing, 1);
        const blockH = h + (lines.length - 1) * spacing;
        const topY = row === 0 ? 0 : row === 1 ? blockH / 2 : blockH;
        const dir = ent.direction;
        const rot = dir && (dir.x || dir.y) ? Math.atan2(dir.y, dir.x) : num(ent.rotation);
        const ix = num(ent.insertionPoint?.x);
        const iy = num(ent.insertionPoint?.y);
        const c = Math.cos(rot);
        const s = Math.sin(rot);
        const align = ['left', 'center', 'right'][col];
        lines.forEach((line, i) => {
          const ly = topY - h - i * spacing; // linha de base local
          this.addText(out, W, ix - ly * s, iy + ly * c, rot, h, line, align, 'alphabetic', color);
        });
        break;
      }

      case 'INSERT': {
        this.collectInsert(ent, ctx, out, color, m);
        break;
      }

      case 'DIMENSION': {
        const blk = this.blocks.get(ent.name);
        if (blk?.entities?.length && ctx.depth < MAX_DEPTH) {
          const sub = { m: W, layer: ent.layer === '0' ? ctx.layer : ent.layer, byBlockColor: color, depth: ctx.depth + 1 };
          for (const e of blk.entities) this.collect(e, sub, out);
        } else {
          const a = ent.subDefinitionPoint1;
          const b = ent.subDefinitionPoint2;
          if (a && b) this.addStroke(out, W, [a.x, a.y, b.x, b.y], false, color);
          if (ent.textPoint && ent.measurement != null) {
            this.addText(out, W, ent.textPoint.x, ent.textPoint.y, num(ent.textRotation), 2.5, ent.text || ent.measurement.toFixed(2), 'center', 'middle', color);
          }
        }
        break;
      }

      case 'HATCH': {
        const rings = [];
        for (const path of ent.boundaryPaths ?? []) {
          const r = this.hatchRing(path);
          if (r.length >= 4) rings.push(r);
        }
        const solid = num(ent.solidFill) === 1;
        this.addFill(out, m, rings, color, solid ? 1 : 0.22);
        if (!solid) for (const r of rings) this.addStroke(out, m, r, true, color);
        break;
      }

      case 'LEADER':
      case 'MLINE': {
        const verts = (ent.vertices ?? []).map((v) => v.vertex ?? v.position ?? v).filter((v) => v && v.x != null);
        if (verts.length > 1) this.addStroke(out, W, flat(verts), false, color);
        break;
      }

      case 'ATTDEF':
      case 'RAY':
      case 'XLINE':
      case 'VIEWPORT':
        break; // não desenhados (definições de atributo / linhas infinitas / janelas de papel)

      default:
        this.warnings.add(ent.type);
    }
  }

  collectInsert(ent, ctx, out, color, m) {
    const blk = this.blocks.get(ent.name);
    if (blk && ctx.depth < MAX_DEPTH) {
      const bp = blk.basePoint ?? { x: 0, y: 0 };
      const ip = ent.insertionPoint ?? { x: 0, y: 0 };
      const sx = num(ent.xScale, 1) || 1;
      const sy = num(ent.yScale, 1) || 1;
      const cols = Math.max(1, num(ent.columnCount, 1));
      const rows = Math.max(1, num(ent.rowCount, 1));
      const base = mul(mul(m, translate(num(ip.x), num(ip.y))), rotate(num(ent.rotation)));
      const tail = mul(scale(sx, sy), translate(-num(bp.x), -num(bp.y)));
      const layer = ent.layer === '0' && ctx.layer ? ctx.layer : ent.layer;
      for (let r = 0; r < rows && r < 100; r++) {
        for (let c = 0; c < cols && c < 100; c++) {
          const off = translate(c * num(ent.columnSpacing), r * num(ent.rowSpacing));
          const sub = { m: mul(mul(base, off), tail), layer, byBlockColor: color, depth: ctx.depth + 1 };
          for (const e of blk.entities ?? []) {
            if (e.type === 'ATTDEF') continue;
            this.collect(e, sub, out);
          }
        }
      }
    }
    // atributos já estão posicionados no desenho (não no bloco)
    const attCtx = { ...ctx, layer: ent.layer, byBlockColor: color };
    for (const a of ent.attribs ?? []) this.collect(a, attCtx, out);
  }

  hatchRing(path) {
    if (path.vertices) return bulgePolyline(path.vertices, true);
    const pts = [];
    for (const e of path.edges ?? []) {
      const skip = pts.length > 0;
      switch (e.type) {
        case 1: // linha
          if (!skip) pts.push(num(e.start?.x), num(e.start?.y));
          pts.push(num(e.end?.x), num(e.end?.y));
          break;
        case 2: {
          // arco
          let a0 = num(e.startAngle);
          let a1 = num(e.endAngle);
          if (e.isCCW === false) {
            a0 = -a0;
            a1 = -a1;
            while (a1 >= a0) a1 -= TAU;
          } else {
            while (a1 <= a0) a1 += TAU;
          }
          arcPoints(num(e.center?.x), num(e.center?.y), num(e.radius), a0, a1, pts, false);
          break;
        }
        case 3: {
          // elipse
          let a0 = num(e.startAngle);
          let a1 = num(e.endAngle);
          if (e.isCCW === false) {
            a0 = -a0;
            a1 = -a1;
            while (a1 >= a0) a1 -= TAU;
          } else {
            while (a1 <= a0) a1 += TAU;
          }
          ellipsePoints(num(e.center?.x), num(e.center?.y), num(e.end?.x), num(e.end?.y), num(e.lengthOfMinorAxis, 1), a0, a1, pts, false);
          break;
        }
        case 4: {
          // spline
          let sp = e.controlPoints?.length ? splinePoints(num(e.degree, 3), e.knots, e.controlPoints) : null;
          if (!sp && e.fitDatum?.length) sp = flat(e.fitDatum);
          if (sp) pts.push(...sp);
          break;
        }
      }
    }
    return pts;
  }
}

// ---------------------------------------------------------------------------
// Medições
// ---------------------------------------------------------------------------
function polyLength(pts, closed) {
  let len = 0;
  for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  if (closed && pts.length >= 4) len += Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]);
  return len;
}

function signedArea(pts) {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return a / 2;
}

function pointInRing(x, y, pts) {
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = pts[i];
    const yi = pts[i + 1];
    const xj = pts[j];
    const yj = pts[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Área com regra par-ímpar (furos descontados). */
function ringsArea(rings) {
  let total = 0;
  rings.forEach((r, i) => {
    const depth = rings.reduce((d, o, j) => (j !== i && pointInRing(r[0], r[1], o) ? d + 1 : d), 0);
    total += (depth % 2 === 0 ? 1 : -1) * Math.abs(signedArea(r));
  });
  return Math.abs(total);
}

/** Retângulo orientado de menor área (fecho convexo + "rotating calipers"). */
function minAreaRect(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a] - xs[b] || ys[a] - ys[b]);
  const cross = (o, a, b) => (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);
  const lower = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 2) return null;
  let best = null;
  for (let k = 0; k < hull.length; k++) {
    const a = hull[k];
    const b = hull[(k + 1) % hull.length];
    const ex = xs[b] - xs[a];
    const ey = ys[b] - ys[a];
    const len = Math.hypot(ex, ey);
    if (len < 1e-12) continue;
    const ux = ex / len;
    const uy = ey / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const h of hull) {
      const u = xs[h] * ux + ys[h] * uy;
      const v = -xs[h] * uy + ys[h] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const area = w * h;
    if (!best || area < best.area - 1e-12) best = { area, a: w, b: h, angle: Math.atan2(uy, ux) };
  }
  if (!best) return null;
  const long = Math.max(best.a, best.b);
  const short = Math.min(best.a, best.b);
  let angle = best.a >= best.b ? best.angle : best.angle + Math.PI / 2;
  angle = ((angle % Math.PI) + Math.PI) % Math.PI; // 0..180°
  return { long, short, angle };
}

function measure(item, ent) {
  const xs = [];
  const ys = [];
  const push = (arr) => {
    for (let i = 0; i < arr.length; i += 2) {
      xs.push(arr[i]);
      ys.push(arr[i + 1]);
    }
  };
  let length = 0;
  const closedRings = [];
  for (const s of item.strokes) {
    push(s.pts);
    length += polyLength(s.pts, s.closed);
    if (s.closed && s.pts.length >= 6) closedRings.push(s.pts);
  }
  for (const f of item.fills) f.rings.forEach(push);
  for (const t of item.texts) push(t.corners);
  for (const p of item.points) {
    xs.push(p.x);
    ys.push(p.y);
  }
  if (!xs.length) return false;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  item.bbox = [minX, minY, maxX, maxY];

  // limita a quantidade de pontos no fecho convexo para blocos muito grandes
  let hx = xs;
  let hy = ys;
  if (xs.length > 40000) {
    const step = Math.ceil(xs.length / 40000);
    hx = xs.filter((_, i) => i % step === 0);
    hy = ys.filter((_, i) => i % step === 0);
  }
  const rect = minAreaRect(hx, hy);

  let area = null;
  if (ent.type === 'HATCH' && item.fills.length) area = ringsArea(item.fills[0].rings);
  else if (ent.type === 'SOLID' || ent.type === 'TRACE') area = Math.abs(signedArea(item.fills[0]?.rings[0] ?? []));
  else if (closedRings.length === 1 && item.strokes.length === 1) area = Math.abs(signedArea(closedRings[0]));
  else if (ent.type === 'CIRCLE') area = Math.PI * ent.radius * ent.radius;

  item.m = {
    width: maxX - minX,
    height: maxY - minY,
    length: item.strokes.length ? length : null,
    area,
    rectLong: rect ? rect.long : null,
    rectShort: rect ? rect.short : null,
    rectAngle: rect ? rect.angle : null,
  };
  return true;
}

/** Propriedades específicas de cada tipo, exibidas no painel de detalhes. */
function describe(ent) {
  const P = [];
  const d = (v) => (typeof v === 'number' ? v : null);
  switch (ent.type) {
    case 'LINE': {
      const dx = ent.endPoint.x - ent.startPoint.x;
      const dy = ent.endPoint.y - ent.startPoint.y;
      P.push(['Início', 'pt', ent.startPoint], ['Fim', 'pt', ent.endPoint], ['ΔX', 'len', dx], ['ΔY', 'len', dy]);
      P.push(['Ângulo', 'deg', ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360]);
      break;
    }
    case 'CIRCLE':
      P.push(['Centro', 'pt', ent.center], ['Raio', 'len', ent.radius], ['Diâmetro', 'len', ent.radius * 2]);
      break;
    case 'ARC': {
      let sweep = ent.endAngle - ent.startAngle;
      while (sweep <= 0) sweep += TAU;
      P.push(['Centro', 'pt', ent.center], ['Raio', 'len', ent.radius]);
      P.push(['Ângulo inicial', 'deg', (ent.startAngle * 180) / Math.PI], ['Ângulo final', 'deg', (ent.endAngle * 180) / Math.PI]);
      P.push(['Abertura', 'deg', (sweep * 180) / Math.PI]);
      break;
    }
    case 'ELLIPSE': {
      const major = Math.hypot(ent.majorAxisEndPoint.x, ent.majorAxisEndPoint.y);
      P.push(['Centro', 'pt', ent.center], ['Semi-eixo maior', 'len', major], ['Semi-eixo menor', 'len', major * ent.axisRatio]);
      break;
    }
    case 'LWPOLYLINE':
    case 'POLYLINE2D':
    case 'POLYLINE3D':
      P.push(['Vértices', 'num', ent.vertices?.length ?? 0], ['Fechada', 'text', num(ent.flag) & 1 ? 'Sim' : 'Não']);
      if (d(ent.constantWidth)) P.push(['Largura constante', 'len', ent.constantWidth]);
      break;
    case 'INSERT':
      P.push(['Bloco', 'text', ent.name], ['Inserção', 'pt', ent.insertionPoint]);
      P.push(['Escala X', 'num', ent.xScale], ['Escala Y', 'num', ent.yScale], ['Rotação', 'deg', (num(ent.rotation) * 180) / Math.PI]);
      if (ent.attribs?.length) P.push(['Atributos', 'text', ent.attribs.map((a) => `${a.tag ?? ''}=${a.text ?? ''}`).join('; ')]);
      break;
    case 'TEXT':
    case 'ATTRIB':
      P.push(['Texto', 'text', decodeSpecial(ent.text)], ['Altura do texto', 'len', ent.textHeight], ['Rotação', 'deg', (num(ent.rotation) * 180) / Math.PI]);
      break;
    case 'MTEXT':
      P.push(['Texto', 'text', cleanMText(ent.text)], ['Altura do texto', 'len', ent.textHeight]);
      break;
    case 'DIMENSION':
      if (d(ent.measurement) != null) P.push(['Valor medido', 'len', ent.measurement]);
      if (ent.text) P.push(['Texto', 'text', cleanMText(ent.text)]);
      P.push(['Estilo', 'text', ent.styleName]);
      break;
    case 'HATCH':
      P.push(['Padrão', 'text', ent.patternName], ['Sólido', 'text', num(ent.solidFill) === 1 ? 'Sim' : 'Não'], ['Contornos', 'num', ent.boundaryPaths?.length ?? 0]);
      break;
    case 'SPLINE':
      P.push(['Grau', 'num', ent.degree], ['Pontos de controle', 'num', ent.controlPoints?.length ?? 0]);
      break;
    case 'POINT':
      P.push(['Posição', 'pt', ent.position]);
      break;
  }
  if (d(ent.thickness)) P.push(['Espessura (extrusão)', 'len', ent.thickness]);
  return P;
}

const TYPE_NAMES = {
  LINE: 'Linha',
  LWPOLYLINE: 'Polilinha',
  POLYLINE2D: 'Polilinha 2D',
  POLYLINE3D: 'Polilinha 3D',
  CIRCLE: 'Círculo',
  ARC: 'Arco',
  ELLIPSE: 'Elipse',
  SPLINE: 'Spline',
  SOLID: 'Sólido 2D',
  TRACE: 'Trace',
  '3DFACE': 'Face 3D',
  POINT: 'Ponto',
  TEXT: 'Texto',
  MTEXT: 'Texto (MText)',
  ATTRIB: 'Atributo',
  INSERT: 'Bloco',
  DIMENSION: 'Cota',
  HATCH: 'Hachura',
  LEADER: 'Chamada',
  MLINE: 'Multilinha',
};
export const typeName = (t) => TYPE_NAMES[t] ?? t;

export const UNITS = {
  0: '',
  1: 'pol',
  2: 'pés',
  3: 'milhas',
  4: 'mm',
  5: 'cm',
  6: 'm',
  7: 'km',
  8: 'micropol',
  9: 'mils',
  10: 'jardas',
  11: 'Å',
  12: 'nm',
  13: 'µm',
  14: 'dm',
  15: 'dam',
  16: 'hm',
};

/** Espaço de trabalho: 'model' (Model Space) ou 'paper' (primeiro Paper Space). */
function spaceEntities(db, space) {
  const btrs = db.tables?.BLOCK_RECORD?.entries ?? [];
  const re = space === 'paper' ? /^\*paper_space/i : /^\*model_space$/i;
  const btr = btrs.find((b) => re.test(b.name));
  if (btr?.entities) return btr.entities;
  return db.entities ?? [];
}

export function buildScene(db, space = 'model') {
  const sb = new SceneBuilder(db);
  const items = [];
  const entities = spaceEntities(db, space);
  const rootCtx = { m: IDENTITY, layer: null, byBlockColor: null, depth: 0 };
  let hidden = 0;

  for (const ent of entities) {
    if (sb.isLayerHidden(ent.layer)) {
      hidden++;
      continue;
    }
    const out = { strokes: [], fills: [], texts: [], points: [] };
    try {
      sb.collect(ent, rootCtx, out);
    } catch (err) {
      console.warn('Falha ao processar entidade', ent.type, ent.handle, err);
      continue;
    }
    const item = { id: items.length, handle: ent.handle, type: ent.type, layer: ent.layer, ...out, ent };
    if (!measure(item, ent)) continue;
    item.props = describe(ent);
    item.label = ent.type === 'INSERT' ? ent.name : '';
    items.push(item);
  }

  return {
    items,
    extents: robustExtents(items),
    units: UNITS[num(db.header?.INSUNITS)] ?? '',
    layers: [...sb.layers.values()].map((l) => ({ name: l.name, color: sb.layerColor(l.name), hidden: sb.isLayerHidden(l.name) })),
    unsupported: [...sb.warnings],
    hidden,
    total: entities.length,
    hasPaper: (db.tables?.BLOCK_RECORD?.entries ?? []).some((b) => /^\*paper_space/i.test(b.name) && b.entities?.length),
  };
}

/** Extensão do desenho ignorando objetos isolados muito distantes. */
function robustExtents(items) {
  if (!items.length) return [0, 0, 100, 100];
  const union = (list) =>
    list.reduce((e, it) => [Math.min(e[0], it.bbox[0]), Math.min(e[1], it.bbox[1]), Math.max(e[2], it.bbox[2]), Math.max(e[3], it.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  if (items.length < 20) return union(items);
  const cx = items.map((i) => (i.bbox[0] + i.bbox[2]) / 2).sort((a, b) => a - b);
  const cy = items.map((i) => (i.bbox[1] + i.bbox[3]) / 2).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  const x0 = q(cx, 0.02), x1 = q(cx, 0.98), y0 = q(cy, 0.02), y1 = q(cy, 0.98);
  const rx = Math.max(x1 - x0, 1e-9);
  const ry = Math.max(y1 - y0, 1e-9);
  const keep = items.filter((i) => {
    const x = (i.bbox[0] + i.bbox[2]) / 2;
    const y = (i.bbox[1] + i.bbox[3]) / 2;
    return x >= x0 - rx && x <= x1 + rx && y >= y0 - ry && y <= y1 + ry;
  });
  return union(keep.length ? keep : items);
}
