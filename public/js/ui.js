/** 一些不依赖框架的小工具：建 DOM、提示、弹窗、格式化 */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(3)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
export function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'err' ? 4200 : 2200);
}

/** 通用弹窗。body 可以是节点或返回节点的函数；resolve 的值由 actions 决定 */
export function modal({ title, body, actions, onMount }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot');
    const close = (v) => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    const content = typeof body === 'function' ? body(close) : body;
    const box = h('div', { class: 'modal' },
      title ? h('h3', { text: title }) : null,
      content,
      actions
        ? h('div', { class: 'modal-actions' },
            actions.map((a) =>
              h('button', {
                class: `btn ${a.class || ''}`,
                onclick: async () => {
                  const v = a.onClick ? await a.onClick(close) : a.value;
                  if (v !== '__keep__') close(v === undefined ? a.value : v);
                },
                text: a.label,
              })
            )
          )
        : null
    );
    const back = h('div', {
      class: 'modal-back',
      onclick: (e) => {
        if (e.target === back) close(null);
      },
    }, box);
    root.append(back);
    document.addEventListener('keydown', onKey);
    onMount && onMount(box, close);
  });
}

export function confirmBox(message, { title = '确认', danger = true, okText = '确定' } = {}) {
  return modal({
    title,
    body: h('p', { class: 'muted', text: message, style: { margin: '0' } }),
    actions: [
      { label: '取消', value: false, class: 'ghost' },
      { label: okText, value: true, class: danger ? 'danger' : 'primary' },
    ],
  }).then((v) => v === true);
}

// ------------------------------------------------------------------ 格式化

export function money(v, cur = '¥') {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return cur + (Math.round(n * 100) / 100).toLocaleString('zh-CN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

export function dateText(v) {
  if (!v) return '';
  return String(v).slice(0, 10);
}

export function yearText(v) {
  if (!v) return '';
  return String(v).slice(0, 4);
}

export function coverUrl(book) {
  if (book.cover_path) return `/covers/${encodeURIComponent(book.cover_path)}`;
  if (book.cover_url) return book.cover_url;
  return null;
}

export function coverNode(book, { badges = [] } = {}) {
  const src = coverUrl(book);
  const wrap = h('div', { class: 'cover-wrap' });
  if (src) {
    const img = h('img', { src, loading: 'lazy', alt: book.title || '' });
    img.addEventListener('error', () => {
      img.remove();
      wrap.append(fallback(book));
    });
    wrap.append(img);
  } else {
    wrap.append(fallback(book));
  }
  if (badges.length) {
    wrap.append(h('div', { class: 'cover-badges' }, badges.map((b) => h('span', { class: `badge ${b.kind || ''}`, text: b.text }))));
  }
  return wrap;
}

function fallback(book) {
  return h('div', { class: 'cover-fallback' },
    h('div', { style: { fontSize: '20px' } }, '📖'),
    h('div', { class: 'clamp3', style: { fontWeight: '600' } }, book.title || '无题'),
    book.author ? h('div', { class: 'tiny faint clamp2' }, book.author) : null
  );
}

export const STATUS_LIST = ['待读', '在读', '已读', '弃读'];

export function statusColor(s) {
  return { 待读: 'var(--text-faint)', 在读: 'var(--warn)', 已读: 'var(--ok)', 弃读: 'var(--text-faint)' }[s] || 'var(--text-faint)';
}

/** 防抖 */
export function debounce(fn, ms = 300) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** 简易表单：根据字段描述生成，返回 {node, values()} */
export function form(fields, initial = {}) {
  const inputs = {};
  const nodes = fields.map((f) => {
    if (f.type === 'group') return h('div', { class: f.class || 'grid2' }, f.fields.map((sub) => fieldNode(sub, initial, inputs)));
    return fieldNode(f, initial, inputs);
  });
  return {
    node: h('div', {}, nodes),
    values() {
      const out = {};
      for (const [k, el] of Object.entries(inputs)) {
        out[k] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value.trim();
      }
      return out;
    },
    input: (name) => inputs[name],
  };
}

function fieldNode(f, initial, inputs) {
  const val = initial[f.name] ?? f.value ?? '';
  let input;
  if (f.type === 'select') {
    input = h('select', { name: f.name },
      (f.options || []).map((o) => {
        const value = typeof o === 'object' ? o.value : o;
        const label = typeof o === 'object' ? o.label : o;
        return h('option', { value, selected: String(value) === String(val) || undefined }, label);
      })
    );
  } else if (f.type === 'textarea') {
    input = h('textarea', { name: f.name, rows: f.rows || 4, placeholder: f.placeholder || '' }, String(val ?? ''));
  } else {
    input = h('input', {
      name: f.name,
      type: f.type || 'text',
      placeholder: f.placeholder || '',
      value: val ?? '',
      inputmode: f.inputmode,
      step: f.step,
      min: f.min,
      max: f.max,
    });
  }
  inputs[f.name] = input;
  return h('div', { class: 'field' }, f.label ? h('label', { text: f.label }) : null, input, f.hint ? h('div', { class: 'tiny faint', text: f.hint }) : null);
}
