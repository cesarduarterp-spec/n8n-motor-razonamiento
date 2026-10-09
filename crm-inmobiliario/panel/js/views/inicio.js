import { get } from '../api.js';
import { button, empty, fmtDayNum, fmtMonth, fmtTime, h, icon, loading, money, relative } from '../ui.js';

const ACTION_LABEL = {
  CREATE: 'creó', UPDATE: 'modificó', DELETE: 'eliminó', RESTORE: 'restauró', PAYMENT_EXEC: 'registró un pago en',
  AI_INTERACTION: 'interactuó con IA en', PRIVATE_ACCESS: 'consultó datos privados de', EXPORT: 'exportó',
};
const ENTITY_LABEL = {
  leads: 'un lead', contacts: 'un contacto', properties: 'una propiedad', visits: 'una visita', messages: 'un mensaje',
  conversations: 'una conversación', payment_schedules: 'una cuota', payment_receipts: 'un comprobante', contracts: 'un contrato',
  agent_drafts: 'un borrador', developments: 'un emprendimiento', ai_decision_logs: 'una conversación', lead_requirements: 'una búsqueda',
  property_matches: 'un match', users: 'un usuario', availability_blocks: 'la agenda', channel_accounts: 'un canal',
  contact_identities: 'un contacto de canal', pipeline_stages: 'una etapa', assignment_rules: 'una regla de asignación',
  settlements: 'una liquidación', contract_parties: 'una parte de contrato', contract_documents: 'un documento',
  contract_adjustments: 'un ajuste de alquiler', listing_private_data: 'datos privados', price_lists: 'una lista de precios',
  property_units: 'una unidad', tenants: 'la inmobiliaria', tenant_secrets: 'una credencial',
};

function kpi(label, iconName, value, foot, accent = false) {
  return h('div', { class: `card kpi ${accent ? 'accent' : ''}` }, h('div', { class: 'label' }, icon(iconName), label), h('div', { class: 'value' }, value), h('div', { class: 'foot' }, foot));
}

export async function renderInicio({ content, actions }) {
  actions.append(
    button('Probar el asistente', { variant: 'primary', iconName: 'chat', onClick: () => (location.hash = '#/simulador') }),
  );
  content.append(loading());
  const d = await get('/dashboard/summary');
  content.replaceChildren();

  const k = d.kpis;
  content.append(
    h(
      'div',
      { class: 'kpis' },
      kpi('Leads abiertos', 'users', String(k.openLeads), `${k.wonLeads} ${k.wonLeads === 1 ? 'cerrado' : 'cerrados'} con éxito`, true),
      kpi('Visitas próximas', 'calendar', String(k.visitsNext7), 'en los próximos 7 días'),
      kpi('Aprobaciones', 'shield', String(k.pendingApprovals), k.pendingApprovals ? 'esperan tu revisión' : 'todo al día'),
      kpi('Cuotas en mora', 'money', String(k.overdueInstallments), k.overdueInstallments ? `${money(k.overdueAmount)} adeudado` : 'sin deudas vencidas'),
    ),
  );

  const max = Math.max(1, ...d.leadsByStage.map((s) => s.count));
  const bars = h(
    'div',
    { class: 'bars' },
    ...d.leadsByStage.map((s) =>
      h(
        'div',
        { class: 'bar-row' },
        h('span', { class: 'name' }, s.name),
        h('div', { class: 'bar-track' }, h('div', { class: `bar-fill ${s.isWon ? 'won' : s.isLost ? 'lost' : ''}`, style: { width: '0%' }, 'data-w': `${(s.count / max) * 100}%` })),
        h('span', { class: 'n' }, String(s.count)),
      ),
    ),
  );
  requestAnimationFrame(() => bars.querySelectorAll('.bar-fill').forEach((b) => (b.style.width = b.dataset.w)));

  const visits = d.upcomingVisits.length
    ? h(
        'div',
        { class: 'list' },
        ...d.upcomingVisits.map((v) => {
          return h(
            'div',
            { class: 'list-item' },
            h('div', { class: 'date-badge' }, h('b', {}, fmtDayNum(v.startsAt)), h('span', {}, fmtMonth(v.startsAt))),
            h('div', { class: 'grow' }, h('div', { class: 'title' }, `${fmtTime(v.startsAt)} · ${v.property}`), h('div', { class: 'meta' }, `${v.contact ?? 'Interesado'} con ${v.advisor}`)),
          );
        }),
      )
    : empty('calendar', 'Sin visitas agendadas', 'Cuando el asistente reserve una visita, aparece acá.');

  const ai = d.aiByEngine.filter((a) => a.engine !== 'router');
  const aiCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Asistente IA hoy')),
    h(
      'div',
      { class: 'card-body' },
      ai.length
        ? h(
            'div',
            { class: 'list' },
            ...ai.map((a) =>
              h(
                'div',
                { class: 'list-item' },
                h('span', { class: `chip ${a.engine === 'claude' ? 'chip-violet' : 'chip-green'}` }, a.engine === 'claude' ? 'Claude' : 'Gemini'),
                h('div', { class: 'grow' }, h('div', { class: 'title' }, `${a.n} ${a.n === 1 ? 'consulta' : 'consultas'}`), h('div', { class: 'meta' }, `${a.tokens.toLocaleString('es-AR')} tokens`)),
              ),
            ),
          )
        : empty('bot', 'Todavía sin actividad', 'Probalo desde el simulador de chat.'),
    ),
  );

  const activity = d.activity.length
    ? h(
        'div',
        { class: 'list' },
        ...d.activity.map((a) =>
          h(
            'div',
            { class: 'list-item' },
            h('span', { class: `chip ${a.actorType === 'agent' ? 'chip-green' : a.actorType === 'user' ? 'chip-black' : ''}` }, a.actorType === 'agent' ? a.agentId ?? 'IA' : a.actorType === 'user' ? 'Usuario' : 'Sistema'),
            h('div', { class: 'grow' }, h('div', { class: 'title' }, `${ACTION_LABEL[a.action] ?? a.action} ${ENTITY_LABEL[a.entity] ?? 'un registro'}`)),
            h('span', { class: 'meta' }, relative(a.at)),
          ),
        ),
      )
    : null;

  content.append(
    h(
      'div',
      { class: 'grid grid-3' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Leads por etapa'), h('div', { class: 'right' }, button('Ver pipeline', { size: 'sm', onClick: () => (location.hash = '#/pipeline') }))), h('div', { class: 'card-body' }, bars)),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Próximas visitas')), h('div', { class: 'card-body' }, visits)),
    ),
    h(
      'div',
      { class: 'grid grid-3' },
      activity
        ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Actividad reciente'), h('span', { class: 'hint' }, '· registro de auditoría')), h('div', { class: 'card-body' }, activity))
        : h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Cartera')), h('div', { class: 'card-body' }, h('div', { class: 'kpi', style: { padding: 0 } }, h('div', { class: 'value' }, String(k.availableProperties)), h('div', { class: 'foot' }, 'propiedades disponibles')))),
      aiCard,
    ),
  );
}
