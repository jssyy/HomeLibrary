/** 笔记与划线：全库检索 */
import { h, toast, dateText, debounce } from '../ui.js';
import api from '../api.js';
import { store, go } from '../app.js';

export default async function notes(root, { query }) {
  const state = { q: query.q || '', member: query.member || '' };

  const input = h('input', {
    type: 'search', placeholder: '搜笔记内容…', value: state.q,
    style: { flex: '1', padding: '9px 12px', borderRadius: '999px', border: '1px solid var(--line)', background: 'var(--card)' },
  });
  const filters = h('div', { class: 'scroll-x', style: { margin: '12px 0' } });
  const list = h('div', {});

  root.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('div', { class: 'page-title' }, '读书笔记'),
        h('div', { class: 'page-sub', id: 'noteSub' }, '')
      )
    ),
    h('div', { class: 'row' }, input),
    filters,
    list
  );

  input.addEventListener('input', debounce(() => { state.q = input.value.trim(); load(); }, 300));

  function buildFilters() {
    filters.innerHTML = '';
    const chip = (label, on, onclick) => h('button', { class: `chip ${on ? 'on' : ''}`, onclick }, label);
    chip('全部', !state.member, () => {});
    filters.append(chip('全部', !state.member, () => { state.member = ''; load(); }));
    for (const m of store.members) {
      const on = String(state.member) === String(m.id);
      filters.append(chip(`${m.emoji} ${m.name}`, on, () => { state.member = on ? '' : String(m.id); load(); }));
    }
  }

  async function load() {
    buildFilters();
    list.innerHTML = '<div class="card pad muted">加载中…</div>';
    try {
      const items = await api.notes({ q: state.q, member: state.member, limit: 300 });
      document.getElementById('noteSub').textContent = `${items.length} 条`;
      list.innerHTML = '';
      if (!items.length) {
        list.append(h('div', { class: 'empty' },
          h('div', { class: 'big' }, '✍️'),
          h('div', {}, '还没有笔记'),
          h('div', { class: 'small faint', style: { marginTop: '6px' } }, '在线阅读时选中文字即可存成划线笔记')
        ));
        return;
      }
      for (const n of items) {
        list.append(
          h('div', { class: 'note-card', style: { cursor: 'pointer' }, onclick: () => go(`/book/${n.book_id}`) },
            n.quote ? h('div', { class: 'note-quote' }, `「${n.quote}」`) : null,
            n.note ? h('div', { class: 'note-own' }, n.note) : null,
            h('div', { class: 'row tiny faint', style: { marginTop: '8px' } },
              h('span', { style: { fontWeight: '600' } }, n.title),
              h('span', {}, n.member_name ? `${n.emoji || ''}${n.member_name}` : ''),
              h('span', {}, dateText(n.created_at)),
              n.chapter ? h('span', {}, n.chapter) : null
            )
          )
        );
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  await load();
}
