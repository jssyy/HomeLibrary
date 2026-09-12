/**
 * 生成 PWA 图标（不依赖任何图形库，直接画像素再编码成 PNG）。
 *   node scripts/gen-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const BG = [180, 85, 45];      // 书脊红棕
const BG2 = [150, 66, 34];
const PAPER = [250, 246, 239];
const INK = [90, 62, 45];

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', zlib.deflateSync(raw, { level: 9 })));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return crc ^ -1;
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = (v) => Math.round((v / 512) * size); // 按 512 的设计稿等比缩放
  const radius = S(112);

  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // 简单的 alpha 混合
    const na = a / 255;
    px[i] = Math.round(px[i] * (1 - na) + r * na);
    px[i + 1] = Math.round(px[i + 1] * (1 - na) + g * na);
    px[i + 2] = Math.round(px[i + 2] * (1 - na) + b * na);
    px[i + 3] = Math.max(px[i + 3], a);
  };

  const inRounded = (x, y) => {
    const r = radius;
    const cx = Math.min(Math.max(x, r), size - 1 - r);
    const cy = Math.min(Math.max(y, r), size - 1 - r);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };

  // 背景：左上到右下的渐变
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x, y)) continue;
      const t = (x + y) / (2 * size);
      set(x, y, [
        Math.round(BG[0] + (BG2[0] - BG[0]) * t),
        Math.round(BG[1] + (BG2[1] - BG[1]) * t),
        Math.round(BG[2] + (BG2[2] - BG[2]) * t),
      ]);
    }
  }

  // 摊开的书：两页 + 中缝
  const top = S(150);
  const bottom = S(372);
  const left = S(96);
  const right = size - left;
  const mid = size / 2;
  const gap = S(9);

  for (let y = top; y < bottom; y++) {
    // 书页上缘做一点弧度，看起来像翻开的书
    const curve = Math.round(S(22) * Math.sin(((y - top) / (bottom - top)) * Math.PI * 0.5));
    for (let x = left; x < right; x++) {
      if (x > mid - gap && x < mid + gap) continue; // 中缝
      const edgeTop = top + (x < mid ? S(14) - curve / 2 : S(14) - curve / 2);
      if (y < edgeTop) continue;
      set(x, y, PAPER);
    }
  }

  // 文字行
  for (let line = 0; line < 5; line++) {
    const y0 = top + S(56) + line * S(46);
    for (let y = y0; y < y0 + S(12); y++) {
      for (let x = left + S(34); x < mid - gap - S(24); x++) set(x, y, INK, 70);
      for (let x = mid + gap + S(24); x < right - S(34); x++) set(x, y, INK, 70);
    }
  }

  // 书签带
  for (let y = top; y < bottom + S(34); y++) {
    for (let x = mid + S(74); x < mid + S(104); x++) {
      if (y > bottom + S(6)) {
        // 下端的燕尾
        const d = y - (bottom + S(6));
        const half = (x - (mid + S(74))) / S(30);
        if (Math.abs(half - 0.5) * S(30) < d - S(4)) continue;
      }
      set(x, y, [200, 90, 60]);
    }
  }

  return px;
}

for (const size of [180, 192, 512]) {
  const png = encodePng(size, size, draw(size));
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), png);
  console.log(`[icons] icon-${size}.png (${(png.length / 1024).toFixed(1)} KB)`);
}

// SVG 版本（浏览器标签页用，矢量更清晰）
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#b4552d"/><stop offset="1" stop-color="#964222"/>
  </linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <path d="M96 164h150c10 0 18 8 18 18v190H114c-10 0-18-8-18-18V164z" fill="#faf6ef"/>
  <path d="M416 164H266c-10 0-18 8-18 18v190h148c10 0 18-8 18-18V164z" fill="#faf6ef"/>
  <g fill="#5a3e2d" opacity=".42">
    <rect x="130" y="206" width="98" height="11" rx="5"/><rect x="130" y="248" width="98" height="11" rx="5"/>
    <rect x="130" y="290" width="72" height="11" rx="5"/>
    <rect x="284" y="206" width="98" height="11" rx="5"/><rect x="284" y="248" width="98" height="11" rx="5"/>
    <rect x="284" y="290" width="72" height="11" rx="5"/>
  </g>
  <path d="M330 164h30v130l-15-18-15 18z" fill="#c85a3c"/>
</svg>
`;
fs.writeFileSync(path.join(OUT, 'icon.svg'), svg);
console.log('[icons] icon.svg');
