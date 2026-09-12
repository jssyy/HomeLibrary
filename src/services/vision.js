/**
 * 用视觉大模型读版权页。
 *
 * 走各家的 OpenAI 兼容接口（/chat/completions + image_url），
 * 所以换厂商只要改 base_url / model / key 三个值，代码不用动。
 * 国内这几家都能直连、都有免费额度，其中智谱 GLM-4V-Flash 是完全免费的。
 *
 * 比本地 Tesseract 强在哪：中文印刷体几乎不会错，而且能理解语义——
 * 版权页上「书名」是整套的名字、「分册名」才是这一本，模型直接就分得清。
 */
const settings = require('../settings');
const http = require('./http');
const isbnUtil = require('./isbn');

/** 常用厂商预设，设置页一键填入 */
const PRESETS = [
  {
    id: 'zhipu',
    name: '智谱 GLM-4V-Flash（免费）',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-flash',
    apply_url: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: '完全免费，中文版权页够用，推荐先试它',
  },
  {
    id: 'qwen',
    name: '通义千问 VL',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max-latest',
    apply_url: 'https://bailian.console.aliyun.com/',
    note: '阿里百炼，新用户有免费额度，识别最稳',
  },
  {
    id: 'doubao',
    name: '豆包 Vision',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    apply_url: 'https://console.volcengine.com/ark',
    note: '火山方舟，model 要填你自己创建的推理接入点 ID（ep-xxx）',
  },
  {
    id: 'custom',
    name: '自定义（任何 OpenAI 兼容接口）',
    base_url: '',
    model: '',
    apply_url: '',
    note: '填 /chat/completions 之前的那段地址',
  },
];

const PROMPT = `你是图书管理助手。这张图是一本中文图书的版权页（或 CIP 数据页、封底）。
请提取书目信息，只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块。

字段（没有的就不要出现在 JSON 里，不要编造）：
{
  "title": "书名",
  "subtitle": "副标题",
  "series": "丛书名/套装名",
  "volume": "分册名或第几册",
  "author": "作者或主编",
  "translator": "译者",
  "publisher": "出版社",
  "pub_date": "出版时间，格式 YYYY-MM 或 YYYY",
  "isbn13": "ISBN，只要数字，去掉短横线",
  "list_price": 定价数字,
  "pages": 页数数字,
  "price_is_set": true/false,
  "notes": "需要人工留意的地方，比如定价是整套价"
}

注意：
1. 套装书的版权页上，「书名」往往是整套的名字、「分册名」才是这一本书。
   遇到这种情况：title 填分册名，series 填书名，volume 也填分册名。
2. 定价写着「全三册」「全套」之类时，price_is_set 设为 true，并在 notes 里说明。
3. ISBN 务必逐位看清，这是最重要的字段。
4. 图片模糊看不清的字段直接省略，不要猜。`;

function config() {
  return {
    enabled: settings.bool('vision_enabled'),
    baseUrl: String(settings.get('vision_base_url') || '').replace(/\/+$/, ''),
    apiKey: settings.get('vision_api_key') || '',
    model: settings.get('vision_model') || '',
  };
}

function isConfigured() {
  const c = config();
  return !!(c.enabled && c.baseUrl && c.apiKey && c.model);
}

/** 模型偶尔会把 JSON 包在代码块里或前后带一句话，这里兜一下 */
function extractJson(text) {
  const s = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidate = fenced ? fenced[1] : s;
  try {
    return JSON.parse(candidate);
  } catch { /* 继续找 */ }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch { /* 实在解析不了 */ }
  }
  return null;
}

/** 压一下图：太大的传得慢，有的厂商还有 base64 体积限制 */
async function shrink(buffer) {
  try {
    const Jimp = require('jimp');
    const img = await Jimp.read(buffer);
    const longSide = Math.max(img.bitmap.width, img.bitmap.height);
    if (longSide > 1600) img.scale(1600 / longSide);
    img.quality(85);
    return { buffer: await img.getBufferAsync(Jimp.MIME_JPEG), mime: 'image/jpeg' };
  } catch {
    return { buffer, mime: 'image/jpeg' };
  }
}

/**
 * 把版权页图片交给视觉模型，返回可直接填表的字段。
 * @param {Buffer} imageBuffer
 */
async function readBookPhoto(imageBuffer) {
  const c = config();
  if (!c.baseUrl || !c.apiKey || !c.model) {
    const err = new Error('还没配置视觉模型，去「设置 › 拍照识别」填一下');
    err.code = 'VISION_NOT_CONFIGURED';
    throw err;
  }

  const { buffer, mime } = await shrink(imageBuffer);
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

  const body = {
    model: c.model,
    temperature: 0.1,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  const t0 = Date.now();
  const res = await http.request(`${c.baseUrl}/chat/completions`, {
    method: 'POST',
    timeout: 60000,
    headers: {
      Authorization: `Bearer ${c.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    raw: true,
  });
  const data = await res.json();

  const content =
    data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
  const raw = Array.isArray(content)
    ? content.map((x) => (typeof x === 'string' ? x : x.text || '')).join('')
    : content;

  const parsed = extractJson(raw);
  if (!parsed) {
    const err = new Error('模型没有返回可解析的 JSON');
    err.code = 'VISION_BAD_JSON';
    err.raw = raw;
    throw err;
  }

  return { ...normalize(parsed), text: raw, ms: Date.now() - t0, engine: `${c.model}` };
}

/** 模型返回的字段整理成书库的字段格式 */
function normalize(v) {
  const fields = {};
  const notes = [];
  const str = (x) => {
    const s = String(x ?? '').trim();
    return s && s !== 'null' && s !== '无' ? s : null;
  };

  for (const key of ['title', 'subtitle', 'series', 'volume', 'author', 'translator', 'publisher']) {
    const val = str(v[key]);
    if (val) fields[key] = val;
  }

  const date = str(v.pub_date);
  if (date) {
    const m = /(\d{4})(?:[-/年](\d{1,2}))?/.exec(date);
    if (m) fields.pub_date = m[2] ? `${m[1]}-${String(m[2]).padStart(2, '0')}` : m[1];
  }

  const isbn = String(v.isbn13 || v.isbn || '').replace(/[^\dXx]/g, '');
  if (isbn.length >= 10) {
    const v13 = isbnUtil.to13(isbn);
    if (v13) {
      fields.isbn13 = v13;
    } else {
      fields.isbn13 = isbn.slice(0, 13);
      notes.push('ISBN 校验位对不上，请核对一下');
    }
  }

  if (v.list_price !== undefined && v.list_price !== null && v.list_price !== '') {
    const n = Number(String(v.list_price).replace(/[^\d.]/g, ''));
    if (Number.isFinite(n) && n > 0) fields.list_price = n;
  }
  if (v.pages) {
    const n = Number(String(v.pages).replace(/[^\d]/g, ''));
    if (Number.isFinite(n) && n > 0) fields.pages = n;
  }

  if (v.price_is_set) {
    notes.push(`定价 ${fields.list_price ?? ''} 元是整套价格，单册价请自行折算`);
  }
  if (str(v.notes)) notes.push(str(v.notes));
  if (fields.volume && fields.series) {
    notes.push('识别为套装分册：已把分册名当书名、整套名当丛书名');
  }

  return { fields, notes };
}

/** 设置页的「测试连接」：不发图，只确认 key 和地址能通 */
async function test() {
  const c = config();
  if (!c.baseUrl || !c.apiKey || !c.model) {
    return { ok: false, message: '还没填完 base_url / api_key / model' };
  }
  try {
    const res = await http.request(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      timeout: 30000,
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: c.model,
        max_tokens: 8,
        messages: [{ role: 'user', content: '回复两个字：收到' }],
      }),
      raw: true,
    });
    const data = await res.json();
    const reply =
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return { ok: true, message: `连接正常，模型回复：${String(reply).slice(0, 20)}` };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
}

module.exports = { readBookPhoto, isConfigured, test, PRESETS, config };
