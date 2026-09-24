/** 后端接口封装 */

async function req(method, url, body, opts = {}) {
  const init = { method, headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    // 登录过期 / 被移出家庭：回登录页（登录页自己的请求不跳，免得死循环）
    const code = data && data.code;
    if ((code === 'AUTH_REQUIRED' || code === 'FAMILY_REQUIRED') && location.pathname !== '/login.html') {
      location.href = code === 'AUTH_REQUIRED' ? '/login.html' : '/login.html#family';
    }
    const err = new Error((data && data.error) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const qs = (params = {}) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const api = {
  // 账号
  authConfig: (invite) => req('GET', `/api/auth/config${qs({ invite })}`),
  me: () => req('GET', '/api/auth/me'),
  register: (d) => req('POST', '/api/auth/register', d),
  login: (d) => req('POST', '/api/auth/login', d),
  logout: () => req('POST', '/api/auth/logout'),
  forgot: (email) => req('POST', '/api/auth/forgot', { email }),
  checkReset: (token) => req('GET', `/api/auth/reset/check${qs({ token })}`),
  resetPassword: (token, password) => req('POST', '/api/auth/reset', { token, password }),
  verifyEmail: (token) => req('POST', '/api/auth/verify', { token }),
  resendVerify: () => req('POST', '/api/auth/verify/resend'),
  updateProfile: (d) => req('PUT', '/api/auth/profile', d),
  changePassword: (d) => req('PUT', '/api/auth/password', d),

  // 家庭
  family: () => req('GET', '/api/family'),
  createFamily: (name) => req('POST', '/api/family', { name }),
  previewInvite: (code) => req('GET', `/api/family/invite/${encodeURIComponent(code)}`),
  joinFamily: (code) => req('POST', '/api/family/join', { code }),
  renameFamily: (name) => req('PUT', '/api/family', { name }),
  resetInvite: () => req('POST', '/api/family/invite/reset'),
  removeAccount: (userId) => req('DELETE', `/api/family/accounts/${userId}`),
  transferFamily: (userId) => req('POST', '/api/family/transfer', { user_id: userId }),
  leaveFamily: () => req('POST', '/api/family/leave'),
  dissolveFamily: (confirm) => req('DELETE', '/api/family', { confirm }),

  // 书
  books: (params) => req('GET', `/api/books${qs(params)}`),
  facets: () => req('GET', '/api/books/facets'),
  book: (id) => req('GET', `/api/books/${id}`),
  createBook: (data) => req('POST', '/api/books', data),
  updateBook: (id, data) => req('PUT', `/api/books/${id}`, data),
  deleteBook: (id) => req('DELETE', `/api/books/${id}`),
  refreshBook: (id) => req('POST', `/api/books/${id}/refresh`),

  // 查书目
  lookup: (q, sources) => req('GET', `/api/lookup${qs({ q, sources })}`),
  isbn: (code) => req('GET', `/api/isbn/${encodeURIComponent(code)}`),
  zlibSearch: (q) => req('GET', `/api/zlib/search${qs({ q })}`),
  zlibHealth: () => req('GET', '/api/zlib/health'),
  zlibUrl: (params) => req('GET', `/api/zlib/url${qs(params)}`),
  bookmarklet: () => req('GET', `/api/zlib/bookmarklet${qs({ origin: location.origin })}`),

  // 成员 / 阅读
  members: () => req('GET', '/api/members'),
  createMember: (d) => req('POST', '/api/members', d),
  updateMember: (id, d) => req('PUT', `/api/members/${id}`, d),
  deleteMember: (id) => req('DELETE', `/api/members/${id}`),
  setReading: (bookId, memberId, d) => req('PUT', `/api/books/${bookId}/readings/${memberId}`, d),
  currentReading: (member) => req('GET', `/api/reading/current${qs({ member })}`),
  addLog: (bookId, d) => req('POST', `/api/books/${bookId}/logs`, d),

  // 购买
  purchases: (params) => req('GET', `/api/purchases${qs(params)}`),
  addPurchase: (bookId, d) => req('POST', `/api/books/${bookId}/purchases`, d),
  updatePurchase: (id, d) => req('PUT', `/api/purchases/${id}`, d),
  deletePurchase: (id) => req('DELETE', `/api/purchases/${id}`),

  // 笔记
  notes: (params) => req('GET', `/api/notes${qs(params)}`),
  addNote: (bookId, d) => req('POST', `/api/books/${bookId}/notes`, d),
  updateNote: (id, d) => req('PUT', `/api/notes/${id}`, d),
  deleteNote: (id) => req('DELETE', `/api/notes/${id}`),

  // 文件
  file: (id) => req('GET', `/api/files/${id}`),
  uploadFiles: (bookId, formData) => req('POST', `/api/books/${bookId}/files`, formData),
  deleteFile: (id) => req('DELETE', `/api/files/${id}`),
  uploadCover: (bookId, formData) => req('POST', `/api/books/${bookId}/cover`, formData),

  // 拍照识别
  ocrBook: (formData) => req('POST', '/api/ocr/book', formData),
  ocrStatus: () => req('GET', '/api/ocr/status'),
  testVision: () => req('GET', '/api/ocr/test-vision'),

  // 其它
  stats: (year) => req('GET', `/api/stats${qs({ year })}`),
  settings: () => req('GET', '/api/settings'),
  saveSettings: (d) => req('PUT', '/api/settings', d),
  testNetwork: () => req('GET', '/api/settings/test'),
};

export default api;
