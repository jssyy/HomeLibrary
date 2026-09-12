/**
 * 拍版权页识别：选图/拍照 → 传给后端识别 → 返回可填表的字段。
 * 录入页和扫码页共用这一份。
 */
import { h, toast, modal } from './ui.js';
import api from './api.js';

const FIELD_LABELS = {
  isbn13: 'ISBN', title: '书名', subtitle: '副标题', series: '丛书/套装',
  volume: '分册', author: '作者', translator: '译者', publisher: '出版社',
  pub_date: '出版时间', list_price: '定价', pages: '页数', summary: '简介',
  cover_url: '封面', category: '分类',
};

/**
 * 让用户选一张版权页照片并识别。
 * @returns {Promise<object|null>} 识别结果，取消或失败返回 null
 */
export function pickAndRecognize({ camera = true } = {}) {
  return new Promise((resolve) => {
    const input = h('input', {
      type: 'file',
      accept: 'image/*',
      capture: camera ? 'environment' : undefined,
    });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      resolve(await recognize(file));
    });
    input.click();
  });
}

/** 直接识别一个 File/Blob */
export async function recognize(file) {
  const fd = new FormData();
  fd.append('image', file);
  toast('正在识别版权页…');
  try {
    const out = await api.ocrBook(fd);
    const count = Object.keys(out.fields || {}).length;
    if (!count) {
      toast('没认出什么信息，换个角度、光线好一点再拍一张', 'err');
      return null;
    }
    toast(`识别出 ${count} 个字段（${engineLabel(out.engine)}）`, 'ok');
    return out;
  } catch (e) {
    if (e.status === 503) {
      toast('本地识别模型还没装：命令行执行 npm run ocr:setup', 'err');
    } else {
      toast(`识别失败：${e.message}`, 'err');
    }
    return null;
  }
}

export function engineLabel(engine) {
  if (!engine) return '';
  if (engine.startsWith('vision:')) return `AI 模型 ${engine.slice(7)}`;
  return '本地识别';
}

/**
 * 把识别结果展示出来让人确认，确认后返回要采用的字段。
 * @returns {Promise<object|null>}
 */
export async function confirmFields(out, current = {}) {
  const all = Object.entries(out.fields || {});
  // 只把人需要核对的字段列出来；isbn10 / source / language 这些内部字段
  // 照常采用，但不占版面
  const visible = all.filter(([k]) => FIELD_LABELS[k]);
  const hidden = Object.fromEntries(all.filter(([k]) => !FIELD_LABELS[k]));

  const checks = new Map();
  const rows = visible.map(([k, v]) => {
    const old = current[k];
    const conflict = old && String(old) !== String(v);
    const cb = h('input', { type: 'checkbox', checked: true });
    checks.set(k, cb);
    return h('label', {
      class: 'row',
      style: { padding: '6px 0', borderBottom: '1px solid var(--line-soft)', gap: '8px', cursor: 'pointer' },
    },
      cb,
      h('span', { class: 'tiny faint', style: { width: '62px', flex: 'none' } }, FIELD_LABELS[k] || k),
      h('span', { class: 'small', style: { flex: '1', wordBreak: 'break-all' } }, String(v)),
      conflict ? h('span', { class: 'src-tag', title: `原来是：${old}` }, '会覆盖') : null
    );
  });

  const ok = await modal({
    title: '识别结果',
    body: h('div', {},
      h('div', { class: 'tiny faint', style: { marginBottom: '8px' } },
        `${engineLabel(out.engine)}${out.ms ? ` · ${(out.ms / 1000).toFixed(1)}s` : ''}` +
        (out.lookup ? ` · 已用 ISBN 从「${sourceName(out.lookup)}」补全书目` : '')),
      (out.warnings || []).length
        ? h('div', { class: 'card pad', style: { marginBottom: '10px', padding: '9px 11px' } },
            (out.warnings || []).map((w) => h('div', { class: 'tiny status-warn' }, `⚠ ${w}`)))
        : null,
      (out.notes || []).length
        ? h('div', { class: 'card pad', style: { marginBottom: '10px', padding: '9px 11px' } },
            (out.notes || []).map((n) => h('div', { class: 'tiny muted' }, `· ${n}`)))
        : null,
      rows.length ? h('div', {}, rows) : h('div', { class: 'muted small' }, '没识别出字段'),
      out.text
        ? h('details', { style: { marginTop: '12px' } },
            h('summary', { class: 'tiny faint', style: { cursor: 'pointer' } }, '看识别原文'),
            h('pre', {
              style: {
                whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: '1.6',
                background: 'var(--card-2)', padding: '10px', borderRadius: '8px',
                maxHeight: '220px', overflow: 'auto', marginTop: '6px',
              },
            }, out.text))
        : null
    ),
    actions: [
      { label: '取消', value: false, class: 'ghost' },
      { label: '填入表单', value: true, class: 'primary' },
    ],
  });

  if (!ok) return null;
  const picked = { ...hidden };
  for (const [k, cb] of checks) if (cb.checked) picked[k] = out.fields[k];
  return picked;
}

function sourceName(s) {
  return {
    douban: '豆瓣', zlibrary: 'Z-Library', googlebooks: 'Google Books',
    openlibrary: 'Open Library', weread: '微信读书',
  }[String(s).split('+')[0]] || s;
}
