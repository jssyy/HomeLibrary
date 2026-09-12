/** 设置：家庭成员、网络代理、书目来源、Z-Library、备份 */
import { h, toast, modal, confirmBox, form } from '../ui.js';
import api from '../api.js';
import { store } from '../app.js';

export default async function settings(root) {
  let s = await api.settings();

  const body = h('div', {});
  root.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('div', { class: 'page-title' }, '设置'),
        h('div', { class: 'page-sub' }, '成员、网络、书目来源都在这儿')
      )
    ),
    body
  );

  paint();

  function paint() {
    body.innerHTML = '';
    body.append(membersCard(), generalCard(), photoCard(), proxyCard(), sourcesCard(), zlibCard(), backupCard(), aboutCard());
  }

  async function save(patch, msg = '已保存') {
    try {
      await api.saveSettings(patch);
      s = await api.settings();
      store.settings = s;
      toast(msg, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ---------------------------------------------------------------- 成员

  function membersCard() {
    return h('div', { class: 'section' },
      h('div', { class: 'section-title' }, '家庭成员',
        h('span', { style: { flex: '1' } }),
        h('button', { class: 'btn sm', onclick: () => editMember(null) }, '＋ 添加')),
      h('div', { class: 'card pad' },
        store.members.map((m) =>
          h('div', { class: 'setting-row' },
            h('span', { style: { fontSize: '22px' } }, m.emoji),
            h('div', { style: { flex: '1' } },
              h('div', { style: { fontWeight: '600' } }, m.name),
              h('div', { class: 'desc' }, `已读 ${m.counts['已读']} · 在读 ${m.counts['在读']} · 待读 ${m.counts['待读']}`)
            ),
            h('span', { style: { width: '16px', height: '16px', borderRadius: '50%', background: m.color } }),
            h('button', { class: 'icon-btn', onclick: () => editMember(m) }, '✎')
          )
        )
      )
    );
  }

  async function editMember(m) {
    const f = form([
      { name: 'name', label: '称呼', value: (m && m.name) || '' },
      { type: 'group', fields: [
        { name: 'emoji', label: '头像（emoji）', value: (m && m.emoji) || '📖' },
        { name: 'color', label: '代表色', type: 'color', value: (m && m.color) || '#4f8cff' },
      ] },
    ]);
    const actions = [{ label: '取消', value: 'cancel', class: 'ghost' }];
    if (m) actions.push({ label: '删除', value: 'delete', class: 'danger' });
    actions.push({ label: '保存', value: 'save', class: 'primary' });

    const act = await modal({ title: m ? '编辑成员' : '添加成员', body: f.node, actions });
    if (!act || act === 'cancel') return;
    try {
      if (act === 'delete') {
        if (!(await confirmBox(`删除「${m.name}」？他的阅读记录和笔记署名会一起删掉。`))) return;
        await api.deleteMember(m.id);
      } else {
        const v = f.values();
        if (!v.name) return toast('得有个称呼', 'err');
        if (m) await api.updateMember(m.id, v);
        else await api.createMember(v);
      }
      await store.refreshMembers();
      toast('已保存', 'ok');
      paint();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ---------------------------------------------------------------- 通用

  function generalCard() {
    const nameInput = h('input', { value: s.library_name || '', style: inputStyle() });
    return h('div', { class: 'section' },
      h('div', { class: 'section-title' }, '基本'),
      h('div', { class: 'card pad' },
        h('div', { class: 'setting-row' },
          h('div', { style: { flex: '1' } },
            h('div', { style: { fontWeight: '600' } }, '书库名字'),
            h('div', { class: 'desc' }, '显示在左上角和浏览器标题')
          ),
          nameInput,
          h('button', {
            class: 'btn sm', onclick: () => save({ library_name: nameInput.value.trim() || '我们家的图书馆' }),
          }, '保存')
        )
      )
    );
  }


  // ---------------------------------------------------------------- 拍照识别

  function photoCard() {
    const box = h('div', { class: 'card pad' }, h('div', { class: 'muted small' }, '加载中…'));

    api.ocrStatus().then((st) => {
      const engineSel = h('select', { class: 'set-select', style: inputStyle() },
        [
          ['auto', '自动（配了 AI 就用 AI，否则本地）'],
          ['vision', '只用 AI 视觉模型'],
          ['local', '只用本地识别（离线）'],
        ].map(([v, l]) => h('option', { value: v, selected: st.engine === v || undefined }, l))
      );
      engineSel.addEventListener('change', () => save({ ocr_engine: engineSel.value }));

      const baseInput = h('input', { value: s.vision_base_url || '', style: inputStyle() });
      const modelInput = h('input', { value: s.vision_model || '', style: inputStyle() });
      const keyInput = h('input', {
        type: 'password',
        placeholder: s.vision_api_key_set ? '已保存（留空则不改）' : '粘贴 API Key',
        style: inputStyle(),
      });
      const visionToggle = h('input', { type: 'checkbox', checked: s.vision_enabled === '1' || undefined });
      visionToggle.addEventListener('change', () =>
        save({ vision_enabled: visionToggle.checked ? '1' : '0' }, visionToggle.checked ? '已启用 AI 识别' : '已关闭 AI 识别'));

      const presetSel = h('select', { class: 'set-select', style: inputStyle() },
        [h('option', { value: '' }, '选一个厂商自动填…'),
         ...st.presets.map((p) => h('option', { value: p.id }, p.name))]
      );
      const presetNote = h('div', { class: 'desc' }, '');
      presetSel.addEventListener('change', () => {
        const p = st.presets.find((x) => x.id === presetSel.value);
        if (!p) return;
        if (p.base_url) baseInput.value = p.base_url;
        if (p.model) modelInput.value = p.model;
        presetNote.innerHTML = '';
        presetNote.append(
          p.note || '',
          p.apply_url ? ' ' : '',
          p.apply_url ? h('a', { href: p.apply_url, target: '_blank', rel: 'noopener noreferrer' }, '去申请 Key') : ''
        );
      });

      const testOut = h('span', { class: 'tiny faint' });

      box.innerHTML = '';
      box.append(
        h('div', { class: 'small muted', style: { marginBottom: '10px', lineHeight: '1.7' } },
          '拍一张版权页（或 CIP 数据页），自动填书名、作者、出版社、ISBN、定价。',
          h('br'),
          '本地识别离线可用但中文容易出错，主要靠它认出 ISBN 再查书目；',
          'AI 视觉模型识别准得多，中文和「分册名」这种语义它都能分清。'),

        h('div', { class: 'setting-row' },
          h('div', { style: { flex: '1' } },
            h('div', { style: { fontWeight: '600' } }, '识别引擎'),
            h('div', { class: 'desc' },
              `本地模型${st.local_ready ? '已就绪' : '未安装（命令行执行 npm run ocr:setup）'} · ` +
              `AI ${st.vision_configured ? '已配置' : '未配置'}`)
          ),
          engineSel
        ),

        h('div', { class: 'setting-row' },
          h('div', { style: { flex: '1' } },
            h('div', { style: { fontWeight: '600' } }, '启用 AI 视觉模型'),
            h('div', { class: 'desc' }, '国内这几家都能直连、都有免费额度')
          ),
          h('label', { class: 'switch' }, visionToggle, h('span', {}))
        ),

        h('div', { style: { padding: '12px 0', borderBottom: '1px solid var(--line-soft)' } },
          h('div', { style: { fontWeight: '600', marginBottom: '6px' } }, '厂商'),
          presetSel,
          presetNote,
          h('div', { class: 'grid2', style: { marginTop: '10px' } },
            h('div', { class: 'field' }, h('label', {}, '接口地址 base_url'), baseInput),
            h('div', { class: 'field' }, h('label', {}, '模型名 model'), modelInput)
          ),
          h('div', { class: 'field' }, h('label', {}, 'API Key'), keyInput),
          h('div', { class: 'row' },
            h('button', {
              class: 'btn sm primary',
              onclick: () => {
                const patch = { vision_base_url: baseInput.value.trim(), vision_model: modelInput.value.trim() };
                if (keyInput.value.trim()) patch.vision_api_key = keyInput.value.trim();
                save(patch).then(() => { keyInput.value = ''; paint(); });
              },
            }, '保存'),
            h('button', {
              class: 'btn sm',
              onclick: async (e) => {
                e.target.disabled = true;
                testOut.textContent = '测试中…';
                try {
                  const r = await api.testVision();
                  testOut.className = r.ok ? 'tiny status-ok' : 'tiny status-bad';
                  testOut.textContent = r.message;
                } catch (err) {
                  testOut.className = 'tiny status-bad';
                  testOut.textContent = err.message;
                }
                e.target.disabled = false;
              },
            }, '测试连接'),
            testOut
          )
        )
      );
    }).catch((e) => {
      box.innerHTML = '';
      box.append(h('div', { class: 'status-bad small' }, `识别能力状态读取失败：${e.message}`));
    });

    return h('div', { class: 'section' },
      h('div', { class: 'section-title' }, '拍照识别版权页'),
      box
    );
  }

  // ---------------------------------------------------------------- 代理

  function proxyCard() {
    const urlInput = h('input', { value: s.proxy_url || '', placeholder: 'http://127.0.0.1:7897', style: inputStyle() });
    const toggle = h('input', { type: 'checkbox', checked: s.proxy_enabled === '1' || undefined });
    toggle.addEventListener('change', () => save({ proxy_enabled: toggle.checked ? '1' : '0' }, toggle.checked ? '已开启代理' : '已关闭代理'));

    const testOut = h('div', { class: 'small', style: { marginTop: '10px' } });

    return h('div', { class: 'section' },
      h('div', { class: 'section-title' }, '网络代理'),
      h('div', { class: 'card pad' },
        h('div', { class: 'setting-row' },
          h('div', { style: { flex: '1' } },
            h('div', { style: { fontWeight: '600' } }, '查书目时走代理'),
            h('div', { class: 'desc' }, 'Google Books / Open Library / Z-Library 在国内直连通常不通，开这个走本机代理')
          ),
          h('label', { class: 'switch' }, toggle, h('span', {}))
        ),
        h('div', { class: 'setting-row' },
          h('div', { style: { flex: '1' } },
            h('div', { style: { fontWeight: '600' } }, '代理地址'),
            h('div', { class: 'desc' }, 'Clash 默认 http://127.0.0.1:7890，部分版本是 7897')
          ),
          urlInput,
          h('button', { class: 'btn sm', onclick: () => save({ proxy_url: urlInput.value.trim() }) }, '保存')
        ),
        h('div', { class: 'setting-row' },
          h('div', { style: { flex: '1' } },
            h('div', { style: { fontWeight: '600' } }, '连通性自检'),
            h('div', { class: 'desc' }, '挨个试一遍各个书目来源')
          ),
          h('button', {
            class: 'btn sm',
            onclick: async (e) => {
              e.target.disabled = true;
              e.target.textContent = '测试中…';
              testOut.innerHTML = '';
              try {
                const r = await api.testNetwork();
                for (const [k, label] of [['douban', '豆瓣读书'], ['googlebooks', 'Google Books'], ['openlibrary', 'Open Library'], ['weread', '微信读书'], ['zlibrary', 'Z-Library']]) {
                  const v = r[k] || {};
                  testOut.append(h('div', { class: 'row', style: { padding: '3px 0' } },
                    h('span', { style: { width: '108px' } }, label),
                    h('span', { class: v.ok ? 'status-ok' : 'status-bad' }, v.ok ? '✓ 通' : '✗ 不通'),
                    h('span', { class: 'tiny faint' }, v.message || (v.ms ? `${v.ms}ms` : '') || v.error || '')
                  ));
                }
              } catch (err) {
                testOut.append(h('div', { class: 'status-bad' }, err.message));
              }
              e.target.disabled = false;
              e.target.textContent = '开始测试';
            },
          }, '开始测试')
        ),
        testOut
      )
    );
  }

  // ---------------------------------------------------------------- 来源

  function sourcesCard() {
    const keyInput = h('input', { value: '', placeholder: s.google_books_key_set ? '已保存（留空则不改）' : '可选，填了能避开配额限制', style: inputStyle() });
    return h('div', { class: 'section' },
      h('div', { class: 'section-title' }, '书目来源'),
      h('div', { class: 'card pad' },
        (s.providers || []).map((p) => {
          const cb = h('input', { type: 'checkbox', checked: s[p.key] === '1' || undefined });
          cb.addEventListener('change', () => save({ [p.key]: cb.checked ? '1' : '0' }));
          return h('div', { class: 'setting-row' },
            h('div', { style: { flex: '1' } },
              h('div', { style: { fontWeight: '600' } }, p.name),
              h('div', { class: 'desc' }, providerDesc(p.key))
            ),
            h('label', { class: 'switch' }, cb, h('span', {}))
          );
        }),
        h('div', { class: 'setting-row' },
          h('div', { style: { flex: '1' } },
            h('div', { style: { fontWeight: '600' } }, 'Google Books API Key'),
            h('div', { class: 'desc' }, '匿名调用共享配额，容易 429；自己申请一个就稳了')
          ),
          keyInput,
          h('button', {
            class: 'btn sm',
            onclick: () => keyInput.value.trim() && save({ google_books_key: keyInput.value.trim() }),
          }, '保存')
        )
      )
    );
  }

  function providerDesc(key) {
    return {
      source_douban: '国内直连，中文书信息最全（书名/作者/出版社/定价/评分/简介）',
      source_zlibrary: '按 ISBN 直查，需要下面填 Cookie；中英文都覆盖',
      source_googlebooks: '中英文都不错，需要能访问外网',
      source_openlibrary: '免费无需 Key，英文书全、中文书弱',
      source_weread: '国内直连，中文书名搜索最好用（不支持 ISBN）',
    }[key] || '';
  }

  // ---------------------------------------------------------------- Z-Library

  function zlibCard() {
    const baseInput = h('input', { value: s.zlib_base || '', style: inputStyle() });
    const cookieInput = h('textarea', {
      rows: 3, placeholder: s.zlib_cookie_set ? '已保存（留空则不改）' : '从浏览器开发者工具里复制 Cookie 整行粘进来',
      style: { ...inputStyle(), width: '100%', fontFamily: 'monospace', fontSize: '12px' },
    });
    const healthOut = h('span', { class: 'tiny faint' });

    return h('div', { class: 'section' },
      h('div', { class: 'section-title' }, 'Z-Library'),
      h('div', { class: 'card pad' },
        h('div', { class: 'small muted', style: { marginBottom: '10px', lineHeight: '1.7' } },
          '站点前面有浏览器验证，服务端匿名访问会被挡。两种用法：',
          h('br'),
          '① 把你登录后的 Cookie 贴进来 —— 之后扫 ISBN 就能直接从 Z-Library 取书目写进本地库；',
          h('br'),
          '② 用下面的书签小工具 —— 在 Z-Library 书籍页点一下，书目自动带回录入页。',
          h('br'),
          h('span', { class: 'faint' }, '两种方式都只取书目文字信息；书籍文件请你自己在浏览器里下载，再回来上传做在线阅读。')
        ),
        h('div', { class: 'setting-row' },
          h('div', { style: { flex: '1' } },
            h('div', { style: { fontWeight: '600' } }, '站点地址'),
            h('div', { class: 'desc' }, '镜像域名常变，打不开就换一个')
          ),
          baseInput,
          h('button', { class: 'btn sm', onclick: () => save({ zlib_base: baseInput.value.trim() }) }, '保存')
        ),
        h('div', { style: { padding: '12px 0', borderBottom: '1px solid var(--line-soft)' } },
          h('div', { style: { fontWeight: '600' } }, 'Cookie'),
          h('div', { class: 'desc', style: { marginBottom: '6px' } },
            '浏览器登录 Z-Library → F12 → Network → 任意请求 → Request Headers → 复制 cookie 整行'),
          cookieInput,
          h('div', { class: 'row', style: { marginTop: '8px' } },
            h('button', {
              class: 'btn sm',
              onclick: () => cookieInput.value.trim() && save({ zlib_cookie: cookieInput.value.trim() }, 'Cookie 已保存'),
            }, '保存 Cookie'),
            h('button', {
              class: 'btn sm ghost',
              onclick: async (e) => {
                e.target.disabled = true;
                healthOut.textContent = '检测中…';
                try {
                  const r = await api.zlibHealth();
                  healthOut.className = r.ok ? 'tiny status-ok' : 'tiny status-bad';
                  healthOut.textContent = r.message;
                } catch (err) {
                  healthOut.className = 'tiny status-bad';
                  healthOut.textContent = err.message;
                }
                e.target.disabled = false;
              },
            }, '测试连接'),
            healthOut
          )
        ),
        h('div', { style: { padding: '12px 0' } },
          h('div', { style: { fontWeight: '600' } }, '书签小工具'),
          h('div', { class: 'desc', style: { marginBottom: '8px' } },
            '把下面这段拖到浏览器书签栏（或新建书签、地址填这段）。在 Z-Library 的书籍页点它，书目会自动填进录入页。'),
          h('button', { class: 'btn sm', onclick: showBookmarklet }, '获取书签代码')
        )
      )
    );
  }

  async function showBookmarklet() {
    const { code } = await api.bookmarklet();
    const ta = h('textarea', {
      rows: 6, readonly: true,
      style: { width: '100%', fontFamily: 'monospace', fontSize: '11px', padding: '10px', borderRadius: '9px', border: '1px solid var(--line)', background: 'var(--bg-soft)' },
    }, code);
    await modal({
      title: '书签小工具',
      body: h('div', {},
        h('p', { class: 'small muted' }, '方式一：把下面这个链接拖到书签栏；方式二：复制代码，新建书签并把网址填成它。'),
        h('p', {}, h('a', {
          href: code, class: 'btn primary',
          onclick: (e) => { e.preventDefault(); toast('请把这个按钮拖到书签栏'); },
        }, '📚 存到家庭图书馆')),
        ta,
        h('button', {
          class: 'btn sm', style: { marginTop: '8px' },
          onclick: () => { navigator.clipboard.writeText(code).then(() => toast('已复制', 'ok')); },
        }, '复制代码')
      ),
      actions: [{ label: '知道了', value: true, class: 'primary' }],
    });
  }

  // ---------------------------------------------------------------- 备份

  function backupCard() {
    return h('div', { class: 'section' },
      h('div', { class: 'section-title' }, '备份与导出'),
      h('div', { class: 'card pad' },
        h('div', { class: 'row' },
          h('a', { class: 'btn sm', href: '/api/export.json' }, '导出 JSON（完整备份）'),
          h('a', { class: 'btn sm', href: '/api/export.csv' }, '导出 CSV（Excel）')
        ),
        h('div', { class: 'desc', style: { marginTop: '10px' } },
          '数据都在服务端的 data/ 目录：library.db 是数据库，covers/ 是封面，files/ 是电子书。整个目录拷走就是完整备份。')
      )
    );
  }

  function aboutCard() {
    return h('div', { class: 'section' },
      h('div', { class: 'card pad small muted' },
        h('div', {}, '手机 / 平板扫码需要 https（浏览器的硬性要求），服务默认已开自签名证书，首次访问选「继续前往」即可。'),
        h('div', { style: { marginTop: '6px' } }, '把这个页面「添加到主屏幕」，用起来跟 App 一样。')
      )
    );
  }

  function inputStyle() {
    return { padding: '7px 10px', borderRadius: '9px', border: '1px solid var(--line)', background: 'var(--bg-soft)', minWidth: '0', maxWidth: '260px' };
  }
}
