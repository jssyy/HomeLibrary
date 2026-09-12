/**
 * 把前端依赖从 node_modules 复制到 public/vendor，
 * 这样运行时不依赖任何 CDN（家里断网也能用）。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');

const files = [
  ['epubjs/dist/epub.min.js', 'epub.min.js'],
  ['jszip/dist/jszip.min.js', 'jszip.min.js'],
  ['pdfjs-dist/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['@zxing/library/umd/index.min.js', 'zxing.min.js'],
];

fs.mkdirSync(out, { recursive: true });

let copied = 0;
for (const [src, dest] of files) {
  const from = path.join(root, 'node_modules', src);
  if (!fs.existsSync(from)) {
    console.warn(`[vendor] 跳过（未找到）: ${src}`);
    continue;
  }
  fs.copyFileSync(from, path.join(out, dest));
  copied++;
}
console.log(`[vendor] 已复制 ${copied} 个前端依赖到 public/vendor`);
