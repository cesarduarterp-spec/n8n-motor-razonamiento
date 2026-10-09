import { get, patch, post } from '../api.js';
import { button, chip, field, formData, h, icon, initials, input, loading, modal, relative, select, textarea, toast } from '../ui.js';

export async function renderPipeline({ content, actions }) {
  actions.append(
    button('Actualizar', { iconName: 'refresh', onClick: () => load() }),
    button('Nuevo lead', { variant: 'primary', iconName: 'plus', onClick: () => newLead() }),
  );

  const board = h('div', { class: 'board' });
  const help = h(
    'div',
    { class: 'banner banner-green' },
    icon('sparkles'),
    h('div', {}, 'Los leads del simulador y de WhatsApp entran solos en “Nuevo lead” y se asignan por round-robin. El asistente los avanza cuando detecta una búsqueda o agenda una visita.'),
  );
  content.append(help, board);

  let stages = [];

  async function load() {
    board.replaceChildren(loading());
    stages = await get('/pipeline');
    paint();
  }

  function paint() {
    board.replaceChildren(
      ...stages.map((s) => {
        const col = h(
          'section',
          { class: `col ${s.isWon ? 'won' : s.isLost ? 'lost' : ''}`, 'data-stage': s.id, 'aria-label': s.name },
          h('div', { class: 'col-head' }, h('span', { class: 'bullet' }), h('b', {}, s.name), h('span', { class: 'n' }, String(s.leads.length))),
          ...s.leads.map((l) => card(l)),
          s.leads.length ? null : h('div', { class: 'k', style: { textAlign: 'center', color: 'var(--muted-2)', fontSize: '12.5px', padding: '18px 0' } }, 'Soltá un lead acá'),
        );
        col.addEventListener('dragover', (e) => {
          e.preventDefault();
          col.classList.add('drop');
        });
        col.addEventListener('dragleave', () => col.classList.remove('drop'));
        col.addEventListener('drop', (e) => {
          e.preventDefault();
          col.classList.remove('drop');
          const leadId = e.dataTransfer.getData('text/lead');
          if (leadId) move(leadId, s);
        });
        return col;
      }),
    );
  }

  function card(l) {
    const el = h(
      'article',
      { class: 'lead', draggable: 'true', 'data-id': l.id },
      h('div', { class: 'name' }, l.contactName ?? 'Sin nombre', l.slaBreached ? chip('SLA vencido', 'red') : null),
      l.requirements ? h('div', { class: 'req' }, l.requirements) : l.phone ? h('div', { class: 'req' }, l.phone) : null,
      h(
        'div',
        { class: 'foot' },
        l.assignedTo ? h('span', { class: 'avatar', title: l.assignedTo }, initials(l.assignedTo)) : chip('Sin asignar', 'amber'),
        l.assignedTo ? h('span', {}, l.assignedTo.split(' ')[0]) : null,
        l.sourceChannel ? chip(l.sourceChannel === 'web' ? 'Simulador' : l.sourceChannel) : null,
        h('span', { class: 'right' }, l.stageChangedAt ? relative(l.stageChangedAt) : ''),
      ),
    );
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/lead', l.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('click', () => detail(l));
    el.title = 'Clic para ver detalle, sugerencias y mover de etapa';
    return el;
  }

  async function move(leadId, target) {
    const from = stages.find((s) => s.leads.some((l) => l.id === leadId));
    const lead = from?.leads.find((l) => l.id === leadId);
    if (!lead || from.id === target.id) return;
    // Movimiento optimista; si otro usuario lo cambió (409) se recarga el tablero.
    from.leads = from.leads.filter((l) => l.id !== leadId);
    target.leads = [lead, ...target.leads];
    paint();
    try {
      const res = await patch(`/leads/${leadId}/stage`, { stageId: target.id, expectedVersion: lead.version });
      lead.version = res.version;
      lead.stageChangedAt = new Date().toISOString();
      toast(`${lead.contactName ?? 'Lead'} → ${target.name}`);
    } catch (err) {
      toast(err.status === 409 ? 'Otro usuario modificó este lead. Recargamos el tablero.' : err.message, 'error');
      await load();
    }
  }

  async function detail(l) {
    const box = h('div', { style: { display: 'grid', gap: '14px' } }, loading());
    modal(l.contactName ?? 'Lead', box);
    try {
      const matches = await get(`/leads/${l.id}/matches`);
      const stageSel = select(stages.map((s) => [s.id, s.name]), { 'aria-label': 'Etapa' });
      stageSel.value = l.stageId;
      box.replaceChildren(
        h('div', { class: 'toolbar' }, stageSel, button('Mover', { variant: 'dark', size: 'sm', onClick: async () => {
          const target = stages.find((s) => s.id === stageSel.value);
          if (target) await move(l.id, target);
        } })),
        h('div', { class: 'k' }, l.requirements || 'Sin requerimientos cargados todavía.'),
        h('h4', {}, 'Propiedades sugeridas'),
        matches.length
          ? h(
              'div',
              { class: 'list' },
              ...matches.map((m) =>
                h(
                  'div',
                  { class: 'list-item' },
                  chip(`${Math.round(Number(m.match.score) * 100)}%`, 'green'),
                  h('div', { class: 'grow' }, h('div', { class: 'title' }, `${m.code} · ${m.title}`), h('div', { class: 'meta' }, (m.match.reasons ?? []).join(' · '))),
                ),
              ),
            )
          : h('div', { class: 'k' }, 'Sin coincidencias aún. Se calculan cuando el lead cuenta qué busca.'),
      );
    } catch (err) {
      box.replaceChildren(h('div', { class: 'error-box' }, err.message));
    }
  }

  function newLead() {
    const form = h(
      'form',
      { class: 'form-grid', id: 'new-lead' },
      field('Nombre y apellido', input({ name: 'fullName', required: true, placeholder: 'Carla Gómez' })),
      field('WhatsApp', input({ name: 'phone', placeholder: '+5491155550000', pattern: '\\+\\d{8,15}' }), 'Formato internacional, opcional'),
      field('Operación', select([['', 'Indistinto'], ['rent', 'Alquiler'], ['sale', 'Compra'], ['temporary_rent', 'Temporario']], { name: 'operation' })),
      field('Zona', input({ name: 'neighborhood', placeholder: 'Palermo' })),
      field('Presupuesto máximo', input({ name: 'maxPrice', type: 'number', min: '0', placeholder: '600000' })),
      field('Moneda', select([['ARS', 'Pesos'], ['USD', 'Dólares']], { name: 'currency' })),
      h('div', { class: 'full' }, field('¿Qué busca?', textarea({ name: 'naturalLanguage', placeholder: 'Ej.: 2 ambientes luminoso, apto mascotas, cerca del subte' }), 'Se usa para el matching inteligente con la cartera.')),
    );
    modal('Nuevo lead', form, (close) => [
      button('Cancelar', { onClick: close }),
      button('Crear y asignar', {
        variant: 'primary',
        iconName: 'check',
        onClick: async () => {
          if (!form.reportValidity()) return;
          const d = formData(form);
          const hasReq = d.operation || d.neighborhood || d.maxPrice || d.naturalLanguage;
          const res = await post('/leads', {
            fullName: d.fullName,
            ...(d.phone ? { phoneE164: d.phone } : {}),
            ...(hasReq
              ? {
                  requirements: {
                    ...(d.operation ? { operation: d.operation } : {}),
                    ...(d.neighborhood ? { neighborhoods: [d.neighborhood] } : {}),
                    ...(d.maxPrice ? { maxPrice: Number(d.maxPrice), currency: d.currency } : {}),
                    ...(d.naturalLanguage ? { naturalLanguage: d.naturalLanguage } : {}),
                  },
                }
              : {}),
          });
          close();
          toast(res.assignedUserId ? 'Lead creado y asignado' : 'Lead creado (no hay asesores para asignar)');
          await load();
        },
      }),
    ]);
  }

  await load();
}
