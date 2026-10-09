// Utilidades de UI: constructor de DOM seguro (sin innerHTML con datos), íconos, toasts, modales y formatos.

/** h('div', { class: 'x', onclick }, 'texto', otroNodo) — el texto siempre va como textContent. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // SOLO para íconos estáticos
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

// ── Íconos (trazos estilo Lucide, estáticos) ──
const paths = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  kanban: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 7v7M12 7v4M16 7v9"/>',
  building: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  logout: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  sparkles: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  bed: '<path d="M2 20V8M2 17h20M22 20v-7a3 3 0 0 0-3-3H10v7"/><circle cx="6" cy="12" r="2"/>',
  ruler: '<path d="M21.3 15.3 8.7 2.7a1 1 0 0 0-1.4 0L2.7 7.3a1 1 0 0 0 0 1.4l12.6 12.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z"/><path d="m7.5 10.5 2-2M10.5 13.5l2-2M13.5 16.5l2-2"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M8 14h.01M16 14h.01M9 18h6"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};

export function icon(name, cls = '') {
  return h('span', {
    class: `ic ${cls}`,
    style: { display: 'inline-flex' },
    html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ''}</svg>`,
  });
}

// ── Botones ──
export function button(label, { variant = 'ghost', size, iconName, onClick, type = 'button', title, disabled } = {}) {
  const cls = ['btn', `btn-${variant}`, size ? `btn-${size}` : ''].join(' ');
  const b = h('button', { class: cls, type, title, disabled }, iconName ? icon(iconName) : null, label);
  if (onClick) {
    b.addEventListener('click', async (e) => {
      if (b.disabled) return;
      const original = [...b.childNodes];
      b.disabled = true;
      const t = setTimeout(() => {
        clear(b).append(h('span', { class: 'spinner' }), label);
      }, 250);
      try {
        await onClick(e);
      } catch (err) {
        toast(err.message || String(err), 'error');
      } finally {
        clearTimeout(t);
        if (b.isConnected) {
          clear(b).append(...original);
          b.disabled = false;
        }
      }
    });
  }
  return b;
}

// ── Toasts ──
export function toast(message, kind = 'ok') {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, icon(kind === 'error' ? 'alert' : 'check'), message);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
}

// ── Modal ──
/** actions: (close) => [botones] */
export function modal(title, body, actions = null) {
  const close = () => overlay.remove();
  const overlay = h(
    'div',
    { class: 'overlay', onclick: (e) => e.target === overlay && close() },
    h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', style: { marginLeft: 'auto' }, onclick: close, 'aria-label': 'Cerrar' }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      actions ? h('div', { class: 'modal-foot' }, ...actions(close)) : null,
    ),
  );
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  });
  document.body.append(overlay);
  overlay.querySelector('input, textarea, select')?.focus();
  return close;
}

// ── Formularios ──
export function field(label, input, help) {
  return h('div', { class: 'field' }, h('label', {}, label), input, help ? h('div', { class: 'help' }, help) : null);
}
export const input = (attrs = {}) => h('input', { class: 'input', ...attrs });
export const textarea = (attrs = {}) => h('textarea', { class: 'textarea', ...attrs });
export function select(options, attrs = {}) {
  return h('select', { class: 'select', ...attrs }, ...options.map(([v, l]) => h('option', { value: v }, l)));
}

export function formData(form) {
  return Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
}

// ── Estados ──
export const loading = () => h('div', { class: 'loading' }, h('div', { class: 'spinner' }));
export function empty(iconName, title, text, action) {
  return h('div', { class: 'empty' }, icon(iconName), h('b', {}, title), text ? h('div', {}, text) : null, action ?? null);
}
export function chip(text, color = '') {
  return h('span', { class: `chip ${color ? `chip-${color}` : ''}` }, text);
}

// ── Formatos (es-AR) ──
const tz = 'America/Argentina/Buenos_Aires';
export function money(amount, currency = 'ARS') {
  if (amount === null || amount === undefined || amount === '') return 'Consultar';
  const n = Number(amount);
  return `${currency === 'USD' ? 'USD' : '$'} ${n.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
}
export const fmtTime = (d) => new Date(d).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz });
export const fmtDayNum = (d) => new Date(d).toLocaleDateString('es-AR', { day: '2-digit', timeZone: tz });
export const fmtMonth = (d) => new Date(d).toLocaleDateString('es-AR', { month: 'short', timeZone: tz }).replace('.', '');
export const fmtDay = (d) => new Date(d).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz });
export const fmtShort = (d) => new Date(d).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: tz });
export function relative(d) {
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return 'recién';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return `hace ${Math.floor(diff / 86400)} d`;
}
export function initials(name = '') {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || '·';
}

export const ROLE = { admin: 'Administrador', broker: 'Martillero', sales_agent: 'Asesor comercial', back_office: 'Administración' };
export const OPERATION = { sale: 'Venta', rent: 'Alquiler', temporary_rent: 'Temporario' };
