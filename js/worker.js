// Web Worker: lê o DWG com LibreDWG (WebAssembly) e monta a cena fora da thread
// principal, mantendo a interface responsiva mesmo em arquivos grandes.

import { LIBREDWG_URL, LIBREDWG_WASM_DIR } from './config.js';
import { buildScene } from './geometry.js';

let libPromise = null;
let db = null;

function getLib() {
  if (!libPromise) {
    libPromise = import(LIBREDWG_URL).then(async (mod) => ({
      lib: await mod.LibreDwg.create(LIBREDWG_WASM_DIR),
      FileType: mod.Dwg_File_Type,
    }));
    libPromise.catch(() => (libPromise = null));
  }
  return libPromise;
}

const progress = (text) => self.postMessage({ cmd: 'progress', text });

function sendScene(space) {
  const t0 = performance.now();
  const scene = buildScene(db, space);
  scene.space = space;
  scene.buildMs = performance.now() - t0;
  const transfer = [];
  for (const it of scene.items) {
    for (const s of it.strokes) transfer.push(s.pts.buffer);
    for (const f of it.fills) for (const r of f.rings) transfer.push(r.buffer);
    for (const t of it.texts) transfer.push(t.corners.buffer);
  }
  self.postMessage({ cmd: 'scene', scene }, transfer);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.cmd === 'init') {
      await getLib();
      self.postMessage({ cmd: 'ready' });
    } else if (msg.cmd === 'open') {
      progress('Carregando biblioteca LibreDWG…');
      const { lib, FileType } = await getLib();
      progress('Lendo arquivo DWG…');
      const dwg = lib.dwg_read_data(msg.buffer, FileType.DWG);
      if (!dwg) throw new Error('Não foi possível ler o arquivo. Verifique se é um DWG válido.');
      progress('Convertendo entidades…');
      db = lib.convert(dwg);
      lib.dwg_free(dwg);
      progress('Calculando geometria e dimensões…');
      const hasModel = (db.tables?.BLOCK_RECORD?.entries ?? []).some((b) => /^\*model_space$/i.test(b.name) && b.entities?.length);
      sendScene(hasModel ? 'model' : 'paper');
    } else if (msg.cmd === 'space') {
      if (db) sendScene(msg.space);
    }
  } catch (err) {
    console.error(err);
    self.postMessage({ cmd: 'error', message: err?.message || String(err) });
  }
};
