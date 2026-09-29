// Paleta AutoCAD Color Index (ACI) 0-255.
// 1-9 são fixas; 10-249 seguem o padrão HSV do AutoCAD (24 matizes x 10 tons);
// 250-255 são tons de cinza.

const FIXED = {
  1: [255, 0, 0],
  2: [255, 255, 0],
  3: [0, 255, 0],
  4: [0, 255, 255],
  5: [0, 0, 255],
  6: [255, 0, 255],
  7: [255, 255, 255], // branco/preto (depende do fundo)
  8: [128, 128, 128],
  9: [192, 192, 192],
  250: [51, 51, 51],
  251: [80, 80, 80],
  252: [105, 105, 105],
  253: [130, 130, 130],
  254: [190, 190, 190],
  255: [255, 255, 255],
};

const VALUES = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3];

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

const ACI = new Array(256);
for (let i = 1; i < 256; i++) {
  if (FIXED[i]) {
    ACI[i] = FIXED[i];
  } else if (i >= 10 && i <= 249) {
    const hue = Math.floor((i - 10) / 10) * 15;
    const tone = (i - 10) % 10;
    const sat = tone % 2 === 0 ? 1 : 0.5;
    ACI[i] = hsvToRgb(hue, sat, VALUES[tone]);
  }
}
ACI[0] = [255, 255, 255];

const toHex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
const ACI_HEX = ACI.map((c) => (c ? toHex(c) : '#ffffff'));

export function aciToHex(index) {
  return ACI_HEX[Math.abs(index)] || '#ffffff';
}

export function rgbIntToHex(rgb) {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
}
