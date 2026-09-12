/**
 * 生成自签名证书。
 * 手机浏览器只有在 https（或 localhost）下才给网页开摄像头，扫码录入要用。
 * 证书里带上本机所有局域网 IP，手机直接访问 IP 就行。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const selfsigned = require('selfsigned');
const config = require('../src/config');
const { lanAddresses } = require('../src/net');

// 证书把所有网卡地址都写进去（换 Wi-Fi、插网线后仍然有效）
function lanIps() {
  return [...new Set(['127.0.0.1', ...lanAddresses().map((a) => a.ip)])];
}

function generate() {
  const ips = lanIps();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: os.hostname() },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];

  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'home-library.local' }],
    {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'subjectAltName', altNames },
      ],
    }
  );

  fs.mkdirSync(config.CERT_DIR, { recursive: true });
  fs.writeFileSync(path.join(config.CERT_DIR, 'key.pem'), pems.private);
  fs.writeFileSync(path.join(config.CERT_DIR, 'cert.pem'), pems.cert);
  console.log(`[cert] 已生成：${config.CERT_DIR}`);
  console.log(`[cert] 覆盖地址：localhost, ${ips.join(', ')}`);
  return pems;
}

if (require.main === module) generate();
module.exports = generate;
