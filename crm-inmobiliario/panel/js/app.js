import { get, post, session } from './api.js';
import { clear, h, icon, initials, ROLE, toast } from './ui.js';
import { renderInicio } from './views/inicio.js';
import { renderSimulador } from './views/simulador.js';
import { renderPipeline } from './views/pipeline.js';
import { renderPropiedades } from './views/propiedades.js';
import { renderAgenda } from './views/agenda.js';
import { renderAprobaciones } from './views/aprobaciones.js';

const root = document.getElementById('root');

const ROUTES = [
  { path: 'inicio', label: 'Inicio', icon: 'home', render: renderInicio, title: 'Inicio', sub: 'Resumen de tu inmobiliaria' },
  { path: 'simulador', label: 'Simulador de chat', icon: 'chat', render: renderSimulador, title: 'Simulador de chat', sub: 'Probá el asistente como si fueras un cliente, sin WhatsApp' },
  { path: 'pipeline', label: 'Pipeline', icon: 'kanban', render: renderPipeline, title: 'Pipeline comercial', sub: 'Arrastrá las tarjetas para mover los leads de etapa' },
  { path: 'propiedades', label: 'Propiedades', icon: 'building', render: renderPropiedades, title: 'Propiedades', sub: 'Cartera, búsqueda inteligente y fichas' },
  { path: 'agenda', label: 'Agenda', icon: 'calendar', render: renderAgenda, title: 'Agenda de visitas', sub: 'Visitas, bloqueos y calendario en el celular' },
  { path: 'aprobaciones', label: 'Aprobaciones', icon: 'shield', render: renderAprobaciones, title: 'Aprobaciones', sub: 'Mensajes sensibles que esperan tu OK antes de enviarse' },
];

let me = null;

// ── Login ─────────────────────────────────────────────────────────────
function renderLogin() {
  const error = h('div', { class: 'error-box', hidden: true });
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        const data = Object.fromEntries(new FormData(form));
        submit.disabled = true;
        try {
          const res = await post('/auth/login', { tenant: data.tenant.trim(), email: data.email.trim(), password: data.password });
          session.set({ token: res.accessToken, role: res.role });
          location.hash = '#/inicio';
          await boot();
        } catch (err) {
          error.textContent = err.status === 401 ? 'Inmobiliaria, email o contraseña incorrectos.' : err.message;
          error.hidden = false;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('div', {}, h('h1', {}, 'Ingresar'), h('p', { class: 'sub' }, 'Accedé al panel de tu inmobiliaria.')),
    error,
    h('div', { class: 'field' }, h('label', { for: 'tenant' }, 'Inmobiliaria'), h('input', { class: 'input', id: 'tenant', name: 'tenant', value: 'demo', required: true, autocomplete: 'organization' })),
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), h('input', { class: 'input', id: 'email', name: 'email', type: 'email', required: true, autocomplete: 'username', placeholder: 'admin@demo.com' })),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'Contraseña'), h('input', { class: 'input', id: 'password', name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
  );
  const submit = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Ingresar', icon('send'));
  form.append(submit);

  clear(root).append(
    h(
      'div',
      { class: 'login' },
      h(
        'section',
        { class: 'login-hero' },
        h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, 'CI'), h('div', {}, h('div', { class: 'brand-name' }, 'CRM Inmobiliario'), h('div', { class: 'brand-sub' }, 'Panel de gestión'))),
        h(
          'div',
          {},
          h('h2', {}, 'Tu inmobiliaria, ', h('em', {}, 'atendiendo 24/7'), ' con inteligencia artificial.'),
          h('p', {}, 'Leads, propiedades, visitas y alquileres en un solo lugar, con trazabilidad completa de cada decisión.'),
          h(
            'div',
            { class: 'login-points' },
            h('div', {}, icon('bot'), 'Asistente que responde, busca propiedades y agenda visitas'),
            h('div', {}, icon('kanban'), 'Pipeline comercial con asignación automática'),
            h('div', {}, icon('shield'), 'Auditoría inmutable y datos aislados por inmobiliaria'),
          ),
        ),
        h('div', { class: 'brand-sub' }, '© CRM Inmobiliario · Entorno de prueba'),
      ),
      h('section', { class: 'login-form' }, form),
    ),
  );
  form.querySelector('#email').focus();
}

// ── Layout ────────────────────────────────────────────────────────────
function shell(route) {
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'Secciones' },
    h('div', { class: 'nav-label' }, 'Gestión'),
    ...ROUTES.map((r) =>
      h(
        'a',
        { href: `#/${r.path}`, class: r.path === route.path ? 'active' : '', 'aria-current': r.path === route.path ? 'page' : null, 'data-path': r.path },
        icon(r.icon),
        r.label,
      ),
    ),
  );

  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h(
      'div',
      { class: 'brand' },
      h('div', { class: 'brand-mark' }, 'CI'),
      h('div', {}, h('div', { class: 'brand-name' }, me?.tenant?.name ?? 'CRM Inmobiliario'), h('div', { class: 'brand-sub' }, 'CRM Inmobiliario')),
    ),
    nav,
    h(
      'div',
      { class: 'sidebar-foot' },
      h('div', { class: 'avatar' }, initials(me?.user?.fullName)),
      h('div', { class: 'who' }, h('b', {}, me?.user?.fullName ?? ''), h('span', {}, ROLE[me?.user?.role] ?? '')),
      h('button', { class: 'icon-btn', title: 'Salir', 'aria-label': 'Salir', onclick: logout }, icon('logout')),
    ),
  );

  const actions = h('div', { class: 'actions' });
  const content = h('div', { class: 'content' });
  const main = h(
    'main',
    { class: 'main' },
    h('header', { class: 'topbar' }, h('div', {}, h('h1', {}, route.title), h('div', { class: 'sub' }, route.sub)), actions),
    content,
  );
  clear(root).append(h('div', { class: 'app' }, sidebar, main));
  refreshBadge(nav);
  return { content, actions };
}

async function refreshBadge(nav) {
  try {
    const drafts = await get('/agent-drafts');
    const link = nav.querySelector('[data-path="aprobaciones"]');
    if (drafts.length && link) link.append(h('span', { class: 'count' }, String(drafts.length)));
  } catch {
    /* sin permisos para ver aprobaciones */
  }
}

function logout() {
  session.clear();
  me = null;
  location.hash = '#/login';
  renderLogin();
}

let cleanup = null;
async function render() {
  if (!session.get()?.token) return renderLogin();
  const path = location.hash.replace(/^#\/?/, '').split('?')[0] || 'inicio';
  if (path === 'login') return renderLogin();
  const route = ROUTES.find((r) => r.path === path) ?? ROUTES[0];
  cleanup?.();
  cleanup = null;
  const { content, actions } = shell(route);
  try {
    cleanup = (await route.render({ content, actions, me })) ?? null;
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function boot() {
  if (!session.get()?.token) return renderLogin();
  try {
    me = await get('/me');
  } catch {
    return renderLogin();
  }
  await render();
}

window.addEventListener('hashchange', render);
boot();

