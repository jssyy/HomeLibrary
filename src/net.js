/**
 * 挑出手机真正能访问的局域网地址。
 *
 * 机器上常常同时存在一堆虚拟网卡（VMware、Hyper-V、VirtualBox、WSL、
 * Clash/TUN 的 198.18.x、Docker、VPN…），它们的地址手机是连不上的。
 * 默认路由也不可靠——开了 TUN 代理时默认路由指向的正是虚拟网卡。
 * 所以这里按网卡名、MAC 厂商前缀和网段特征来判断。
 */
const os = require('os');

// 网卡名里出现这些词的，基本都是虚拟网卡
const VIRTUAL_NAME =
  /vmware|vmnet|virtualbox|vbox|hyper-?v|vethernet|loopback|tap|tun|meta|clash|surge|tailscale|zerotier|docker|wsl|npcap|bluetooth|vpn|utun|ppp|teredo|isatap|虚拟/i;

// 虚拟机厂商的 MAC 前缀
const VIRTUAL_MAC = [
  '00:50:56', '00:0c:29', '00:05:69', '00:1c:14', // VMware
  '08:00:27', '0a:00:27',                          // VirtualBox
  '00:15:5d',                                      // Hyper-V
  '00:00:00',                                      // 伪造/占位
];

// 物理网卡的常见命名
const PHYSICAL_NAME = /wlan|wi-?fi|wireless|ethernet|以太网|无线|本地连接|^en\d|^eth\d|^wl/i;

function isVirtualAddress(ip) {
  return (
    ip.startsWith('198.18.') || ip.startsWith('198.19.') || // 基准测试网段，Clash TUN 常用
    ip.startsWith('169.254.') ||                            // 链路本地（没拿到 DHCP）
    ip.startsWith('127.')
  );
}

function isPrivate(ip) {
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('10.')) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/**
 * @returns {Array<{ip:string,name:string,virtual:boolean,score:number}>} 按可用性排序
 */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;

      const mac = String(ni.mac || '').toLowerCase();
      let score = 0;
      let virtual = false;

      if (VIRTUAL_NAME.test(name)) { virtual = true; score -= 50; }
      if (VIRTUAL_MAC.some((p) => mac.startsWith(p))) { virtual = true; score -= 40; }
      if (isVirtualAddress(ni.address)) { virtual = true; score -= 60; }
      // 虚拟网卡的网关一般就是自己（x.x.x.1），物理网卡拿到的是 DHCP 地址
      if (virtual && ni.address.endsWith('.1')) score -= 5;

      if (PHYSICAL_NAME.test(name)) score += 30;
      if (isPrivate(ni.address)) score += 20;
      if (/^192\.168\./.test(ni.address)) score += 5; // 家用路由器最常见的网段

      out.push({ ip: ni.address, name, virtual: virtual || score < 0, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 推荐给手机用的地址（可能有多个，比如有线+无线都插着） */
function preferredAddresses() {
  const all = lanAddresses();
  const real = all.filter((a) => !a.virtual);
  return real.length ? real : all; // 一个都判不出来时，宁可全列出来
}

module.exports = { lanAddresses, preferredAddresses };
