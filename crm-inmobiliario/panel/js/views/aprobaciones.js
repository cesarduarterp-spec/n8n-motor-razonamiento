import { get, post } from '../api.js';
import { button, chip, empty, h, icon, loading, relative, textarea, toast } from '../ui.js';

const KIND = {
  reply: ['Respuesta a cliente', 'black'],
  late_payment_notice: ['Aviso de mora', 'amber'],
  formal_notice: ['Intimación formal', 'red'],
  renegotiation_proposal: ['Propuesta de renegociación', 'violet'],
};
const RISK = { low: ['Riesgo bajo', 'green'], medium: ['Riesgo medio', 'amber'], high: ['Riesgo alto', 'red'] };

export async function renderAprobaciones({ content, actions, me }) {
  const canApprove = me?.user?.role === 'admin' || me?.user?.role === 'broker';
  actions.append(button('Actualizar', { iconName: 'refresh', onClick: () => load() }));

  const intro = h(
    'div',
    { class: 'banner banner-green' },
    icon('shield'),
    h('div', {}, 'Lo que el especialista legal (Claude) redacta con riesgo —avisos de mora, intimaciones, respuestas a reclamos— nunca sale solo: espera acá tu revisión. Podés editar el texto antes de aprobar.'),
  );
  const list = h('div', { class: 'grid' });
  content.append(intro, list);

  async function load() {
    list.replaceChildren(loading());
    let drafts;
    try {
      drafts = await get('/agent-drafts');
    } catch (err) {
      list.replaceChildren(h('div', { class: 'error-box' }, err.status === 403 ? 'Tu rol no tiene acceso a las aprobaciones.' : err.message));
      return;
    }
    if (!drafts.length) {
      list.replaceChildren(h('div', { class: 'card' }, empty('inbox', 'Nada pendiente', 'Cuando el asistente derive un caso sensible, el borrador aparece acá.')));
      return;
    }
    list.replaceChildren(...drafts.map(card));
  }

  function card(d) {
    const [kindLabel, kindColor] = KIND[d.kind] ?? [d.kind, ''];
    const [riskLabel, riskColor] = RISK[d.riskLevel] ?? ['', ''];
    const text = textarea({ value: d.content, rows: Math.min(14, Math.max(4, d.content.split('\n').length + 1)), 'aria-label': 'Texto a enviar', disabled: !canApprove });
    text.value = d.content;
    return h(
      'article',
      { class: 'card draft' },
      h('div', { class: 'row' }, chip(kindLabel, kindColor), riskLabel ? chip(riskLabel, riskColor) : null, h('span', { class: 'k', style: { marginLeft: 'auto', color: 'var(--muted)', fontSize: '12.5px' } }, relative(d.createdAt))),
      d.rationale ? h('div', { class: 'rationale' }, h('b', {}, 'Análisis del especialista: '), d.rationale) : null,
      text,
      canApprove
        ? h(
            'div',
            { class: 'actions' },
            button('Rechazar', {
              variant: 'danger',
              iconName: 'x',
              onClick: async () => {
                await post(`/agent-drafts/${d.id}/reject`);
                toast('Borrador rechazado');
                await load();
              },
            }),
            button(d.conversationId ? 'Aprobar y enviar' : 'Aprobar', {
              variant: 'primary',
              iconName: 'check',
              onClick: async () => {
                const edited = text.value.trim();
                await post(`/agent-drafts/${d.id}/approve`, edited !== d.content ? { content: edited } : {});
                toast(d.conversationId ? 'Aprobado y enviado al cliente' : 'Aprobado');
                await load();
              },
            }),
          )
        : h('div', { class: 'k', style: { color: 'var(--muted)', fontSize: '12.5px' } }, 'Solo un administrador o martillero puede aprobar.'),
    );
  }

  await load();
}
