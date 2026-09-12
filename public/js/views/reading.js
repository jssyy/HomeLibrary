/** 在读：每个人正在读的书，可直接调进度、续读 */
import { h, toast, coverNode, dateText } from '../ui.js';
import api from '../api.js';
import { store, go } from '../app.js';

export default async function reading(root) {
  const head = h('div', { class: 'page-head' },
    h('div', {},
      h('div', { class: 'page-title' }, '在读'),
      h('div', { class: 'page-sub' }, '正在读的书，读完点一下就归档到「已读」')
    )
  );
  const body = h('div', {});
  root.append(head, body);

  async function load() {
    body.innerHTML = '<div class="card pad muted">加载中…</div>';
    const items = await api.currentReading(store.currentMember || '');
    body.innerHTML = '';

    if (!items.length) {
      body.append(h('div', { class: 'empty' },
        h('div', { class: 'big' }, '📖'),
        h('div', {}, '现在没有在读的书'),
        h('div', { class: 'small faint', style: { marginTop: '6px' } }, '去书架挑一本，把状态点成「在读」')
      ));
      return;
    }

    const byMember = new Map();
    for (const r of items) {
      if (!byMember.has(r.member_id)) byMember.set(r.member_id, []);
      byMember.get(r.member_id).push(r);
    }

    for (const [memberId, rows] of byMember) {
      const m = store.member(memberId) || { name: rows[0].member_name, emoji: rows[0].emoji };
      body.append(
        h('div', { class: 'section-title', style: { marginTop: '18px' } }, `${m.emoji} ${m.name}`, h('span', { class: 'count' }, `${rows.length} 本`)),
        h('div', { style: { display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' } },
          rows.map((r) => card(r))
        )
      );
    }
  }

  function card(r) {
    const pct = Math.round(r.progress || 0);
    const input = h('input', {
      type: 'range', min: 0, max: 100, value: pct, style: { width: '100%' },
    });
    const label = h('span', { class: 'mono tiny' }, `${pct}%`);
    input.addEventListener('input', () => (label.textContent = `${input.value}%`));
    input.addEventListener('change', async () => {
      try {
        await api.setReading(r.book_id, r.member_id, {
          progress: Number(input.value),
          status: Number(input.value) >= 100 ? '已读' : '在读',
        });
        toast(Number(input.value) >= 100 ? '读完啦 🎉' : `进度 ${input.value}%`, 'ok');
        if (Number(input.value) >= 100) load();
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    return h('div', { class: 'card pad', style: { display: 'flex', gap: '12px' } },
      h('div', { style: { width: '58px', flex: 'none', cursor: 'pointer' }, onclick: () => go(`/book/${r.book_id}`) }, coverNode(r)),
      h('div', { style: { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '7px' } },
        h('div', { class: 'ellip', style: { fontWeight: '600', cursor: 'pointer' }, onclick: () => go(`/book/${r.book_id}`) }, r.title),
        h('div', { class: 'tiny faint ellip' }, [r.author, r.started_at && `${dateText(r.started_at)} 开始`].filter(Boolean).join(' · ')),
        h('div', { class: 'row', style: { gap: '8px' } }, input, label),
        h('div', { class: 'row', style: { gap: '6px' } },
          r.file_count
            ? h('button', { class: 'btn sm primary', onclick: () => openReader(r) }, '继续读')
            : null,
          h('button', {
            class: 'btn sm',
            onclick: async () => {
              await api.setReading(r.book_id, r.member_id, { status: '已读', progress: 100 });
              toast('读完啦 🎉', 'ok');
              load();
            },
          }, '标记读完')
        )
      )
    );
  }

  async function openReader(r) {
    const book = await api.book(r.book_id);
    if (!book.files.length) return toast('这本没有电子版文件', 'err');
    location.href = `/read/${book.files[0].id}?member=${r.member_id}`;
  }

  await load();
}
