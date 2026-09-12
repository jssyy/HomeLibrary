/**
 * 下载 OCR 语言模型（拍版权页自动识别要用）。
 *   node scripts/setup-ocr.js
 *
 * 用的是 tessdata_fast 版本：中文 2.4MB、英文 1.5MB，识别速度比 best 版快几倍，
 * 对版权页这种印刷体足够了。模型存在 data/ocr/，只需要下一次。
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const http = require('../src/services/http');

const OCR_DIR = path.join(config.DATA_DIR, 'ocr');

// 按顺序尝试，哪个通用哪个
const MIRRORS = [
  (lang) => `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${lang}.traineddata`,
  (lang) => `https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/${lang}.traineddata`,
  (lang) => `https://gitee.com/mirrors_tesseract-ocr/tessdata_fast/raw/main/${lang}.traineddata`,
];

const LANGS = ['chi_sim', 'eng'];

async function download(lang) {
  const dest = path.join(OCR_DIR, `${lang}.traineddata`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100 * 1024) {
    console.log(`[ocr] ${lang} 已存在，跳过`);
    return true;
  }
  for (const mirror of MIRRORS) {
    const url = mirror(lang);
    try {
      process.stdout.write(`[ocr] 下载 ${lang} … `);
      const { buffer } = await http.getBuffer(url, { timeout: 120000 });
      if (buffer.length < 100 * 1024) throw new Error(`文件太小（${buffer.length} 字节）`);
      fs.mkdirSync(OCR_DIR, { recursive: true });
      fs.writeFileSync(dest, buffer);
      console.log(`OK (${(buffer.length / 1048576).toFixed(1)} MB)`);
      return true;
    } catch (e) {
      console.log(`失败：${e.message}`);
    }
  }
  return false;
}

async function main() {
  fs.mkdirSync(OCR_DIR, { recursive: true });
  let ok = true;
  for (const lang of LANGS) ok = (await download(lang)) && ok;
  if (ok) {
    console.log(`\n[ocr] 模型就绪：${OCR_DIR}`);
  } else {
    console.log('\n[ocr] 有模型没下成功。可以在「设置」里打开代理后重试，或手动把');
    console.log('      chi_sim.traineddata / eng.traineddata（tessdata_fast 版本）放进');
    console.log(`      ${OCR_DIR}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { download, OCR_DIR, LANGS };
