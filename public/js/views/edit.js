/** 新增 / 编辑书籍。Z-Library 书签小工具也跳到这个页面（带 query 预填） */
import { h, toast, coverNode, form, STATUS_LIST } from '../ui.js';
import api from '../api.js';
import { store, go } from '../app.js';
import { resolveDuplicate } from '../duplicate.js';
import { pickAndRecognize, confirmFields } from '../photo.js';

export default async function edit(root, { params, query }) {
  const editing = !!params.id;
  // 扫码页拍完版权页会把字段放在 sessionStorage 里（简介可能很长，不适合塞进 URL）
  let photoFields = {};
  if (!editing && query.from_photo === '1') {
    try {
      photoFields = JSON.parse(sessionStorage.getItem('hl_photo_fields') || '{}');
    } catch { photoFields = {}; }
    sessionStorage.removeItem('hl_photo_fields');
  }
  const book = editing ? await api.book(Number(params.id)) : { ...query, ...photoFields };
  const carriers = (store.settings.options && store.settings.options.carriers) || ['纸质书', '电子书', '有声书'];
  const channels = (store.settings.options && store.settings.options.channels) || ['京东', '当当', '实体书店', '其他'];

  const f = form([
    { name: 'title', label: '书名 *', placeholder: '必填' },
    { name: 'subtitle', label: '副标题' },
    { type: 'group', fields: [
      { name: 'author', label: '作者' },
      { name: 'translator', label: '译者' },
    ] },
    { type: 'group', fields: [
      { name: 'publisher', label: '出版社' },
      { name: 'pub_date', label: '出版时间', placeholder: '2024 或 2024-05' },
    ] },
    { type: 'group', class: 'grid3', fields: [
      { name: 'isbn13', label: 'ISBN', inputmode: 'numeric' },
      { name: 'pages', label: '页数', type: 'number' },
      { name: 'list_price', label: '定价', type: 'number', step: '0.01' },
    ] },
    { type: 'group', class: 'grid3', fields: [
      { name: 'carrier', label: '载体', type: 'select', options: carriers },
      { name: 'category', label: '分类', placeholder: '文学 / 童书 / 科普' },
      { name: 'location', label: '存放位置', placeholder: '客厅书架 A-3' },
    ] },
    { type: 'group', fields: [
      { name: 'tags', label: '标签', placeholder: '逗号分隔，例：绘本,睡前故事' },
      { name: 'series', label: '丛书 / 套装名', placeholder: '例：世界神话故事集' },
    ] },
    { name: 'volume', label: '分册', placeholder: '套装书整套共用一个 ISBN 时，用它区分：第 2 册 / 希腊神话卷' },
    { name: 'cover_url', label: '封面图片地址', placeholder: 'https://…' },
    { name: 'summary', label: '内容简介', type: 'textarea', rows: 5 },
  ], normalize(book));

  // 封面预览 + 拍照上传（查不到书目时直接拍书封）
  let pendingCover = null; // 新增时先留着，等书建好再传
  const previewImg = h('div', {}, coverNode(bookForPreview()));
  const preview = h('div', { style: { width: '104px', flex: 'none' } },
    previewImg,
    h('button', { class: 'btn sm block', style: { marginTop: '8px' }, onclick: () => pickCover(true) }, '📷 拍封面'),
    h('button', { class: 'btn sm block ghost', style: { marginTop: '6px' }, onclick: () => pickCover(false) }, '从相册选')
  );

  function bookForPreview() {
    const v = f.values ? f.values() : {};
    return { title: v.title || book.title, author: v.author || book.author, cover_path: book.cover_path, cover_url: v.cover_url || book.cover_url };
  }

  function pickCover(useCamera) {
    const input = h('input', { type: 'file', accept: 'image/*', capture: useCamera ? 'environment' : undefined });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      previewImg.innerHTML = '';
      previewImg.append(h('div', { class: 'cover-wrap' }, h('img', { src: URL.createObjectURL(file) })));
      if (editing) {
        const fd = new FormData();
        fd.append('cover', file);
        try {
          await api.uploadCover(book.id, fd);
          toast('封面已更新', 'ok');
        } catch (e) {
          toast(e.message, 'err');
        }
      } else {
        pendingCover = file;
        toast('入库时会一起保存这张封面');
      }
    });
    input.click();
  }

  // 购买信息（仅新增时一起填）
  const pf = form([
    { type: 'group', class: 'grid3', fields: [
      { name: 'purchased_at', label: '购买日期', type: 'date', value: new Date().toISOString().slice(0, 10) },
      { name: 'price', label: '实付金额', type: 'number', step: '0.01' },
      { name: 'channel', label: '渠道', type: 'select', options: ['', ...channels] },
    ] },
    { name: 'buyer_id', label: '购买人', type: 'select', value: store.actingMember() || '',
      options: [{ value: '', label: '未指定' }, ...store.members.filter((m) => m.active).map((m) => ({ value: m.id, label: `${m.emoji} ${m.name}` }))] },
  ]);

  // 阅读状态（新增时可直接设）
  const readingSelects = new Map();
  const readingRow = h('div', { class: 'row' },
    store.members.filter((m) => m.active).map((m) => {
      const sel = h('select', { class: 'btn sm' }, STATUS_LIST.map((s) => h('option', { value: s }, s)));
      readingSelects.set(m.id, sel);
      return h('label', { class: 'row', style: { gap: '6px' } }, h('span', {}, `${m.emoji} ${m.name}`), sel);
    })
  );

  const lookupBtn = h('button', { class: 'btn sm', onclick: doLookup }, '按 ISBN / 书名查书目');
  const photoBtn = h('button', { class: 'btn sm primary', onclick: scanCopyright }, '📷 拍版权页识别');

  /** 拍版权页：识别出的字段勾选后直接填进表单 */
  async function scanCopyright() {
    photoBtn.disabled = true;
    photoBtn.textContent = '识别中…';
    try {
      const out = await pickAndRecognize();
      if (!out) return;
      const picked = await confirmFields(out, f.values());
      if (!picked) return;
      for (const [k, v] of Object.entries(picked)) {
        const input = f.input(k);
        if (input) input.value = v;
        else book[k] = v; // source_url、isbn10 这些没有输入框，入库时一起带上
      }
      previewImg.innerHTML = '';
      previewImg.append(coverNode(bookForPreview()));
      toast(`填入了 ${Object.keys(picked).length} 个字段，核对一下再入库`, 'ok');
    } finally {
      photoBtn.disabled = false;
      photoBtn.textContent = '📷 拍版权页识别';
    }
  }

  root.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('div', { class: 'page-title' }, editing ? '编辑书籍' : '录入新书'),
        h('div', { class: 'page-sub' }, editing ? book.title : '扫码查不到时可以手动填，之后随时能补')
      ),
      h('div', { class: 'row' }, photoBtn, lookupBtn)
    ),
    h('div', { class: 'card pad', style: { display: 'flex', gap: '18px', alignItems: 'flex-start' } },
      preview,
      h('div', { style: { flex: '1', minWidth: '0' } }, f.node)
    ),
    editing ? '' : h('div', { class: 'section' },
      h('div', { class: 'section-title' }, '购买信息', h('span', { class: 'count' }, '不填也行，之后能补')),
      h('div', { class: 'card pad' }, pf.node)
    ),
    editing ? '' : h('div', { class: 'section' },
      h('div', { class: 'section-title' }, '谁要读'),
      h('div', { class: 'card pad' }, readingRow)
    ),
    h('div', { class: 'row', style: { marginTop: '22px', position: 'sticky', bottom: '0', background: 'var(--bg)', padding: '12px 0' } },
      h('button', { class: 'btn primary', onclick: save }, editing ? '保存修改' : '入库'),
      h('button', { class: 'btn ghost', onclick: () => history.back() }, '取消')
    )
  );

  if (query.photo === '1') setTimeout(() => pickCover(true), 300);

  f.input('cover_url').addEventListener('change', () => {
    previewImg.innerHTML = '';
    previewImg.append(coverNode(bookForPreview()));
  });

  async function doLookup() {
    const v = f.values();
    const q = v.isbn13 || [v.title, v.author].filter(Boolean).join(' ');
    if (!q) return toast('先填个 ISBN 或书名', 'err');
    lookupBtn.disabled = true;
    lookupBtn.textContent = '查询中…';
    try {
      const out = await api.lookup(q);
      if (!out.results.length) {
        toast('没查到，手动填吧', 'err');
        return;
      }
      const best = out.results[0];
      for (const [k, val] of Object.entries(best)) {
        const input = f.input(k);
        if (input && val && !input.value) input.value = val;
      }
      previewImg.innerHTML = '';
      previewImg.append(coverNode(bookForPreview()));
      toast(`已用「${sourceName(best.source)}」的结果填充`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = '按 ISBN / 书名查书目';
    }
  }

  async function save() {
    const v = f.values();
    if (!v.title) return toast('书名必填', 'err');
    const payload = {
      ...v,
      pages: v.pages === '' ? null : Number(v.pages),
      list_price: v.list_price === '' ? null : Number(v.list_price),
      source: book.source || 'manual',
      source_url: book.source_url || query.source_url || null,
    };
    try {
      if (editing) {
        await api.updateBook(book.id, payload);
        toast('已保存', 'ok');
        go(`/book/${book.id}`);
      } else {
        const pv = pf.values();
        payload.purchase = (pv.purchased_at || pv.price || pv.channel)
          ? { purchased_at: pv.purchased_at, price: pv.price === '' ? null : Number(pv.price), channel: pv.channel || null, buyer_id: pv.buyer_id || null }
          : null;
        payload.readings = [...readingSelects.entries()].map(([member_id, sel]) => ({ member_id, status: sel.value }));
        let created;
        try {
          created = await api.createBook(payload);
        } catch (e) {
          if (e.status !== 409) throw e;
          // 同 ISBN 未必是同一本（套装书），让用户定夺
          created = await resolveDuplicate(e, payload);
          if (!created) return;
        }
        if (pendingCover) {
          const fd = new FormData();
          fd.append('cover', pendingCover);
          await api.uploadCover(created.id, fd).catch(() => toast('封面没传上去，可以在详情页重试', 'err'));
        }
        toast(`《${created.title}》已入库`, 'ok');
        go(`/book/${created.id}`);
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }
}

function normalize(b) {
  const out = { ...b };
  if (out.pub_date) out.pub_date = String(out.pub_date).slice(0, 10);
  if (!out.carrier) out.carrier = '纸质书';
  return out;
}

function sourceName(s) {
  return { douban: '豆瓣', zlibrary: 'Z-Library', googlebooks: 'Google Books', openlibrary: 'Open Library', weread: '微信读书' }[s] || s || '外部来源';
}
