// Cliente de la API del CRM. El token vive en sessionStorage (se borra al cerrar la pestaña).
const KEY = 'crm.session';

export const session = {
  get() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; }
  },
  set(v) {
    try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch { /* modo privado */ }
  },
  clear() {
    try { sessionStorage.removeItem(KEY); } catch { /* noop */ }
  },
};

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function messageOf(body, status) {
  if (!body) return `Error ${status}`;
  if (typeof body.message === 'string') return body.message;
  if (Array.isArray(body.message)) return body.message.map((m) => m.message || m).join(' · ');
  if (body.message?.message) return body.message.message;
  return `Error ${status}`;
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const s = session.get();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(s?.token ? { Authorization: `Bearer ${s.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && s?.token) {
    session.clear();
    location.hash = '#/login';
    throw new ApiError(401, 'La sesión venció. Ingresá de nuevo.');
  }
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, messageOf(data, res.status), data);
  return data;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body: body ?? {} });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });
