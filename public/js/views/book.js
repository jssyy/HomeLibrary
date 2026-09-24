/** 书籍详情：书目信息 / 家庭阅读情况 / 购买记录 / 电子书 / 笔记 / 外部找书 */
import { h, toast, modal, confirmBox, coverNode, money, dateText, form, STATUS_LIST } from '../ui.js';
import api from '../api.js';
import { store, go } from '../app.js';

export default async function bookView(root, { params }) {
  const id = Number(params.id);
  let book = await api.book(id);

  const wrap = h('div', {});
  root.append(wrap);
  paint();

  function paint() {
    wrap.innerHTML = '';
    wrap.append(headSection(), siblingSection(), readingSection(), purchaseSection(), ebookSection(), noteSection(), linkSection(), dangerSection());
  }

  async function refresh() {
    book = await api.book(id);
    paint();
  }

  // ---------------------------------------------------------------- 头部

  function headSection() {
    const meta = [];
    const add = (k, v) => { if (v) meta.push([k, v]); };
    add('作者', book.author);
    add('译者', book.translator);
    add('出版社', book.publisher);
    add('出版', dateText(book.pub_date));
    add('页数', book.pages);
    add('定价', book.list_price ? money(book.list_price) : null);
    add('ISBN', book.isbn13 || book.isbn10);
    add('载体', book.carrier);
    add('位置', book.location);
    add('分类', book.category);
    add('丛书', book.series);
    add('分册', book.volume);
    if (book.ext_rating) add('评分', `${book.ext_rating}${book.ext_rating_count ? ` (${book.ext_rating_count} 人)` : ''}`);

    return h('div', {},
      h('div', { class: 'detail-head' },
        h('div', { class: 'detail-cover' },
          coverNode(book),
          h('button', {
            class: 'btn sm block', style: { marginTop: '8px' },
            onclick: changeCover,
          }, '换封面')
        ),
        h('div', { style: { minWidth: '0', flex: '1' } },
          h('div', { class: 'detail-title' }, book.title,
            book.volume ? h('span', { class: 'src-tag', style: { marginLeft: '8px', verticalAlign: 'middle' } }, book.volume) : null),
          book.subtitle ? h('div', { class: 'meta-line' }, book.subtitle) : null,
          h('div', { class: 'meta-line' }, [book.author, book.publisher, dateText(book.pub_date)].filter(Boolean).join(' · ')),
          h('div', { class: 'row', style: { marginTop: '12px' } },
            h('button', { class: 'btn primary sm', onclick: () => go(`/edit/${book.id}`) }, '编辑'),
            book.files && book.files.length
              ? h('button', { class: 'btn sm', onclick: () => openReader(book.files[0].id) }, '📖 在线阅读')
              : null,
            h('button', { class: 'btn sm', onclick: refetch }, '重新抓取书目'),
          ),
          h('dl', { class: 'kv', style: { marginTop: '14px' } },
            meta.map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]).flat()
          ),
          book.tags
            ? h('div', { class: 'row', style: { marginTop: '10px' } },
                String(book.tags).split(',').filter(Boolean).map((t) =>
                  h('a', { class: 'chip', href: `#/?tag=${encodeURIComponent(t)}` }, `#${t}`))
              )
            : null
        )
      ),
      book.summary
        ? h('div', { class: 'card pad' },
            h('div', { class: 'section-title' }, '内容简介'),
            h('div', { class: 'small', style: { whiteSpace: 'pre-wrap', lineHeight: '1.75', color: 'var(--text-dim)' } }, book.summary)
          )
        : null
    );
  }

  async function refetch() {
    toast('正在重新抓取…');
    try {
      const out = await api.refreshBook(book.id);
      toast(out.patched.length ? `补上了：${out.patched.join('、')}` : '没有新信息可补', 'ok');
      await refresh();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function changeCover() {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.addEventListener('change', async () => {
      if (!input.files[0]) return;
      const fd = new FormData();
      fd.append('cover', input.files[0]);
      try {
        await api.uploadCover(book.id, fd);
        toast('封面换好了', 'ok');
        await refresh();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    input.click();
  }

  /** 套装书：整套共用一个 ISBN，这里把同 ISBN 的其它分册列出来 */
  function siblingSection() {
    const sibs = book.siblings || [];
    if (!sibs.length) return null;
    return h('div', { class: 'section' },
      h('div', { class: 'section-title' },
        '同一套的其它分册',
        h('span', { class: 'count' }, `共用 ISBN ${book.isbn13} · ${sibs.length} 本`)
      ),
      h('div', { class: 'card pad' },
        sibs.map((sb) =>
          h('div', {
            class: 'row',
            style: { padding: '7px 0', borderBottom: '1px solid var(--line-soft)', cursor: 'pointer' },
            onclick: () => go(`/book/${sb.id}`),
          },
            h('div', { style: { width: '30px', flex: 'none' } }, coverNode(sb)),
            h('div', { class: 'ellip small', style: { flex: '1', fontWeight: '600' } }, sb.title),
            sb.volume ? h('span', { class: 'src-tag' }, sb.volume) : null,
            h('span', { class: 'faint' }, '›')
          )
        )
      )
    );
  }

  // ---------------------------------------------------------------- 阅读情况

  function readingSection() {
    return h('div', { class: 'section' },
      h('div', { class: 'section-title' }, '家庭阅读情况'),
      h('div', { style: { display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(232px, 1fr))' } },
        (book.readings || []).map(readingCard)
      )
    );
  }

  function readingCard(r) {
    const bar = h('i', { style: { width: `${r.progress || 0}%` } });
    const seg = h('div', { class: 'status-seg' },
      STATUS_LIST.map((s) =>
        h('button', {
          class: r.status === s ? 'on' : '',
          onclick: async () => {
            try {
              const updated = await api.setReading(book.id, r.member_id, { status: s });
              Object.assign(r, updated);
              toast(`${r.member_name} · ${s}`, 'ok');
              await refresh();
            } catch (e) {
              toast(e.message, 'err');
            }
          },
        }, s)
      )
    );

    return h('div', { class: 'card reading-card' },
      h('div', { class: 'who' },
        h('span', { class: 'avatar', style: { background: r.color + '22' } }, r.emoji),
        h('span', {}, r.member_name),
        h('span', { class: 'spacer' }),
        r.rating ? h('span', { class: 'tiny', style: { color: 'var(--warn)' } }, '★'.repeat(r.rating)) : null
      ),
      seg,
      h('div', { class: 'bar' }, bar),
      h('div', { class: 'row tiny faint' },
        h('span', {}, `${Math.round(r.progress || 0)}%`),
        h('span', { class: 'spacer' }),
        r.started_at ? h('span', {}, `始 ${dateText(r.started_at)}`) : null,
        r.finished_at ? h('span', {}, `终 ${dateText(r.finished_at)}`) : null
      ),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost sm', onclick: () => editReading(r) }, '记录进度'),
        r.review ? h('span', { class: 'tiny faint clamp2', style: { flex: '1' } }, r.review) : null
      )
    );
  }

  async function editReading(r) {
    const f = form([
      { name: 'progress', label: '阅读进度 %', type: 'number', min: 0, max: 100, step: 1, value: Math.round(r.progress || 0) },
      { type: 'group', fields: [
        { name: 'started_at', label: '开始日期', type: 'date', value: dateText(r.started_at) },
        { name: 'finished_at', label: '读完日期', type: 'date', value: dateText(r.finished_at) },
      ] },
      { name: 'rating', label: '打分（1-5 星）', type: 'select', value: r.rating || '', options: [{ value: '', label: '未评分' }, 1, 2, 3, 4, 5] },
      { name: 'review', label: '短评 / 感想', type: 'textarea', value: r.review || '' },
      { name: 'note', label: '这次记录的备注（写进阅读流水）', placeholder: '例：今天读到第 3 章' },
    ]);
    const ok = await modal({
      title: `${r.emoji} ${r.member_name} 的阅读记录`,
      body: f.node,
      actions: [{ label: '取消', value: false, class: 'ghost' }, { label: '保存', value: true, class: 'primary' }],
    });
    if (!ok) return;
    const v = f.values();
    try {
      await api.setReading(book.id, r.member_id, {
        progress: v.progress === '' ? undefined : Number(v.progress),
        started_at: v.started_at || null,
        finished_at: v.finished_at || null,
        rating: v.rating === '' ? null : Number(v.rating),
        review: v.review || null,
        note: v.note || null,
        status: Number(v.progress) >= 100 ? '已读' : Number(v.progress) > 0 ? '在读' : r.status,
      });
      toast('记下了', 'ok');
      await refresh();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ---------------------------------------------------------------- 购买记录

  function purchaseSection() {
    const list = book.purchases || [];
    const total = list.reduce((s, p) => s + (p.price || 0) * (p.quantity || 1), 0);
    return h('div', { class: 'section' },
      h('div', { class: 'section-title' },
        '购买记录',
        h('span', { class: 'count' }, list.length ? `${list.length} 笔 · 合计 ${money(total)}` : ''),
        h('span', { class: 'spacer', style: { flex: '1' } }),
        h('button', { class: 'btn sm', onclick: () => editPurchase(null) }, '＋ 添加')
      ),
      list.length
        ? h('div', { class: 'card pad' },
            h('div', { class: 'timeline' }, list.map((p) =>
              h('div', { class: 'tl-item' },
                h('div', { class: 'tl-date' }, dateText(p.purchased_at) || '未填日期'),
                h('div', { style: { flex: '1', minWidth: '0' } },
                  h('div', {}, [p.channel || '未填渠道', p.quantity > 1 ? `×${p.quantity}` : ''].filter(Boolean).join(' ')),
                  p.note ? h('div', { class: 'tiny faint' }, p.note) : null
                ),
                h('div', { class: 'mono', style: { fontWeight: '600' } }, money(p.price)),
                p.buyer_name ? h('span', { class: 'src-tag' }, p.buyer_name) : null,
                h('button', { class: 'icon-btn', onclick: () => editPurchase(p) }, '✎')
              )
            ))
          )
        : h('div', { class: 'card pad muted small' }, '还没有购买记录。买了新书可以在这里记一笔价格和渠道，统计页会自动算年度花费。')
    );
  }

  async function editPurchase(p) {
    const f = form([
      { type: 'group', fields: [
        { name: 'purchased_at', label: '购买日期', type: 'date', value: dateText(p && p.purchased_at) || new Date().toISOString().slice(0, 10) },
        { name: 'price', label: '实付金额', type: 'number', step: '0.01', inputmode: 'decimal', value: p ? p.price ?? '' : book.list_price ?? '' },
      ] },
      { type: 'group', fields: [
        { name: 'channel', label: '购买渠道', type: 'select', value: (p && p.channel) || '京东',
          options: (store.settings.options ? store.settings.options.channels : ['京东', '当当', '实体书店', '其他']) },
        { name: 'quantity', label: '数量', type: 'number', min: 1, value: (p && p.quantity) || 1 },
      ] },
      { name: 'buyer_id', label: '购买人', type: 'select', value: (p && p.buyer_id) || '',
        options: [{ value: '', label: '未指定' }, ...store.members.filter((m) => m.active).map((m) => ({ value: m.id, label: `${m.emoji} ${m.name}` }))] },
      { name: 'note', label: '备注', placeholder: '例：活动满 200-100' },
    ]);

    const actions = [{ label: '取消', value: 'cancel', class: 'ghost' }];
    if (p) actions.push({ label: '删除', value: 'delete', class: 'danger' });
    actions.push({ label: '保存', value: 'save', class: 'primary' });

    const act = await modal({ title: p ? '修改购买记录' : '添加购买记录', body: f.node, actions });
    if (!act || act === 'cancel') return;
    try {
      if (act === 'delete') {
        if (!(await confirmBox('删掉这条购买记录？'))) return;
        await api.deletePurchase(p.id);
      } else {
        const v = f.values();
        const payload = {
          purchased_at: v.purchased_at,
          price: v.price === '' ? null : Number(v.price),
          channel: v.channel,
          quantity: Number(v.quantity || 1),
          buyer_id: v.buyer_id || null,
          note: v.note,
        };
        if (p) await api.updatePurchase(p.id, payload);
        else await api.addPurchase(book.id, payload);
      }
      toast('已保存', 'ok');
      await refresh();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ---------------------------------------------------------------- 电子书

  function ebookSection() {
    const files = book.files || [];
    return h('div', { class: 'section' },
      h('div', { class: 'section-title' },
        '电子书 · 在线阅读',
        h('span', { class: 'count' }, files.length ? `${files.length} 个文件` : ''),
        h('span', { style: { flex: '1' } }),
        h('button', { class: 'btn sm', onclick: uploadFile }, '＋ 上传 EPUB / PDF')
      ),
      files.length
        ? h('div', { class: 'card pad' }, files.map((f) =>
            h('div', { class: 'row', style: { padding: '7px 0', borderBottom: '1px solid var(--line-soft)' } },
              h('span', {}, f.format === 'pdf' ? '📕' : '📗'),
              h('div', { style: { flex: '1', minWidth: '0' } },
                h('div', { class: 'ellip small' }, f.name),
                h('div', { class: 'tiny faint' }, `${f.format.toUpperCase()} · ${(f.size / 1048576).toFixed(1)} MB`)
              ),
              ['epub', 'pdf'].includes(f.format)
                ? h('button', { class: 'btn sm primary', onclick: () => openReader(f.id) }, '阅读')
                : h('span', { class: 'tiny faint' }, '暂不支持在线阅读'),
              h('a', { class: 'btn sm', href: `/api/files/${f.id}/download` }, '下载'),
              h('button', {
                class: 'icon-btn',
                onclick: async () => {
                  if (!(await confirmBox(`删除文件「${f.name}」？`))) return;
                  await api.deleteFile(f.id);
                  toast('已删除', 'ok');
                  await refresh();
                },
              }, '🗑')
            )
          ))
        : h('div', { class: 'card pad muted small' },
            '还没有电子版。上传 EPUB / PDF 后就能在手机、平板、电脑上接着读，进度自动同步。',
            h('div', { style: { marginTop: '10px' } },
              h('a', {
                class: 'btn sm',
                href: (book.external_links || []).find((l) => l.primary)?.url || '#',
                target: '_blank', rel: 'noopener noreferrer',
              }, '去 Z-Library 找这本书')
            )
          )
    );
  }

  async function uploadFile() {
    const input = h('input', { type: 'file', accept: '.epub,.pdf,.txt,.mobi,.azw3', multiple: true });
    input.addEventListener('change', async () => {
      if (!input.files.length) return;
      const fd = new FormData();
      for (const f of input.files) fd.append('files', f);
      toast('上传中…');
      try {
        await api.uploadFiles(book.id, fd);
        toast('上传完成', 'ok');
        await refresh();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    input.click();
  }

  function openReader(fileId) {
    const member = store.actingMember() || (book.readings[0] && book.readings[0].member_id) || '';
    location.href = `/read/${fileId}?member=${member}`;
  }

  // ---------------------------------------------------------------- 笔记

  function noteSection() {
    const notes = book.notes || [];
    return h('div', { class: 'section' },
      h('div', { class: 'section-title' },
        '读书笔记',
        h('span', { class: 'count' }, notes.length ? `${notes.length} 条` : ''),
        h('span', { style: { flex: '1' } }),
        h('button', { class: 'btn sm', onclick: () => editNote(null) }, '＋ 写一条')
      ),
      notes.length
        ? h('div', {}, notes.map((n) =>
            h('div', { class: 'note-card' },
              n.quote ? h('div', { class: 'note-quote' }, `「${n.quote}」`) : null,
              n.note ? h('div', { class: 'note-own' }, n.note) : null,
              h('div', { class: 'row tiny faint', style: { marginTop: '8px' } },
                h('span', {}, `${n.emoji || ''} ${n.member_name || '未署名'}`),
                h('span', {}, dateText(n.created_at)),
                n.chapter ? h('span', {}, n.chapter) : null,
                h('span', { style: { flex: '1' } }),
                h('button', { class: 'icon-btn', onclick: () => editNote(n) }, '✎')
              )
            )
          ))
        : h('div', { class: 'card pad muted small' }, '在线阅读时划词就能存笔记，也可以手动写。')
    );
  }

  async function editNote(n) {
    const f = form([
      { name: 'quote', label: '原文摘录', type: 'textarea', rows: 3, value: (n && n.quote) || '' },
      { name: 'note', label: '我的想法', type: 'textarea', rows: 3, value: (n && n.note) || '' },
      { type: 'group', fields: [
        { name: 'chapter', label: '章节', value: (n && n.chapter) || '' },
        { name: 'member_id', label: '谁写的', type: 'select', value: (n && n.member_id) || store.actingMember() || '',
          options: [{ value: '', label: '未署名' }, ...store.members.filter((m) => m.active).map((m) => ({ value: m.id, label: `${m.emoji} ${m.name}` }))] },
      ] },
    ]);
    const actions = [{ label: '取消', value: 'cancel', class: 'ghost' }];
    if (n) actions.push({ label: '删除', value: 'delete', class: 'danger' });
    actions.push({ label: '保存', value: 'save', class: 'primary' });

    const act = await modal({ title: n ? '编辑笔记' : '新的笔记', body: f.node, actions });
    if (!act || act === 'cancel') return;
    try {
      if (act === 'delete') {
        await api.deleteNote(n.id);
      } else {
        const v = f.values();
        if (!v.quote && !v.note) return toast('摘录和想法至少写一个', 'err');
        if (n) await api.updateNote(n.id, v);
        else await api.addNote(book.id, v);
      }
      toast('已保存', 'ok');
      await refresh();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ---------------------------------------------------------------- 外链

  function linkSection() {
    return h('div', { class: 'section' },
      h('div', { class: 'section-title' }, '到别处找这本书'),
      h('div', { class: 'linkbar' },
        (book.external_links || []).map((l) =>
          h('a', { class: l.primary ? 'primary' : '', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.name)
        )
      ),
      h('div', { class: 'tiny faint', style: { marginTop: '8px' } },
        'Z-Library 在新标签页打开（用你浏览器里的登录态）。拿到 EPUB/PDF 后回来上传，就能在线阅读了。')
    );
  }

  function dangerSection() {
    return h('div', { class: 'section', style: { paddingTop: '10px', borderTop: '1px solid var(--line-soft)' } },
      h('div', { class: 'row' },
        h('span', { class: 'tiny faint' }, `录入于 ${dateText(book.created_at)}`),
        h('span', { style: { flex: '1' } }),
        h('button', {
          class: 'btn danger sm',
          onclick: async () => {
            if (!(await confirmBox(`确定删除《${book.title}》？购买记录、阅读记录、笔记会一起删掉。`))) return;
            await api.deleteBook(book.id);
            toast('已删除', 'ok');
            go('/');
          },
        }, '删除这本书')
      )
    );
  }
}
