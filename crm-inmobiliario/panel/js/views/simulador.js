import { get, post } from '../api.js';
import { button, chip, clear, field, fmtTime, h, icon, input, modal, toast } from '../ui.js';

const KEY = 'crm.simulator';
const SUGGESTIONS = [
  'Hola! Busco un 2 ambientes en Palermo para alquilar, hasta $600.000',
  '¿Tienen casas en venta en zona norte hasta USD 300.000?',
  'Me interesa visitarlo, ¿qué horarios tienen?',
  'Me aumentaron el alquiler y creo que está mal calculado',
  'Quiero hablar con una persona',
];
const INTENT = {
  property_search: 'Búsqueda de propiedad', visit_request: 'Pedido de visita', payment_receipt: 'Comprobante de pago',
  payment_status: 'Consulta de pagos', maintenance_request: 'Mantenimiento', contract_claim: 'Reclamo contractual',
  legal_dispute: 'Conflicto legal', renegotiation: 'Renegociación', delinquency: 'Mora', human_handoff: 'Pide una persona',
  greeting_smalltalk: 'Saludo', other: 'Otro',
};
/** Traduce errores técnicos frecuentes a un mensaje accionable. */
function friendlyError(raw = '') {
  if (/API_KEY_INVALID|API key not valid/i.test(raw)) return 'La API key de Gemini no es válida. Revisá GEMINI_API_KEY en el archivo .env y reiniciá el worker.';
  if (/RESOURCE_EXHAUSTED|quota|429/i.test(raw)) return 'Se agotó el cupo gratuito de Gemini por ahora. Probá de nuevo en unos minutos.';
  if (/No hay gemini_api_key/i.test(raw)) return 'Falta configurar GEMINI_API_KEY en el archivo .env.';
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(raw)) return 'No hay conexión con el servicio de IA. Revisá la conexión a internet del servidor.';
  const m = /"message"\s*:\s*"([^"]+)"/.exec(raw);
  return m ? m[1] : raw;
}

/** Motivo de ruteo en lenguaje claro (el técnico queda en la auditoría). */
function humanReason(reason = '', intent) {
  const [engine, detail = ''] = reason.split(/:\s(.*)/s);
  if (engine === 'gemini') return `Consulta de atención general: la resuelve Gemini${intent ? ` (${(INTENT[intent] ?? intent).toLowerCase()})` : ''}.`;
  if (engine === 'human') return 'El cliente pidió hablar con una persona: el asistente deja de responder.';
  if (engine === 'claude') {
    if (detail.startsWith('patrón legal')) return 'Detectó lenguaje legal (carta documento, abogado, desalojo…): pasa al especialista.';
    if (detail.startsWith('sentimiento hostil')) return 'Detectó un tono hostil: pasa al especialista para cuidar la respuesta.';
    if (detail.startsWith('intent=')) return `Tema sensible (${(INTENT[detail.slice(7)] ?? detail.slice(7)).toLowerCase()}): lo analiza el especialista.`;
    return 'Caso sensible: lo analiza el especialista.';
  }
  return reason;
}

const TOOL = { search_properties: 'buscó propiedades', get_account_status: 'consultó la cuenta', get_visit_slots: 'buscó horarios', book_visit: 'reservó una visita' };

function load() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; }
}
function save(s) {
  try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* noop */ }
}
function newSession(name = 'Cliente de prueba') {
  const s = { sessionId: crypto.randomUUID(), contactName: name, conversationId: null };
  save(s);
  return s;
}

export async function renderSimulador({ content, actions }) {
  let state = load() ?? newSession();
  let data = { messages: [], decisions: [], humanTakeover: false, lastError: null };
  let waitingSince = 0;
  let timer = null;

  const chat = h('div', { class: 'chat', 'aria-live': 'polite' });
  const trace = h('div', { class: 'trace' });
  const statusLine = h('span', {}, 'en línea');
  const nameEl = h('b', {}, state.contactName);
  const avatarEl = h('div', { class: 'avatar' }, state.contactName[0]?.toUpperCase() ?? 'C');
  const releaseBtn = button('Devolver al bot', {
    size: 'sm',
    variant: 'ghost',
    iconName: 'bot',
    onClick: async () => {
      await post(`/simulator/conversations/${state.conversationId}/release`);
      toast('El asistente vuelve a responder esta conversación');
      await refresh();
    },
  });
  releaseBtn.hidden = true;

  const text = input({ placeholder: 'Escribí como si fueras un cliente…', 'aria-label': 'Mensaje', autocomplete: 'off' });
  const sendBtn = h('button', { class: 'btn btn-primary', type: 'submit', 'aria-label': 'Enviar' }, icon('send'));
  const composer = h('form', { class: 'composer', onsubmit: (e) => (e.preventDefault(), send(text.value)) }, text, sendBtn);
  const suggestions = h('div', { class: 'suggestions' }, ...SUGGESTIONS.map((s) => h('button', { type: 'button', onclick: () => send(s) }, s)));

  async function send(value) {
    const msg = value.trim();
    if (!msg) return;
    text.value = '';
    sendBtn.disabled = true;
    try {
      const res = await post('/simulator/messages', { sessionId: state.sessionId, contactName: state.contactName, text: msg });
      state.conversationId = res.conversationId;
      save(state);
      await refresh();
      if (waitingSince) poll();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      sendBtn.disabled = false;
      text.focus();
    }
  }

  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await refresh().catch(() => undefined);
      if (waitingSince && Date.now() - waitingSince < 90_000) poll();
      else if (waitingSince) {
        waitingSince = 0;
        paint();
        toast('El asistente no respondió en 90 s. ¿Está corriendo el worker?', 'error');
      }
    }, 1200);
  }

  async function refresh() {
    if (!state.conversationId) return paint();
    data = await get(`/simulator/conversations/${state.conversationId}`);
    const last = data.messages.at(-1);
    const lastIn = [...data.messages].reverse().find((m) => m.direction === 'inbound');
    // Un error viejo no debe tapar una conversación que después siguió bien.
    data.showError = Boolean(data.lastError && lastIn && data.lastErrorAt && new Date(data.lastErrorAt) > new Date(lastIn.createdAt));
    const waiting = !data.humanTakeover && !data.showError && last?.direction === 'inbound';
    waitingSince = waiting ? waitingSince || Date.now() : 0;
    paint();
  }

  function paint() {
    clear(chat);
    if (!data.messages.length) {
      chat.append(
        h(
          'div',
          { class: 'empty', style: { margin: 'auto' } },
          icon('chat'),
          h('b', {}, 'Empezá una conversación'),
          h('div', {}, 'Escribí abajo o elegí uno de los ejemplos. El asistente responde como lo haría por WhatsApp.'),
        ),
      );
    }
    for (const m of data.messages) {
      const inbound = m.direction === 'inbound';
      const kind = m.author === 'agent_claude' ? 'claude' : m.author === 'human' ? 'human' : 'gemini';
      chat.append(
        h(
          'div',
          { class: `bubble ${inbound ? 'in' : `out ${kind}`}` },
          inbound ? null : h('div', { class: 'who-tag' }, icon(kind === 'human' ? 'users' : 'bot'), kind === 'claude' ? 'Especialista (Claude)' : kind === 'human' ? 'Asesor' : 'Asistente (Gemini)'),
          m.body ?? '',
          h('time', {}, fmtTime(m.createdAt)),
        ),
      );
    }
    if (waitingSince) chat.append(h('div', { class: 'typing', 'aria-label': 'El asistente está escribiendo' }, h('i'), h('i'), h('i')));
    chat.scrollTop = chat.scrollHeight;

    statusLine.textContent = data.humanTakeover ? 'derivado a una persona' : waitingSince ? 'escribiendo…' : 'en línea';
    releaseBtn.hidden = !data.humanTakeover;
    paintTrace();
  }

  function paintTrace() {
    clear(trace);
    if (data.showError) {
      trace.append(
        h(
          'div',
          { class: 'banner banner-red' },
          icon('alert'),
          h('div', {}, h('b', {}, 'El asistente no pudo responder. '), friendlyError(data.lastError)),
        ),
      );
    }
    if (data.humanTakeover) {
      trace.append(h('div', { class: 'banner banner-amber' }, icon('users'), h('div', {}, 'La conversación quedó en manos de una persona: el asistente ya no responde. Usá “Devolver al bot” para seguir probando.')));
    }

    const routes = data.decisions.filter((d) => d.task === 'route').reverse();
    if (!routes.length && !data.showError) {
      trace.append(
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'empty' }, icon('sparkles'), h('b', {}, 'Qué pensó el asistente'), h('div', {}, 'Acá vas a ver, para cada mensaje, qué entendió, qué motor eligió, por qué y qué herramientas usó.')),
        ),
      );
    }
    for (const r of routes) {
      const cls = r.rawResponse?.classification ?? {};
      const engine = r.rawResponse?.decision?.engine ?? 'gemini';
      const sameTurn = data.decisions.filter((d) => d.messageId === r.messageId && d.task !== 'route');
      const tools = sameTurn.flatMap((d) => d.toolsInvoked ?? []);
      const tokens = sameTurn.reduce((s, d) => s + (d.inputTokens ?? 0) + (d.outputTokens ?? 0), 0);
      const ms = sameTurn.reduce((s, d) => s + (d.latencyMs ?? 0), 0);
      trace.append(
        h(
          'div',
          { class: 'card trace-item' },
          h(
            'div',
            { class: 'row' },
            engine === 'claude' ? chip('Claude · especialista', 'violet') : engine === 'human' ? chip('Derivado a persona', 'amber') : chip('Gemini · atención', 'green'),
            chip(INTENT[cls.intent] ?? cls.intent ?? '—'),
            cls.sentiment === 'hostile' || cls.sentiment === 'negative' ? chip(cls.sentiment === 'hostile' ? 'Tono hostil' : 'Tono negativo', 'red') : null,
            h('span', { class: 'k', style: { marginLeft: 'auto' } }, fmtTime(r.createdAt)),
          ),
          h('div', { class: 'reason' }, humanReason(r.routingReason ?? '', cls.intent)),
          tools.length ? h('div', { class: 'tools' }, ...tools.map((t) => h('span', { class: 'tool', title: JSON.stringify(t.args) }, TOOL[t.name] ?? t.name))) : null,
          h('div', { class: 'k' }, `${tokens.toLocaleString('es-AR')} tokens · ${(ms / 1000).toFixed(1)} s · confianza ${Math.round((cls.confidence ?? 0) * 100)}%`),
        ),
      );
    }
  }

  actions.append(
    button('Nuevo chat', {
      variant: 'dark',
      iconName: 'plus',
      onClick: () => {
        const name = input({ name: 'name', value: 'Cliente de prueba', maxlength: 80 });
        modal('Nuevo chat de prueba', h('div', { style: { display: 'grid', gap: '14px' } }, field('Nombre del cliente', name, 'Se crea un contacto y un lead nuevos, como si escribiera alguien por primera vez.')), (close) => [
          button('Cancelar', { onClick: close }),
          button('Empezar', {
            variant: 'primary',
            onClick: () => {
              state = newSession(name.value.trim() || 'Cliente de prueba');
              data = { messages: [], decisions: [], humanTakeover: false, lastError: null };
              nameEl.textContent = state.contactName;
              avatarEl.textContent = state.contactName[0]?.toUpperCase() ?? 'C';
              waitingSince = 0;
              paint();
              close();
              text.focus();
            },
          }),
        ]);
      },
    }),
  );

  content.append(
    h(
      'div',
      { class: 'sim' },
      h(
        'section',
        { class: 'card phone' },
        h('div', { class: 'phone-head' }, avatarEl, h('div', {}, nameEl, statusLine), h('div', { class: 'actions' }, releaseBtn)),
        chat,
        composer,
        suggestions,
      ),
      h(
        'aside',
        {},
        h('div', { class: 'card-head', style: { padding: '0 0 12px' } }, h('h3', {}, 'Qué pensó el asistente'), h('span', { class: 'hint' }, '· cada decisión queda auditada')),
        trace,
      ),
    ),
  );

  await refresh();
  if (waitingSince) poll();
  text.focus();
  return () => clearTimeout(timer);
}
