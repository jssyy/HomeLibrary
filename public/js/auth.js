/**
 * 登录页：登录 / 注册 / 找回密码 / 重置密码 / 验证邮箱 / 创建或加入家庭。
 * 用 hash 区分：#register #forgot #reset=令牌 #verify=令牌 #family
 * 邀请链接形如 /login.html?invite=邀请码
 */
import { h, toast } from './ui.js';
import api from './api.js';

const card = document.getElementById('authCard');
const params = new URLSearchParams(location.search);
const invite = (params.get('invite') || '').trim().toUpperCase();
let cfg = { allow_register: true, mail_configured: true, invite: null };

// ------------------------------------------------------------------ 小工具

function field(label, props) {
  const input = h('input', { ...props });
  return { input, node: h('div', { class: 'field' }, h('label', {}, label), input) };
}

function errLine() {
  return h('div', { class: 'auth-err' });
}

function link(text, hash) {
  return h('a', { href: hash, onclick: (e) => { e.preventDefault(); nav(hash); } }, text);
}

/** 提交按钮：防重复点击，出错显示在 err 行里 */
function submitter(btn, err, fn) {
  return async (e) => {
    if (e) e.preventDefault();
    if (btn.disabled) return;
    err.textContent = '';
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '请稍候…';
    try {
      await fn();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}

function formBox(children, onSubmit) {
  const f = h('form', { novalidate: true }, children);
  f.addEventListener('submit', onSubmit);
  return f;
}

function show(...nodes) {
  card.innerHTML = '';
  card.append(...nodes);
  const first = card.querySelector('input');
  if (first && matchMedia('(min-width: 821px)').matches) first.focus();
}

function nav(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/** 登录成功后去哪：带 next 的回原页面，没家庭的去建家庭 */
function afterLogin(me) {
  if (!me.family) return nav('#family');
  const next = params.get('next');
  location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

const PW_HINT = '至少 8 位，包含字母和数字';

// ------------------------------------------------------------------ 各个视图

function loginView() {
  const email = field('邮箱', { type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com' });
  const pw = field('密码', { type: 'password', autocomplete: 'current-password' });
  const err = errLine();
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, '登录');
  show(
    h('h2', {}, '登录'),
    inviteNote(),
    formBox([email.node, pw.node, err, btn], submitter(btn, err, async () => {
      const me = await api.login({ email: email.input.value, password: pw.input.value, invite: invite || undefined });
      afterLogin(me);
    })),
    h('div', { class: 'auth-links' },
      link('忘记密码？', '#forgot'),
      canRegister() ? h('span', {}, '没有账号？', link('注册', '#register')) : h('span')
    )
  );
}

/** 关闭了公开注册时，持有效邀请码的人仍然可以注册 */
function canRegister() {
  return cfg.allow_register || !!cfg.invite;
}

function registerView() {
  if (!canRegister()) {
    return show(
      h('h2', {}, '暂不开放注册'),
      h('p', { class: 'lead' }, '请找家里已经注册的人，在「设置 › 家庭」里复制邀请链接发给你。'),
      h('div', { class: 'auth-links' }, link('‹ 返回登录', '#login'))
    );
  }
  const name = field('称呼', { autocomplete: 'nickname', maxlength: 20, placeholder: '家里人怎么叫你，如 爸爸 / 小明' });
  const email = field('邮箱', { type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: '用来登录和找回密码' });
  const pw = field('密码', { type: 'password', autocomplete: 'new-password', placeholder: PW_HINT });
  const err = errLine();
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, invite ? '注册并加入家庭' : '注册');
  show(
    h('h2', {}, '注册账号'),
    inviteNote(),
    formBox([name.node, email.node, pw.node, err, btn], submitter(btn, err, async () => {
      const me = await api.register({
        name: name.input.value,
        email: email.input.value,
        password: pw.input.value,
        invite: invite || undefined,
      });
      toast('注册成功', 'ok');
      afterLogin(me);
    })),
    h('div', { class: 'auth-links' }, h('span', {}, '已有账号？', link('登录', '#login')))
  );
}

function forgotView() {
  const email = field('注册时用的邮箱', { type: 'email', autocomplete: 'email', inputmode: 'email' });
  const err = errLine();
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, '发送重置邮件');
  show(
    h('h2', {}, '找回密码'),
    h('p', { class: 'lead' }, '我们会给这个邮箱发一封邮件，点里面的链接设置新密码。'),
    formBox([email.node, err, btn], submitter(btn, err, async () => {
      await api.forgot(email.input.value);
      show(
        h('h2', {}, '邮件已发出'),
        h('p', { class: 'lead' },
          `如果 ${email.input.value.trim()} 注册过，重置邮件已经发过去了，1 小时内有效。没看到的话翻翻垃圾邮件。`),
        cfg.mail_configured
          ? null
          : h('div', { class: 'auth-note' }, '这台服务器还没配置发信，邮件内容打印在服务端的命令行窗口里，请找管理员要链接。'),
        h('div', { class: 'auth-links' }, link('‹ 返回登录', '#login'))
      );
    })),
    h('div', { class: 'auth-links' }, link('‹ 返回登录', '#login'))
  );
}

async function resetView(token) {
  show(h('p', { class: 'muted' }, '正在检查链接…'));
  let info;
  try {
    info = await api.checkReset(token);
  } catch (e) {
    return show(
      h('h2', {}, '链接失效了'),
      h('p', { class: 'lead' }, e.message),
      h('a', { class: 'btn primary block', href: '#forgot' }, '重新申请'),
      h('div', { class: 'auth-links' }, link('‹ 返回登录', '#login'))
    );
  }
  const pw = field('新密码', { type: 'password', autocomplete: 'new-password', placeholder: PW_HINT });
  const pw2 = field('再输一遍', { type: 'password', autocomplete: 'new-password' });
  const err = errLine();
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, '保存新密码');
  show(
    h('h2', {}, '设置新密码'),
    h('p', { class: 'lead' }, `账号：${info.email}。改完后其它设备上的登录会失效。`),
    formBox([pw.node, pw2.node, err, btn], submitter(btn, err, async () => {
      if (pw.input.value !== pw2.input.value) throw new Error('两次输入的密码不一样');
      const me = await api.resetPassword(token, pw.input.value);
      history.replaceState(null, '', location.pathname + location.search); // 令牌别留在地址栏
      toast('密码已更新', 'ok');
      afterLogin(me);
    }))
  );
}

async function verifyView(token) {
  show(h('p', { class: 'muted' }, '正在验证邮箱…'));
  history.replaceState(null, '', location.pathname + location.search);
  try {
    await api.verifyEmail(token);
    show(
      h('h2', {}, '邮箱已验证 ✓'),
      h('p', { class: 'lead' }, '以后忘记密码，就能通过这个邮箱找回。'),
      h('a', { class: 'btn primary block', href: '/' }, '进入书库')
    );
  } catch (e) {
    show(
      h('h2', {}, '验证没成功'),
      h('p', { class: 'lead' }, e.message),
      h('a', { class: 'btn primary block', href: '/' }, '进入书库')
    );
  }
}

async function familyView() {
  let me;
  try {
    me = await api.me();
  } catch {
    return nav('#login');
  }
  if (me.family) return afterLogin(me);

  const logoutLink = h('a', {
    href: '#',
    onclick: async (e) => {
      e.preventDefault();
      await api.logout().catch(() => {});
      nav('#login');
    },
  }, '换个账号');

  const choose = () =>
    show(
      h('h2', {}, `${me.user.name}，欢迎！`),
      h('p', { class: 'lead' }, '书库是按家庭共享的。你可以新建一个家庭，再把家里人邀请进来；或者用家里人给的邀请码加入。'),
      h('div', { class: 'auth-choice' },
        h('button', { class: 'opt', onclick: createForm },
          h('span', { class: 'ico' }, '🏠'),
          h('span', {}, h('div', { style: { fontWeight: '650' } }, '新建家庭'), h('div', { class: 'tiny faint' }, '你会成为家庭创建者，可以邀请和管理成员'))
        ),
        h('button', { class: 'opt', onclick: () => joinForm('') },
          h('span', { class: 'ico' }, '🔑'),
          h('span', {}, h('div', { style: { fontWeight: '650' } }, '用邀请码加入'), h('div', { class: 'tiny faint' }, '在家里人的「设置 › 家庭」里能看到邀请码'))
        )
      ),
      h('div', { class: 'auth-links' }, h('span'), logoutLink)
    );

  const createForm = () => {
    const name = field('家庭名字', { maxlength: 30, value: `${me.user.name}家的图书馆` });
    const err = errLine();
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, '创建');
    show(
      h('h2', {}, '新建家庭'),
      h('p', { class: 'lead' }, '名字会显示在书库左上角，之后可以改。'),
      formBox([name.node, err, btn], submitter(btn, err, async () => {
        await api.createFamily(name.input.value);
        location.href = '/';
      })),
      h('div', { class: 'auth-links' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); choose(); } }, '‹ 返回'))
    );
  };

  const joinForm = (code) => {
    const input = field('邀请码', { value: code, autocapitalize: 'characters', autocomplete: 'off', maxlength: 12, style: { letterSpacing: '.15em', textTransform: 'uppercase' } });
    const preview = h('div', { class: 'small muted', style: { minHeight: '20px', marginTop: '-6px', marginBottom: '8px' } });
    const err = errLine();
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, '加入');
    let timer;
    const check = () => {
      clearTimeout(timer);
      preview.textContent = '';
      const v = input.input.value.trim();
      if (v.length < 6) return;
      timer = setTimeout(async () => {
        try {
          const p = await api.previewInvite(v);
          preview.textContent = `将加入「${p.name}」（${p.member_count} 人）`;
        } catch (e) {
          preview.textContent = e.message;
        }
      }, 350);
    };
    input.input.addEventListener('input', check);
    show(
      h('h2', {}, '加入家庭'),
      h('p', { class: 'lead' }, '加入后就能看到这个家庭的全部藏书，并记录你自己的阅读进度。'),
      formBox([input.node, preview, err, btn], submitter(btn, err, async () => {
        await api.joinFamily(input.input.value);
        location.href = '/';
      })),
      h('div', { class: 'auth-links' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); choose(); } }, '‹ 返回'))
    );
    if (code) check();
  };

  if (invite) joinForm(invite);
  else choose();
}

function inviteNote() {
  if (!invite) return null;
  if (!cfg.invite) return h('div', { class: 'auth-note' }, '邀请码无效或已经被重置了，找家里人要一个新的邀请链接。');
  return h('div', { class: 'auth-note' }, `你收到了「${cfg.invite.family_name}」的邀请，登录或注册后自动加入。`);
}

// ------------------------------------------------------------------ 路由

async function render() {
  const raw = location.hash.replace(/^#/, '');
  const [key, value] = raw.split('=');
  if (key === 'reset' && value) return resetView(value);
  if (key === 'verify' && value) return verifyView(value);
  if (key === 'family') return familyView();
  if (key === 'register') return registerView();
  if (key === 'forgot') return forgotView();
  return loginView();
}

async function boot() {
  try {
    cfg = await api.authConfig(invite || undefined);
  } catch {
    /* 连不上也先把表单画出来 */
  }
  // 已经登录的：没家庭去建家庭，有家庭直接进书库（重置/验证链接除外）
  if (!/^#(reset|verify)=/.test(location.hash)) {
    try {
      const me = await api.me();
      if (!me.family) {
        if (location.hash !== '#family') return nav('#family');
      } else if (!invite) {
        return afterLogin(me);
      } else {
        toast(`你已经在「${me.family.name}」里了，要换家庭请先在设置里退出`, 'err');
        setTimeout(() => afterLogin(me), 1800);
        return;
      }
    } catch {
      /* 没登录，正常显示 */
    }
  }
  // 拿着邀请链接来的多半还没账号，直接给注册表单（替换地址不触发 hashchange）
  if (!location.hash && invite && canRegister()) history.replaceState(null, '', '#register');
  window.addEventListener('hashchange', render);
  render();
}

boot();
