/**
 * 同 ISBN 的处理。
 *
 * 套装书（比如《中国神话故事》《希腊神话故事》同属一套）整套只有一个 ISBN，
 * 每册书名却不同，所以同 ISBN 不能直接当成重复书拦掉——
 * 这里弹窗让用户自己判断：打开已有的那本，还是当作新分册继续录入。
 */
import { h, modal, toast } from './ui.js';
import api from './api.js';
import { go } from './app.js';

/**
 * @param {Error} err  createBook 抛出的 409
 * @param {object} payload 原来要提交的书籍数据
 * @returns {Promise<object|null>} 录入成功返回新书，用户选择打开已有/取消则返回 null
 */
export async function resolveDuplicate(err, payload) {
  const data = err.data || {};
  const list = data.duplicates || (data.duplicate ? [data.duplicate] : []);
  if (!list.length) {
    toast(err.message, 'err');
    return null;
  }

  const volumeInput = h('input', {
    placeholder: '例：第 2 册 / 希腊神话卷',
    value: payload.volume || '',
    style: { width: '100%', padding: '9px 11px', borderRadius: '9px', border: '1px solid var(--line)', background: 'var(--bg-soft)' },
  });

  const choice = await modal({
    title: data.same_title ? '这本书已经在书库里了' : `已有 ${list.length} 本同 ISBN 的书`,
    body: h('div', {},
      h('p', { class: 'small muted', style: { marginTop: 0 } },
        data.same_title
          ? '书名也一样，多半就是同一本书。'
          : '套装书整套共用一个 ISBN，书名不同就是不同分册——如果这是另一册，选「作为新分册录入」。'),
      h('div', { class: 'card pad', style: { marginBottom: '12px' } },
        list.map((b) =>
          h('div', { class: 'row', style: { padding: '4px 0', gap: '8px' } },
            h('span', { class: 'small ellip', style: { flex: '1' } },
              `《${b.title}》${b.volume ? ` · ${b.volume}` : ''}`),
            h('span', { class: 'tiny faint' }, b.author || '')
          )
        )
      ),
      h('div', { class: 'field' },
        h('label', {}, `要录入的这本：《${payload.title}》分册名（可留空）`),
        volumeInput
      )
    ),
    actions: [
      { label: '取消', value: 'cancel', class: 'ghost' },
      { label: '打开已有', value: 'open' },
      { label: '作为新分册录入', value: 'force', class: 'primary' },
    ],
  });

  if (choice === 'open') {
    go(`/book/${list[0].id}`);
    return null;
  }
  if (choice !== 'force') return null;

  const volume = volumeInput.value.trim();
  try {
    return await api.createBook({ ...payload, volume: volume || payload.volume || null, force: true });
  } catch (e) {
    toast(e.message, 'err');
    return null;
  }
}
