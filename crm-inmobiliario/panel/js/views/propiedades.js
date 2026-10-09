import { get, post } from '../api.js';
import { button, chip, empty, field, formData, h, icon, input, loading, modal, money, OPERATION, select, textarea, toast } from '../ui.js';

const STATUS = { available: ['Disponible', 'green'], reserved: ['Reservada', 'amber'], rented: ['Alquilada', 'black'], sold: ['Vendida', 'black'], paused: ['Pausada', ''], draft: ['Borrador', ''] };

export async function renderPropiedades({ content, actions }) {
  let operation = '';
  let query = '';

  actions.append(button('Nueva propiedad', { variant: 'primary', iconName: 'plus', onClick: () => create() }));

  const searchInput = input({ type: 'search', placeholder: 'Buscá como lo diría un cliente: “depto luminoso cerca del subte que acepte mascotas”', 'aria-label': 'Búsqueda inteligente' });
  const searchForm = h(
    'form',
    { class: 'search', onsubmit: (e) => (e.preventDefault(), (query = searchInput.value.trim()), load()) },
    icon('search'),
    searchInput,
  );
  const seg = h(
    'div',
    { class: 'segmented', role: 'tablist' },
    ...[['', 'Todas'], ['rent', 'Alquiler'], ['sale', 'Venta'], ['temporary_rent', 'Temporario']].map(([v, l]) =>
      h('button', { type: 'button', class: v === operation ? 'on' : '', onclick: (e) => {
        operation = v;
        seg.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
        e.currentTarget.classList.add('on');
        load();
      } }, l),
    ),
  );
  const info = h('div', { class: 'k', style: { color: 'var(--muted)' } });
  const grid = h('div', { class: 'props' });
  content.append(h('div', { class: 'toolbar' }, searchForm, seg), info, grid);

  async function load() {
    grid.replaceChildren(loading());
    try {
      let items;
      if (query) {
        const params = new URLSearchParams({ q: query, ...(operation ? { operation } : {}) });
        items = await get(`/properties/search?${params}`);
        info.textContent = `Resultados para “${query}”, ordenados por afinidad semántica.`;
        info.append(' ', h('a', { href: '#', onclick: (e) => (e.preventDefault(), (query = ''), (searchInput.value = ''), load()) }, 'Ver todas'));
      } else {
        items = await get(`/properties${operation ? `?operation=${operation}` : ''}`);
        info.textContent = `${items.length} ${items.length === 1 ? 'propiedad' : 'propiedades'} en cartera.`;
      }
      paint(items);
    } catch (err) {
      grid.replaceChildren(h('div', { class: 'error-box' }, err.message));
    }
  }

  function paint(items) {
    if (!items.length) {
      grid.replaceChildren(
        h('div', { class: 'card', style: { gridColumn: '1 / -1' } }, empty('building', query ? 'Sin coincidencias' : 'Todavía no hay propiedades', query ? 'Probá describirlo de otra forma.' : 'Cargá la primera y el asistente ya puede ofrecerla.', query ? null : button('Nueva propiedad', { variant: 'primary', iconName: 'plus', onClick: () => create() }))),
      );
      return;
    }
    grid.replaceChildren(...items.map(cardOf));
  }

  function cardOf(p) {
    const photo = (p.media ?? []).find((m) => m.type === 'photo')?.url;
    const [statusLabel, statusColor] = STATUS[p.status] ?? ['', ''];
    const score = p.distance !== undefined ? Math.round((1 - Number(p.distance)) * 100) : null;
    return h(
      'article',
      { class: 'card prop' },
      h(
        'div',
        { class: 'prop-img' },
        photo ? h('img', { src: photo, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : icon('building'),
        statusLabel ? chip(statusLabel, statusColor) : chip(OPERATION[p.operation] ?? p.operation, 'black'),
        score !== null ? h('span', { class: 'chip chip-green score' }, `${score}% afinidad`) : null,
      ),
      h(
        'div',
        { class: 'prop-body' },
        h('div', { class: 'prop-price' }, money(p.price, p.currency)),
        h('div', { class: 'prop-title' }, p.title),
        h(
          'div',
          { class: 'prop-meta' },
          h('span', {}, icon('pin'), p.neighborhood ?? '—'),
          p.bedrooms != null ? h('span', {}, icon('bed'), `${p.bedrooms} dorm.`) : null,
          p.coveredM2 ? h('span', {}, icon('ruler'), `${Number(p.coveredM2)} m²`) : null,
          h('span', {}, `${OPERATION[p.operation] ?? ''} · ${p.code}`),
        ),
      ),
      h(
        'div',
        { class: 'prop-actions' },
        button('Ficha', { size: 'sm', variant: 'dark', iconName: 'file', onClick: () => openFicha(p, 'public') }),
        button('Neutra', { size: 'sm', iconName: 'eye', title: 'Ficha neutra para colegas (sin tu marca ni contacto)', onClick: () => openFicha(p, 'neutral') }),
        button('Interesados', { size: 'sm', iconName: 'users', onClick: () => interested(p) }),
      ),
    );
  }

  /** Abre la ficha con un link firmado (válido 30 días) que también sirve para compartir. */
  async function openFicha(p, variant) {
    const win = window.open('about:blank', '_blank'); // se abre antes del await para que no lo bloquee el navegador
    try {
      const { url } = await post(`/properties/${p.id}/ficha-links?variant=${variant}`);
      if (win) win.location.href = url;
      const pdf = `${url}?format=pdf`;
      modal(
        variant === 'neutral' ? 'Ficha neutra lista para colegas' : 'Ficha pública lista',
        h(
          'div',
          { style: { display: 'grid', gap: '14px' } },
          h('div', { class: 'k' }, variant === 'neutral' ? 'Sin tu marca, sin datos de contacto ni dirección exacta. Ideal para compartir en la red de colegas.' : 'Con tu marca y datos de contacto. Ideal para enviar a clientes.'),
          h('div', { class: 'copy-box' }, input({ value: url, readonly: true, 'aria-label': 'Link' }), button('Copiar', { iconName: 'copy', onClick: async () => (await navigator.clipboard.writeText(url), toast('Link copiado')) })),
          h('div', { class: 'toolbar' }, h('a', { class: 'btn btn-dark', href: url, target: '_blank', rel: 'noopener' }, icon('eye'), 'Ver web'), h('a', { class: 'btn btn-ghost', href: pdf, target: '_blank', rel: 'noopener' }, icon('file'), 'Descargar PDF')),
        ),
      );
    } catch (err) {
      win?.close();
      toast(err.message, 'error');
    }
  }

  async function interested(p) {
    const box = h('div', {}, loading());
    modal(`Interesados en ${p.code}`, box);
    try {
      const leads = await post(`/properties/${p.id}/matching-leads`);
      box.replaceChildren(
        leads.length
          ? h(
              'div',
              { class: 'list' },
              ...leads.map((m) =>
                h('div', { class: 'list-item' }, chip(`${Math.round(m.score * 100)}%`, 'green'), h('div', { class: 'grow' }, h('div', { class: 'title' }, m.contactName ?? `Lead ${m.leadId.slice(0, 8)}`), h('div', { class: 'meta' }, [m.phone, ...(m.reasons ?? [])].filter(Boolean).join(' · ')))),
              ),
            )
          : empty('users', 'Sin leads afines por ahora', 'Cuando un cliente busque algo parecido, aparece acá.'),
      );
    } catch (err) {
      box.replaceChildren(h('div', { class: 'error-box' }, err.message));
    }
  }

  function create() {
    const form = h(
      'form',
      { class: 'form-grid' },
      field('Código', input({ name: 'code', required: true, placeholder: 'PAL-101' })),
      field('Operación', select([['rent', 'Alquiler'], ['sale', 'Venta'], ['temporary_rent', 'Temporario']], { name: 'operation' })),
      h('div', { class: 'full' }, field('Título', input({ name: 'title', required: true, minlength: 3, placeholder: '2 ambientes luminoso con balcón' }))),
      field('Tipo', select([['departamento', 'Departamento'], ['casa', 'Casa'], ['ph', 'PH'], ['local', 'Local'], ['oficina', 'Oficina'], ['lote', 'Lote']], { name: 'propertyType' })),
      field('Barrio / zona', input({ name: 'neighborhood', placeholder: 'Palermo' })),
      field('Precio', input({ name: 'price', type: 'number', min: '0', placeholder: '550000' })),
      field('Moneda', select([['ARS', 'Pesos'], ['USD', 'Dólares']], { name: 'currency' })),
      field('Dormitorios', input({ name: 'bedrooms', type: 'number', min: '0' })),
      field('m² cubiertos', input({ name: 'coveredM2', type: 'number', min: '0' })),
      h('div', { class: 'full' }, field('Foto (URL https)', input({ name: 'photo', type: 'url', placeholder: 'https://…/foto.jpg' }))),
      h('div', { class: 'full' }, field('Descripción', textarea({ name: 'description', placeholder: 'Al frente, a 3 cuadras del subte D, apto mascotas…' }), 'Cuanto más completa, mejor la búsqueda inteligente y las respuestas del asistente.')),
    );
    modal('Nueva propiedad', form, (close) => [
      button('Cancelar', { onClick: close }),
      button('Guardar', {
        variant: 'primary',
        iconName: 'check',
        onClick: async () => {
          if (!form.reportValidity()) return;
          const d = formData(form);
          await post('/properties', {
            code: d.code,
            title: d.title,
            operation: d.operation,
            propertyType: d.propertyType,
            status: 'available',
            neighborhood: d.neighborhood || undefined,
            price: d.price ? Number(d.price) : undefined,
            currency: d.currency,
            bedrooms: d.bedrooms ? Number(d.bedrooms) : undefined,
            coveredM2: d.coveredM2 ? Number(d.coveredM2) : undefined,
            description: d.description || undefined,
            media: d.photo ? [{ type: 'photo', url: d.photo }] : [],
          });
          close();
          toast('Propiedad cargada');
          await load();
        },
      }),
    ]);
  }

  await load();
}
