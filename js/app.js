import { Viewer } from './viewer.js';
import { typeName } from './geometry.js';

const $ = (id) => document.getElementById(id);
const MAX_ROWS = 1500;

const state = {
  scene: null,
  fileName: '',
  sortKey: null,
  sortDesc: false,
  hiddenLayers: new Set(),
  rows: [],
};

const viewer = new Viewer($('canvas'));
window.__viewer = viewer; // para depuração no console

// ------------------------------------------------------------ formatação
const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const nf2 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
function fmt(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e9)) return v.toExponential(3).replace('.', ',');
  return nf.format(v);
}
viewer.fmt = fmt;
// versão compacta (2 casas) para as células da tabela
function fmtT(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-2 || a >= 1e9)) return v.toExponential(2).replace('.', ',');
  return nf2.format(v);
}
const unitSuffix = (kind) => {
  const u = state.scene?.units;
  if (!u) return '';
  return kind === 'area' ? ` ${u}²` : ` ${u}`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ------------------------------------------------------------ worker
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.postMessage({ cmd: 'init' });
worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd === 'ready') {
    $('lib-status').textContent = 'Biblioteca LibreDWG pronta ✓';
    $('lib-status').className = 'hint ok';
  } else if (msg.cmd === 'progress') {
    showLoading(msg.text);
  } else if (msg.cmd === 'scene') {
    hideLoading();
    onScene(msg.scene);
  } else if (msg.cmd === 'error') {
    hideLoading();
    if (!state.scene) {
      $('lib-status').textContent = 'Erro: ' + msg.message;
      $('lib-status').className = 'hint err';
    }
    alert('Erro ao abrir o arquivo:\n' + msg.message);
  }
};
worker.onerror = (e) => {
  hideLoading();
  $('lib-status').textContent = 'Falha ao iniciar o leitor de DWG: ' + (e.message || 'erro desconhecido');
  $('lib-status').className = 'hint err';
};

function showLoading(text) {
  $('loading').hidden = false;
  $('loading-text').textContent = text;
}
function hideLoading() {
  $('loading').hidden = true;
}

// ------------------------------------------------------------ abrir arquivo
async function openFile(file) {
  if (!file) return;
  if (!/\.dwg$/i.test(file.name)) {
    alert('Selecione um arquivo com extensão .dwg');
    return;
  }
  state.fileName = file.name;
  showLoading('Lendo arquivo…');
  const buffer = await file.arrayBuffer();
  worker.postMessage({ cmd: 'open', buffer }, [buffer]);
}

for (const id of ['file-input', 'file-input-2']) {
  $(id).addEventListener('change', (e) => {
    openFile(e.target.files[0]);
    e.target.value = '';
  });
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  openFile(e.dataTransfer.files[0]);
});

// ?url=arquivo.dwg abre um DWG remoto (útil para demonstrações)
const remote = new URLSearchParams(location.search).get('url');
if (remote) {
  showLoading('Baixando arquivo…');
  fetch(remote)
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    })
    .then((b) => openFile(new File([b], decodeURIComponent(remote.split('/').pop().split('?')[0]) || 'arquivo.dwg')))
    .catch((err) => {
      hideLoading();
      alert('Não foi possível baixar o arquivo: ' + err.message);
    });
}

// ------------------------------------------------------------ cena carregada
function onScene(scene) {
  state.scene = scene;
  window.__scene = scene; // para depuração no console
  $('empty').classList.add('hidden');
  viewer.units = scene.units;
  state.hiddenLayers = new Set(scene.layers.filter((l) => l.hidden).map((l) => l.name));
  viewer.hiddenLayers = new Set();
  viewer.setScene(scene);

  const ext = scene.extents;
  $('file-info').innerHTML =
    `<b>${esc(state.fileName)}</b> · ${scene.items.length.toLocaleString('pt-BR')} objetos · ` +
    `${fmt(ext[2] - ext[0])} × ${fmt(ext[3] - ext[1])}${unitSuffix()}` +
    (scene.units ? '' : ' · unidade não definida');
  $('space-select').hidden = !scene.hasPaper;
  $('space-select').value = scene.space;
  if (scene.unsupported.length) console.info('Tipos não desenhados:', scene.unsupported.join(', '));

  buildFilters();
  buildLayerList();
  showDetails(null);
  renderTable();
}

function buildFilters() {
  const types = new Map();
  const layers = new Map();
  for (const it of state.scene.items) {
    types.set(it.type, (types.get(it.type) || 0) + 1);
    layers.set(it.layer, (layers.get(it.layer) || 0) + 1);
  }
  state.layerCounts = layers;
  $('type-filter').innerHTML =
    '<option value="">Todos os tipos</option>' +
    [...types].sort((a, b) => b[1] - a[1]).map(([t, n]) => `<option value="${esc(t)}">${esc(typeName(t))} (${n})</option>`).join('');
  $('layer-filter').innerHTML =
    '<option value="">Todas as camadas</option>' +
    [...layers].sort((a, b) => a[0].localeCompare(b[0])).map(([l, n]) => `<option value="${esc(l)}">${esc(l)} (${n})</option>`).join('');
}

// ------------------------------------------------------------ camadas
function buildLayerList() {
  const layers = state.scene.layers.filter((l) => state.layerCounts.has(l.name) || l.hidden);
  $('layer-badge').textContent = layers.length;
  $('layer-list').innerHTML = layers
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (l) => `<li><label>
        <input type="checkbox" data-layer="${esc(l.name)}" ${l.hidden ? 'disabled' : state.hiddenLayers.has(l.name) ? '' : 'checked'} />
        <span class="swatch" style="background:${l.color}"></span>
        <span class="name" title="${esc(l.name)}">${esc(l.name)}</span>
        ${l.hidden ? '<span class="off">(desligada no arquivo)</span>' : ''}
        <span class="cnt">${state.layerCounts.get(l.name) ?? 0}</span>
      </label></li>`,
    )
    .join('');
}

$('layer-list').addEventListener('change', (e) => {
  const name = e.target.dataset.layer;
  if (name == null) return;
  if (e.target.checked) state.hiddenLayers.delete(name);
  else state.hiddenLayers.add(name);
  applyLayerVisibility();
});
function setAllLayers(visible) {
  for (const cb of $('layer-list').querySelectorAll('input[data-layer]:not(:disabled)')) {
    cb.checked = visible;
    if (visible) state.hiddenLayers.delete(cb.dataset.layer);
    else state.hiddenLayers.add(cb.dataset.layer);
  }
  applyLayerVisibility();
}
$('layers-all').onclick = () => setAllLayers(true);
$('layers-none').onclick = () => setAllLayers(false);
function applyLayerVisibility() {
  viewer.setHiddenLayers(new Set(state.hiddenLayers));
  renderTable();
}

// ------------------------------------------------------------ tabela
const sortValue = {
  type: (it) => typeName(it.type),
  layer: (it) => it.layer,
  width: (it) => it.m.width,
  height: (it) => it.m.height,
  length: (it) => it.m.length ?? -1,
  area: (it) => it.m.area ?? -1,
};

function filteredItems() {
  const q = $('search').value.trim().toLowerCase();
  const type = $('type-filter').value;
  const layer = $('layer-filter').value;
  const onlyVisible = $('only-visible').checked;
  const vb = viewer.visibleBox();
  return state.scene.items.filter((it) => {
    if (!viewer.isItemVisible(it)) return false;
    if (type && it.type !== type) return false;
    if (layer && it.layer !== layer) return false;
    if (onlyVisible) {
      const b = it.bbox;
      if (b[2] < vb[0] || b[0] > vb[2] || b[3] < vb[1] || b[1] > vb[3]) return false;
    }
    if (q) {
      const hay = `${it.type} ${typeName(it.type)} ${it.layer} ${it.label} ${it.texts.map((t) => t.str).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTable() {
  if (!state.scene) return;
  let rows = filteredItems();
  if (state.sortKey) {
    const f = sortValue[state.sortKey];
    const dir = state.sortDesc ? -1 : 1;
    rows.sort((a, b) => {
      const x = f(a);
      const y = f(b);
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
    });
  }
  state.rows = rows;
  $('count-badge').textContent = rows.length.toLocaleString('pt-BR');
  const sel = viewer.selected;
  const shown = rows.slice(0, MAX_ROWS);
  const layerColor = new Map(state.scene.layers.map((l) => [l.name, l.color]));
  $('grid-body').innerHTML = shown
    .map((it) => {
      const color = it.strokes[0]?.color ?? it.fills[0]?.color ?? it.texts[0]?.color ?? layerColor.get(it.layer) ?? '#fff';
      const name = typeName(it.type) + (it.label ? ` <span style="color:var(--muted)">${esc(it.label)}</span>` : '');
      return `<tr data-id="${it.id}"${it === sel ? ' class="sel"' : ''}>
        <td class="type" title="${esc(typeName(it.type) + (it.label ? ' ' + it.label : ''))}"><span class="swatch" style="background:${color}"></span>${name}</td>
        <td class="layer" title="${esc(it.layer)}">${esc(it.layer)}</td>
        <td class="num">${fmtT(it.m.width)}</td>
        <td class="num">${fmtT(it.m.height)}</td>
        <td class="num">${fmtT(it.m.length)}</td>
        <td class="num">${fmtT(it.m.area)}</td>
      </tr>`;
    })
    .join('');
  const u = state.scene.units ? `Medidas em ${state.scene.units} (área em ${state.scene.units}²). ` : 'Medidas em unidades do desenho. ';
  $('table-note').textContent =
    (rows.length > MAX_ROWS ? `Mostrando ${MAX_ROWS.toLocaleString('pt-BR')} de ${rows.length.toLocaleString('pt-BR')} objetos — aproxime o zoom ou use os filtros. ` : '') +
    (rows.length === 0 ? 'Nenhum objeto encontrado. ' : '') +
    u +
    'Largura = extensão em X, Altura = extensão em Y.';
}

$('grid').querySelector('thead').addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const key = th.dataset.key;
  if (state.sortKey === key) state.sortDesc = !state.sortDesc;
  else {
    state.sortKey = key;
    state.sortDesc = ['width', 'height', 'length', 'area'].includes(key);
  }
  for (const h of $('grid').querySelectorAll('th')) {
    h.classList.toggle('sorted', h.dataset.key === state.sortKey);
    h.classList.toggle('desc', h.dataset.key === state.sortKey && state.sortDesc);
  }
  renderTable();
});

$('grid-body').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (tr) viewer.select(state.scene.items[+tr.dataset.id], { zoom: e.detail > 1 });
});
$('grid-body').addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr');
  if (tr) viewer.select(state.scene.items[+tr.dataset.id], { zoom: true });
});

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderTable, 150);
});
$('type-filter').addEventListener('change', renderTable);
$('layer-filter').addEventListener('change', renderTable);
$('only-visible').addEventListener('change', renderTable);
viewer.addEventListener('viewchange', () => {
  if ($('only-visible').checked) renderTable();
  $('zoom-level').textContent = state.scene ? `Escala: ${nf2.format(viewer.view.s)} px/unid.` : '';
});

// ------------------------------------------------------------ CSV
$('btn-csv').addEventListener('click', () => {
  if (!state.scene) return;
  const n = (v) => (v == null || !isFinite(v) ? '' : String(+v.toFixed(6)).replace('.', ','));
  const header = ['Handle', 'Tipo', 'Bloco', 'Camada', 'Largura (X)', 'Altura (Y)', 'Comprimento orientado', 'Espessura orientada', 'Comprimento total', 'Área', 'Xmin', 'Ymin', 'Xmax', 'Ymax'];
  const lines = [header.join(';')];
  for (const it of state.rows) {
    lines.push(
      [it.handle, typeName(it.type), it.label, it.layer, n(it.m.width), n(it.m.height), n(it.m.rectLong), n(it.m.rectShort), n(it.m.length), n(it.m.area), ...it.bbox.map(n)]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(';'),
    );
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.fileName.replace(/\.dwg$/i, '') + '-dimensoes.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ------------------------------------------------------------ detalhes
function showDetails(it) {
  const box = $('details');
  if (!it) {
    box.innerHTML = '<div class="details-empty">Clique em um objeto no desenho ou na tabela para ver suas dimensões (largura, altura, comprimento, área).</div>';
    return;
  }
  const u = unitSuffix();
  const u2 = unitSuffix('area');
  const m = it.m;
  const color = it.strokes[0]?.color ?? it.fills[0]?.color ?? it.texts[0]?.color ?? '#fff';
  const dim = (k, v, suffix, hl) => `<div class="dim${hl ? ' hl' : ''}"><div class="k">${k}</div><div class="v">${fmt(v)}${v != null && isFinite(v) ? suffix : ''}</div></div>`;
  const cards = [dim('Largura (X)', m.width, u, true), dim('Altura (Y)', m.height, u, true)];
  // retângulo orientado: dá o comprimento e a espessura reais de objetos girados (ex.: paredes inclinadas)
  const rotated = m.rectAngle != null && Math.abs(Math.sin(2 * m.rectAngle)) > 1e-3;
  if (m.rectLong != null && rotated) {
    cards.push(dim('Compr. orientado', m.rectLong, u), dim('Espessura orientada', m.rectShort, u));
  }
  if (m.length != null) cards.push(dim('Comprimento total', m.length, u));
  if (m.area != null) cards.push(dim('Área', m.area, u2));

  const val = ([, kind, v]) => {
    if (kind === 'len') return fmt(v) + u;
    if (kind === 'deg') return nf2.format(v) + '°';
    if (kind === 'pt') return v ? `(${fmt(v.x)}; ${fmt(v.y)}${v.z ? '; ' + fmt(v.z) : ''})` : '—';
    if (kind === 'num') return fmt(v);
    return esc(v ?? '—');
  };
  const props = [
    ['Camada', 'text', it.layer],
    ['Handle', 'text', it.handle],
    ...it.props,
    ...(rotated ? [['Ângulo do eixo principal', 'deg', (m.rectAngle * 180) / Math.PI]] : []),
    ['Canto mín.', 'pt', { x: it.bbox[0], y: it.bbox[1] }],
    ['Canto máx.', 'pt', { x: it.bbox[2], y: it.bbox[3] }],
  ];
  box.innerHTML = `
    <h2><span class="swatch" style="background:${color}"></span>${esc(typeName(it.type))}${it.label ? ` <span style="color:var(--muted);font-weight:400">${esc(it.label)}</span>` : ''}</h2>
    <div class="sub">${esc(it.type)}${state.scene.units ? '' : ' · medidas em unidades do desenho'}</div>
    <div class="dims">${cards.join('')}</div>
    <table class="props">${props.map((p) => `<tr><td>${esc(p[0])}</td><td>${val(p)}</td></tr>`).join('')}</table>
    <div class="actions">
      <button class="btn small" id="btn-zoom-sel">Aproximar do objeto</button>
      <button class="btn small" id="btn-clear-sel">Limpar seleção</button>
    </div>`;
  $('btn-zoom-sel').onclick = () => viewer.select(it, { zoom: true });
  $('btn-clear-sel').onclick = () => viewer.select(null);
}

viewer.addEventListener('select', (e) => {
  const it = e.detail;
  showDetails(it);
  for (const tr of $('grid-body').querySelectorAll('tr.sel')) tr.classList.remove('sel');
  if (it) {
    const tr = $('grid-body').querySelector(`tr[data-id="${it.id}"]`);
    if (tr) {
      tr.classList.add('sel');
      tr.scrollIntoView({ block: 'nearest' });
    }
  }
  if (it && window.matchMedia('(max-width: 900px)').matches) $('sidebar').classList.remove('collapsed');
});

// ------------------------------------------------------------ tooltip e coordenadas
viewer.addEventListener('hover', (e) => {
  const { item, x, y } = e.detail;
  const tip = $('tooltip');
  if (!item) {
    tip.hidden = true;
    return;
  }
  const u = unitSuffix();
  tip.innerHTML = `<b>${esc(typeName(item.type))}</b>${item.label ? ' ' + esc(item.label) : ''} · ${esc(item.layer)}<br>` +
    `L ${fmt(item.m.width)}${u} × A ${fmt(item.m.height)}${u}`;
  tip.hidden = false;
  const stage = $('stage');
  const tx = Math.min(x + 14, stage.clientWidth - tip.offsetWidth - 6);
  const ty = y + 18 + tip.offsetHeight > stage.clientHeight - 30 ? y - tip.offsetHeight - 10 : y + 18;
  tip.style.left = tx + 'px';
  tip.style.top = ty + 'px';
});
viewer.addEventListener('cursor', (e) => {
  if (!state.scene) return;
  $('coords').textContent = `X: ${fmt(e.detail.x)}  Y: ${fmt(e.detail.y)}`;
});

// ------------------------------------------------------------ barra de ferramentas
$('btn-zoom-in').onclick = () => viewer.zoom(1.5);
$('btn-zoom-out').onclick = () => viewer.zoom(1 / 1.5);
$('btn-fit').onclick = () => viewer.fit();
$('btn-sidebar').onclick = () => $('sidebar').classList.toggle('collapsed');
$('space-select').addEventListener('change', (e) => {
  showLoading('Carregando espaço do desenho…');
  worker.postMessage({ cmd: 'space', space: e.target.value });
});
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    $('panel-objects').hidden = tab.dataset.tab !== 'objects';
    $('panel-layers').hidden = tab.dataset.tab !== 'layers';
  });
}
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === '+' || e.key === '=') viewer.zoom(1.5);
  else if (e.key === '-') viewer.zoom(1 / 1.5);
  else if (e.key === 'f' || e.key === 'F') viewer.fit();
  else if (e.key === 'Escape') viewer.select(null);
});
