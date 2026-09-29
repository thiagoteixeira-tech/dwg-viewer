// Biblioteca de leitura de DWG: LibreDWG compilada para WebAssembly
// (https://github.com/mlightcad/libredwg-web), servida pelo CDN jsDelivr.
// Para hospedar localmente, copie a pasta do pacote para /vendor e aponte os
// caminhos abaixo para ela (ex.: '/vendor/libredwg-web/dist/libredwg-web.js').
export const LIBREDWG_VERSION = '0.7.14';
const BASE = `https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@${LIBREDWG_VERSION}`;

export const LIBREDWG_URL = `${BASE}/dist/libredwg-web.js`;
export const LIBREDWG_WASM_DIR = `${BASE}/wasm`;
