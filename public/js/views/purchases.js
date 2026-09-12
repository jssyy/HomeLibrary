/** 购书记录：按时间倒序的流水 + 年度/渠道/购买人筛选 */
import { h, toast, money, dateText, coverNode } from '../ui.js';
import api from '../api.js';
import { store, go } from '../app.js';

export default async function purchases(root, { query }) {
  const state = {
    year: query.year || '',
    buyer: query.buyer || '',
    channel: query.channel || '',
  };

  const head = h('div', { class: 'page-head' },
    h('div', {},
      h('div', { class: 'page-title' }, '购书记录'),
      h('div', { class: 'page-sub', id: 'pcSub' }, '加载中…')
    ),
    h('button', { class: 'btn sm', onclick: () => go('/scan') }, '＋ 录入新书')
  );
  const filters = h('div', { class: 'scroll-x', style: { marginBottom: '14px' } });
  const list = h('div', {});
  root.append(head, filters, list);

  const stats = await api.stats().catch(() => ({ years: [], channels: [] }));

  function buildFilters() {
    filters.innerHTML = '';
    const chip = (label, on, onclick) => h('button', { class: `chip ${on ? 'on' : ''}`, onclick }, label);
    filters.append(chip('全部年份', !state.year, () => { state.year = ''; load(); }));
    for (const y of stats.years || []) {
      filters.append(chip(`${y} 年`, state.year === y, () => { state.year = state.year === y ? '' : y; load(); }));
    }
    filters.append(h('span', { style: { width: '1px', background: 'var(--line)', margin: '4px 2px', flex: 'none' } }));
    for (const m of store.members) {
      const on = String(state.buyer) === String(m.id);
      filters.append(chip(`${m.emoji} ${m.name}买的`, on, () => { state.buyer = on ? '' : String(m.id); load(); }));
    }
  }

  async function load() {
    buildFilters();
    list.innerHTML = '<div class="card pad muted">加载中…</div>';
    try {
      const data = await api.purchases({ year: state.year, buyer: state.buyer, channel: state.channel, limit: 500 });
      document.getElementById('pcSub').textContent =
        `${state.year ? state.year + ' 年' : '累计'} ${data.count} 笔 · 花费 ${money(data.amount)}`;
      paint(data.items);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function paint(items) {
    list.innerHTML = '';
    if (!items.length) {
      list.append(h('div', { class: 'empty' },
        h('div', { class: 'big' }, '🧾'),
        h('div', {}, '还没有购买记录'),
        h('div', { class: 'small faint', style: { marginTop: '6px' } }, '在书籍详情页可以给每本书记一笔购买信息')
      ));
      return;
    }
    // 按月分组
    const groups = new Map();
    for (const p of items) {
      const key = (p.purchased_at || '未填日期').slice(0, 7);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const [month, rows] of groups) {
      const sum = rows.reduce((s, p) => s + (p.price || 0) * (p.quantity || 1), 0);
      list.append(
        h('div', { class: 'section-title', style: { marginTop: '18px' } },
          month,
          h('span', { class: 'count' }, `${rows.length} 本 · ${money(sum)}`)
        ),
        h('div', { class: 'card pad' }, rows.map((p) =>
          h('div', { class: 'row', style: { padding: '8px 0', borderBottom: '1px solid var(--line-soft)', cursor: 'pointer' },
            onclick: () => go(`/book/${p.book_id}`) },
            h('div', { style: { width: '34px', flex: 'none' } }, coverNode(p)),
            h('div', { style: { flex: '1', minWidth: '0' } },
              h('div', { class: 'ellip small', style: { fontWeight: '600' } }, p.title),
              h('div', { class: 'tiny faint ellip' }, [dateText(p.purchased_at), p.channel, p.buyer_name && `${p.emoji || ''}${p.buyer_name}`, p.note].filter(Boolean).join(' · '))
            ),
            h('div', { class: 'mono', style: { fontWeight: '600' } }, money(p.price) + (p.quantity > 1 ? ` ×${p.quantity}` : ''))
          )
        ))
      );
    }
  }

  await load();
}
