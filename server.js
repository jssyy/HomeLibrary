/**
 * 家庭图书馆 —— 服务入口
 * 手机 / 平板 / PC 同一套响应式界面，数据全部存在本机 data/ 目录里。
 */
process.removeAllListeners('warning'); // node:sqlite 的实验性警告，眼不见为净

const express = require('express');
const fs = require('fs');
const path = require('path');

const config = require('./src/config');
const { lanAddresses, preferredAddresses } = require('./src/net');
require('./src/db'); // 建表 / 迁移
const auth = require('./src/auth');
const mailer = require('./src/services/mailer');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ------------------------------------------------------------------ 登录

// 放在 nginx / Caddy 后面时打开，才能拿到真实 IP（限流用）和 https 状态（Cookie 的 Secure）
if (config.TRUST_PROXY) app.set('trust proxy', config.TRUST_PROXY);

app.use(auth.loadUser);

// 不登录也能访问的：登录页本身、前端静态资源、账号接口
const PUBLIC = /^\/(login\.html|sw\.js|manifest\.webmanifest|favicon\.ico)$|^\/(css|js|vendor|icons)\/|^\/api\/(auth\/|health$)/;

app.use((req, res, next) => {
  if (req.user || PUBLIC.test(req.path)) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/covers/')) {
    return res.status(401).json({ error: '请先登录', code: 'AUTH_REQUIRED' });
  }
  const back = req.path.startsWith('/read/') ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
  res.redirect(`/login.html${back}`);
});

// ------------------------------------------------------------------ 静态资源

// 不设强缓存，改用 ETag 协商缓存：改完代码刷新就能看到新版；
// 手机离线访问由 Service Worker 负责缓存。
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true, index: false }));
app.use('/covers', express.static(config.COVERS_DIR, { maxAge: '30d' }));

// ------------------------------------------------------------------ API

app.use('/api', require('./src/routes/auth'));
app.use('/api', require('./src/routes/family'));
app.get('/api/health', (req, res) => res.json({ ok: true, version: require('./package.json').version }));

// 以下接口都是家庭书库里的数据，必须先加入家庭
app.use('/api', auth.requireFamily);
app.use('/api', require('./src/routes/books'));
app.use('/api', require('./src/routes/reading'));
app.use('/api', require('./src/routes/files'));
app.use('/api', require('./src/routes/meta'));
app.use('/api', require('./src/routes/ocr'));
app.use('/api', (req, res) => res.status(404).json({ error: '没有这个接口' }));

// ------------------------------------------------------------------ 页面

app.get('/read/:fileId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reader.html')));
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ------------------------------------------------------------------ 错误处理

app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err.message);
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  res.status(status).json({ error: err.message || '服务器开小差了' });
});

// ------------------------------------------------------------------ 启动

function start() {
  const proto = config.HTTPS ? 'https' : 'http';
  let server;

  if (config.HTTPS) {
    const keyFile = path.join(config.CERT_DIR, 'key.pem');
    const certFile = path.join(config.CERT_DIR, 'cert.pem');
    if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
      console.log('[cert] 没有证书，正在生成自签名证书…');
      require('./scripts/gen-cert')();
    }
    server = require('https').createServer(
      { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) },
      app
    );
  } else {
    server = require('http').createServer(app);
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const win = process.platform === 'win32';
      console.error(`\n  端口 ${config.PORT} 已被占用——多半是之前启动的服务还在跑。\n`);
      console.error('  停掉占用它的进程：');
      console.error(
        win
          ? `    Get-NetTCPConnection -LocalPort ${config.PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
          : `    lsof -ti tcp:${config.PORT} | xargs kill -9`
      );
      console.error('\n  或者换个端口启动：');
      console.error(win ? '    $env:HL_PORT=8081; npm start' : '    HL_PORT=8081 npm start');
      console.error('');
    } else if (err.code === 'EACCES') {
      console.error(`\n  没有权限监听端口 ${config.PORT}，换一个 1024 以上的端口试试。\n`);
    } else {
      console.error('\n  启动失败：', err.message, '\n');
    }
    process.exit(1);
  });

  server.listen(config.PORT, '0.0.0.0', () => {
    const preferred = preferredAddresses();
    const preferredIps = new Set(preferred.map((a) => a.ip));
    const skipped = lanAddresses().filter((a) => !preferredIps.has(a.ip));

    const lines = [
      '',
      '  📚 家庭图书馆已启动',
      '',
      `  本机：     ${proto}://localhost:${config.PORT}`,
      ...preferred.map((a) => `  手机/平板： ${proto}://${a.ip}:${config.PORT}   （${a.name}）`),
      '',
    ];

    if (skipped.length) {
      lines.push(
        `  已略过 ${skipped.length} 个虚拟网卡地址（VMware / TUN 代理之类，手机连不上）：`,
        `    ${skipped.map((a) => a.ip).join('、')}`,
        ''
      );
    }

    if (config.HTTPS) {
      lines.push('  证书是自签名的，手机首次打开会提示"不安全"，选「继续访问」即可。');
      lines.push('  摄像头扫码必须在 https 或 localhost 下才能用，所以默认开了 https。');
      lines.push('');
    }

    if (!mailer.isConfigured()) {
      lines.push('  没配 SMTP：找回密码、验证邮箱的邮件会打印在这个窗口里，复制链接打开即可。');
      lines.push('');
    } else if (!config.PUBLIC_URL) {
      lines.push('  ⚠️ 配了 SMTP 但没配 HL_PUBLIC_URL：邮件里的链接会用访问者请求里的域名，');
      lines.push('     对公网开放时请务必设置 HL_PUBLIC_URL，防止重置链接被伪造域名劫持。');
      lines.push('');
    }

    lines.push('  手机打不开？依次检查：');
    lines.push('    1) 手机和电脑连的是同一个 Wi-Fi（别连成手机热点或访客网络）');
    lines.push('    2) Windows 防火墙放行 Node —— 管理员 PowerShell 执行：');
    lines.push(`       New-NetFirewallRule -DisplayName "HomeLibrary" -Direction Inbound -Protocol TCP -LocalPort ${config.PORT} -Action Allow`);
    lines.push('    3) 路由器开了「AP 隔离 / 客户端隔离」的话，关掉它');
    lines.push('');

    console.log(lines.join('\n'));
  });
}

start();
