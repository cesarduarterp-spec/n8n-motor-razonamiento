import { del, get, post, put } from '../api.js';
import { button, chip, empty, field, fmtDay, fmtTime, h, icon, input, loading, modal, toast } from '../ui.js';

const TZ_OFFSET = '-03:00';

export async function renderAgenda({ content, actions }) {
  actions.append(
    button('Bloquear horario', { variant: 'dark', iconName: 'ban', onClick: () => block() }),
    button('Ver en mi celular', { variant: 'primary', iconName: 'phone', onClick: () => phone() }),
  );

  const visitsBox = h('div', { class: 'card-body' }, loading());
  const blocksBox = h('div', { class: 'card-body' }, loading());
  content.append(
    h(
      'div',
      { class: 'grid grid-3' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Próximas visitas'), h('span', { class: 'hint' }, '· 14 días')), visitsBox),
      h(
        'div',
        { class: 'grid', style: { alignContent: 'start' } },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Mis bloqueos')), blocksBox),
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, 'Mi calendario personal')),
          h(
            'div',
            { class: 'card-body', style: { display: 'grid', gap: '12px' } },
            h('div', { class: 'k', style: { color: 'var(--muted)', fontSize: '13px' } }, 'Opcional: pegá la “dirección secreta en formato iCal” de tu Google Calendar para que el asistente no te ofrezca horarios en los que ya estás ocupado. Es de solo lectura y se guarda cifrada.'),
            button('Conectar calendario', { iconName: 'link', onClick: () => external() }),
          ),
        ),
      ),
    ),
  );

  async function loadVisits() {
    const list = await get('/visits?days=14');
    if (!list.length) {
      visitsBox.replaceChildren(empty('calendar', 'No hay visitas en los próximos días', 'Las reservas del asistente (o las manuales) aparecen acá al instante.'));
      return;
    }
    const groups = new Map();
    for (const v of list) {
      const day = fmtDay(v.startsAt);
      groups.set(day, [...(groups.get(day) ?? []), v]);
    }
    visitsBox.replaceChildren(
      ...[...groups.entries()].map(([day, items]) =>
        h(
          'div',
          { class: 'day-group' },
          h('div', { class: 'day-title' }, day),
          ...items.map((v) =>
            h(
              'div',
              { class: 'visit' },
              h('div', { class: 'bar' }),
              h('div', { class: 'time' }, fmtTime(v.startsAt)),
              h(
                'div',
                { class: 'grow', style: { flex: 1, minWidth: 0 } },
                h('div', { class: 'title', style: { fontWeight: 600 } }, `${v.code} · ${v.property}`),
                h('div', { class: 'meta', style: { color: 'var(--muted)', fontSize: '12.5px' } }, [v.contact, v.phone, `con ${v.advisor}`].filter(Boolean).join(' · ')),
              ),
              v.bookedBy?.startsWith('agent:') ? chip('Agendó el asistente', 'green') : chip('Manual'),
              button('', {
                size: 'sm',
                variant: 'danger',
                iconName: 'x',
                title: 'Cancelar visita',
                onClick: async () => {
                  if (!confirm('¿Cancelar esta visita?')) return;
                  await post(`/visits/${v.id}/cancel`, { reason: 'Cancelada desde el panel' });
                  toast('Visita cancelada');
                  await loadVisits();
                },
              }),
            ),
          ),
        ),
      ),
    );
  }

  async function loadBlocks() {
    const list = await get('/agenda/blocks');
    blocksBox.replaceChildren(
      list.length
        ? h(
            'div',
            { class: 'list' },
            ...list.map((b) =>
              h(
                'div',
                { class: 'list-item' },
                h('div', { class: 'grow' }, h('div', { class: 'title' }, b.reason || 'No disponible'), h('div', { class: 'meta' }, `${fmtDay(b.startsAt)} · ${fmtTime(b.startsAt)} a ${fmtTime(b.endsAt)}`)),
                button('', {
                  size: 'sm',
                  iconName: 'trash',
                  title: 'Quitar bloqueo',
                  onClick: async () => {
                    await del(`/agenda/blocks/${b.id}`);
                    toast('Bloqueo eliminado');
                    await loadBlocks();
                  },
                }),
              ),
            ),
          )
        : h('div', { class: 'k', style: { color: 'var(--muted)', fontSize: '13px' } }, 'Sin bloqueos. Usá “Bloquear horario” para vacaciones, trámites o reuniones.'),
    );
  }

  function block() {
    // Por defecto: mañana (un bloqueo de hoy a la mañana ya pasado no tendría efecto).
    const tomorrow = new Date(Date.now() + 86_400_000 - 3 * 3_600_000).toISOString().slice(0, 10);
    const date = input({ type: 'date', name: 'date', value: tomorrow, min: new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10), required: true });
    const from = input({ type: 'time', name: 'from', value: '09:00', required: true });
    const to = input({ type: 'time', name: 'to', value: '13:00', required: true });
    const reason = input({ name: 'reason', placeholder: 'Trámite, vacaciones, reunión…', maxlength: 200 });
    const form = h('form', { class: 'form-grid' }, h('div', { class: 'full' }, field('Día', date)), field('Desde', from), field('Hasta', to), h('div', { class: 'full' }, field('Motivo (opcional)', reason)));
    modal('Bloquear horario', form, (close) => [
      button('Cancelar', { onClick: close }),
      button('Bloquear', {
        variant: 'primary',
        iconName: 'ban',
        onClick: async () => {
          if (!form.reportValidity()) return;
          const startsAt = `${date.value}T${from.value}:00${TZ_OFFSET}`;
          const endsAt = `${date.value}T${to.value}:00${TZ_OFFSET}`;
          if (new Date(endsAt) <= new Date(startsAt)) throw new Error('La hora de fin tiene que ser posterior a la de inicio');
          if (new Date(endsAt) <= new Date()) throw new Error('Ese horario ya pasó: elegí uno futuro');
          await post('/agenda/blocks', {
            startsAt,
            endsAt,
            reason: reason.value || undefined,
          });
          close();
          toast('Horario bloqueado: el asistente no lo va a ofrecer');
          await loadBlocks();
        },
      }),
    ]);
  }

  async function phone() {
    const { url, webcal } = await post('/agenda/feed-link');
    const isLocal = /localhost|127\.0\.0\.1/.test(url);
    modal(
      'Tus visitas en el celular',
      h(
        'div',
        { style: { display: 'grid', gap: '16px' } },
        h('div', { class: 'copy-box' }, input({ value: url, readonly: true, 'aria-label': 'Link iCal' }), button('Copiar', { variant: 'primary', iconName: 'copy', onClick: async () => (await navigator.clipboard.writeText(url), toast('Link copiado')) })),
        isLocal
          ? h('div', { class: 'banner banner-amber' }, icon('alert'), h('div', {}, 'Este link apunta a localhost: Google no puede leerlo. Activá el túnel de ngrok (PRUEBA.md, sección 6) para que funcione desde el celular.'))
          : null,
        h(
          'ol',
          { class: 'steps' },
          h('li', {}, h('b', {}, 'Google Calendar (web): '), 'Otros calendarios → + → Desde URL → pegá el link.'),
          h('li', {}, h('b', {}, 'iPhone: '), 'Ajustes → Calendario → Cuentas → Añadir cuenta → Otra → Añadir calendario suscrito.'),
          h('li', {}, 'Las visitas nuevas aparecen solas. Google puede tardar unas horas en actualizar; Apple y Outlook, minutos.'),
        ),
        h('div', { class: 'toolbar' }, h('a', { class: 'btn btn-dark', href: webcal }, icon('calendar'), 'Abrir en mi calendario')),
        h('div', { class: 'k', style: { color: 'var(--muted)', fontSize: '12.5px' } }, 'Generamos un link nuevo cada vez que abrís esta ventana: el anterior deja de funcionar.'),
      ),
    );
  }

  function external() {
    const url = input({ type: 'url', name: 'url', required: true, placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics' });
    const form = h(
      'form',
      { style: { display: 'grid', gap: '14px' } },
      h('ol', { class: 'steps' }, h('li', {}, 'Abrí Google Calendar en la computadora → ⚙️ Configuración.'), h('li', {}, 'Elegí tu calendario → “Integrar el calendario”.'), h('li', {}, 'Copiá la “Dirección secreta en formato iCal” y pegala acá.')),
      field('Dirección secreta iCal', url),
    );
    modal('Conectar mi calendario personal', form, (close) => [
      button('Desconectar', {
        variant: 'danger',
        onClick: async () => {
          await del('/agenda/external-calendar');
          close();
          toast('Calendario desconectado');
        },
      }),
      button('Conectar', {
        variant: 'primary',
        iconName: 'link',
        onClick: async () => {
          if (!form.reportValidity()) return;
          const res = await put('/agenda/external-calendar', { url: url.value });
          close();
          toast(`Calendario conectado · ${res.busySlotsNext14Days} compromisos en las próximas 2 semanas`);
        },
      }),
    ]);
  }

  await Promise.all([loadVisits(), loadBlocks()]);
}
