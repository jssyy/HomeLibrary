/** ISBN 规范化与校验（扫码枪/摄像头读到的 EAN-13 就是 ISBN13） */

function clean(raw) {
  return String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

function isValidIsbn10(s) {
  if (!/^[0-9]{9}[0-9X]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(s[i]);
  sum += s[9] === 'X' ? 10 : Number(s[9]);
  return sum % 11 === 0;
}

function isValidIsbn13(s) {
  if (!/^[0-9]{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(s[12]);
}

function to13(s) {
  s = clean(s);
  if (isValidIsbn13(s)) return s;
  if (isValidIsbn10(s)) {
    const core = '978' + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
    return core + String((10 - (sum % 10)) % 10);
  }
  return null;
}

function to10(s) {
  s = clean(s);
  if (isValidIsbn10(s)) return s;
  if (isValidIsbn13(s) && s.startsWith('978')) {
    const core = s.slice(3, 12);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += (10 - i) * Number(core[i]);
    const check = (11 - (sum % 11)) % 11;
    return core + (check === 10 ? 'X' : String(check));
  }
  return null;
}

/** 是否是一个可用的 ISBN（10 或 13 位） */
function isIsbn(raw) {
  const s = clean(raw);
  return isValidIsbn10(s) || isValidIsbn13(s);
}

function format(s) {
  const v = clean(s);
  if (v.length === 13) return `${v.slice(0, 3)}-${v.slice(3, 4)}-${v.slice(4, 8)}-${v.slice(8, 12)}-${v.slice(12)}`;
  return v;
}

module.exports = { clean, isIsbn, isValidIsbn10, isValidIsbn13, to13, to10, format };
