/** 拍版权页识别：图片 → 书目字段 */
const express = require('express');
const multer = require('multer');
const settings = require('../settings');
const ocr = require('../services/ocr');
const vision = require('../services/vision');
const metadata = require('../services/metadata');
const { wrap } = require('../util');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('只能传图片'));
    cb(null, true);
  },
});

/**
 * POST /api/ocr/book —— 上传版权页照片，返回可直接填表的字段
 *
 * 引擎选择（设置里的 ocr_engine）：
 *   auto   配了视觉模型就用它，没配就用本地 Tesseract
 *   vision 只用视觉模型
 *   local  只用本地
 *
 * 不管哪个引擎，只要认出了 ISBN，都会再去豆瓣等来源查一遍权威书目——
 * 识别负责认字，书目数据还是以书目库为准。
 */
router.post(
  '/ocr/book',
  upload.single('image'),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '没收到图片' });

    const mode = settings.get('ocr_engine') || 'auto';
    const useVision = mode === 'vision' || (mode === 'auto' && vision.isConfigured());

    let result = null;
    let engine = null;
    const warnings = [];

    if (useVision) {
      try {
        const out = await vision.readBookPhoto(req.file.buffer);
        result = { fields: out.fields, notes: out.notes, text: out.text, ms: out.ms };
        engine = `vision:${out.engine}`;
      } catch (e) {
        if (mode === 'vision') {
          return res.status(502).json({ error: `视觉模型识别失败：${e.message}`, code: e.code });
        }
        warnings.push(`视觉模型没成功（${e.message}），已回落到本地识别`);
      }
    }

    if (!result) {
      try {
        const out = await ocr.readBookPhoto(req.file.buffer);
        result = { fields: out.fields, notes: out.notes, text: out.text, ms: out.ms, confidence: out.confidence };
        engine = 'local:tesseract';
      } catch (e) {
        return res.status(e.code === 'OCR_NO_MODEL' ? 503 : 500).json({
          error: e.message,
          code: e.code,
          hint: e.code === 'OCR_NO_MODEL' ? '命令行执行 npm run ocr:setup 下载模型' : undefined,
        });
      }
    }

    // 认出 ISBN 就再查一遍权威书目：识别只负责认字，书目以豆瓣等来源为准
    let lookup = null;
    if (result.fields.isbn13) {
      try {
        const out = await metadata.lookup(result.fields.isbn13);
        if (out.results.length) {
          const best = metadata.merge(out.results.slice(0, 3));
          lookup = { source: best.source, fields: best };

          // 本地 Tesseract 认中文不可靠（作者、出版社经常串行），
          // 所以本地引擎下书目库说了算，只有版权页独有的字段才保留识别结果；
          // 视觉模型认得准，反过来以识别结果为准、书目库补空缺。
          const localOnly = ['volume', 'series', 'list_price'];
          for (const [k, v] of Object.entries(best)) {
            if (v === null || v === undefined || v === '') continue;
            if (localOnly.includes(k)) continue;
            const visionWins = engine.startsWith('vision:') && result.fields[k];
            if (!visionWins) result.fields[k] = v;
          }
          if (engine.startsWith('local:')) {
            warnings.push('中文字段以书目库为准（本地识别中文容易出错），分册名和定价来自版权页，请核对');
          }
        }
      } catch (e) {
        warnings.push(`按 ISBN 查书目失败：${e.message}`);
      }
    }

    res.json({ engine, warnings, lookup: lookup && lookup.source, ...result });
  })
);

/** 识别能力状态，设置页和前端按钮用 */
router.get(
  '/ocr/status',
  wrap((req, res) => {
    res.json({
      engine: settings.get('ocr_engine') || 'auto',
      local_ready: ocr.modelsReady(),
      vision_configured: vision.isConfigured(),
      presets: vision.PRESETS,
    });
  })
);

/** 设置页测试视觉模型连通性 */
router.get(
  '/ocr/test-vision',
  wrap(async (req, res) => res.json(await vision.test()))
);

module.exports = router;
