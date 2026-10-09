// Enlaces cortos de WhatsApp con seguimiento, en Cloudflare Workers.
//
// Capas de respaldo:
//  1. La redirección nunca depende del registro: si algo falla, igual se envía a WhatsApp.
//  2. Si un enlace no existe o KV falla, se envía al TELEFONO_RESPALDO (nunca un enlace muerto).
//  3. Cada clic se guarda en D1 (base de datos de Cloudflare) y se reenvía a n8n por lotes cada minuto.
//     Si n8n está caído, los clics quedan pendientes en D1 y se reintentan solos.
//  4. Si D1 falla al guardar, el clic se envía directo a n8n.

import PANEL_HTML from '../../whatsapp-link-tracker/panel.html';

const RESERVADOS = new Set(['api', 'admin', 'robots.txt', 'favicon.ico']);
const CAMPOS_CLIC = [
  'id_clic', 'fecha', 'dia', 'hora', 'slug', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content',
  'ref', 'dispositivo', 'sistema', 'navegador', 'app_origen', 'pais', 'region', 'ciudad', 'latitud',
  'longitud', 'proveedor_internet', 'idioma', 'referer', 'visitante_id',
];
const LOTE_SYNC = 500;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ruta = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
    const primero = ruta.split('/')[0].toLowerCase();

    try {
      if (primero === 'api') return await api(request, env, url, ruta.split('/').slice(1));
      if (primero === 'admin') return panel();
    } catch (e) {
      console.error('Error en API/panel', e);
      return json({ ok: false, error: 'Error interno' }, 500);
    }

    if (primero === 'robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } });
    if (primero === 'favicon.ico') return new Response(null, { status: 204 });
    if (!ruta) return redireccion(env.SITIO_WEB || destinoRespaldo(env, ''));

    return redirigirEnlace(request, env, ctx, slugify(ruta.split('/')[0]), url.searchParams);
  },

  async scheduled(_evento, env, ctx) {
    ctx.waitUntil(sincronizarConN8n(env));
  },
};

// ---------------------------------------------------------------- redirección

async function redirigirEnlace(request, env, ctx, slug, query) {
  let enlace = null;
  try {
    enlace = await env.LINKS.get(clave(slug), { type: 'json', cacheTtl: 60 });
  } catch (e) {
    console.error('KV no disponible, uso respaldo', e);
  }

  if (!enlace || enlace.activo === false) return redireccion(destinoRespaldo(env, slug));

  const ref = query.get('ref') || slug;
  let mensaje = enlace.mensaje || '';
  if (env.AGREGAR_REFERENCIA !== 'false') mensaje = `${mensaje} (ref: ${ref})`.trim();

  if (request.method === 'GET') {
    ctx.waitUntil(registrarClic(request, env, slug, enlace, query).catch(e => console.error('No se pudo registrar el clic', e)));
  }
  return redireccion(enlaceWhatsApp(enlace.telefono, mensaje));
}

function destinoRespaldo(env, slug) {
  if (env.TELEFONO_RESPALDO) {
    const msg = env.MENSAJE_RESPALDO || 'Hola! Quiero más información';
    return enlaceWhatsApp(env.TELEFONO_RESPALDO, slug && env.AGREGAR_REFERENCIA !== 'false' ? `${msg} (ref: ${slug})` : msg);
  }
  return env.DESTINO_POR_DEFECTO || 'https://www.whatsapp.com';
}

function enlaceWhatsApp(telefono, mensaje) {
  const tel = String(telefono || '').replace(/\D/g, '');
  return `https://wa.me/${tel}` + (mensaje ? `?text=${encodeURIComponent(mensaje)}` : '');
}

function redireccion(destino) {
  return new Response(null, {
    status: 302,
    headers: { Location: destino, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

// ---------------------------------------------------------------- registro de clics

async function registrarClic(request, env, slug, enlace, query) {
  const h = request.headers;
  const ua = h.get('user-agent') || '';
  const info = analizarUA(ua);
  if (info.esBot) return;

  const cf = request.cf || {};
  const ip = h.get('cf-connecting-ip') || '';
  const utm = k => String(query.get(k) || enlace[k] || '').toLowerCase();

  const clic = {
    id_clic: crypto.randomUUID(),
    ...fechaLocal(env.ZONA_HORARIA || 'UTC'),
    slug,
    utm_source: utm('utm_source'),
    utm_medium: utm('utm_medium'),
    utm_campaign: utm('utm_campaign'),
    utm_content: utm('utm_content'),
    ref: query.get('ref') || '',
    dispositivo: info.dispositivo,
    sistema: info.sistema,
    navegador: info.navegador,
    app_origen: info.app_origen,
    pais: nombrePais(cf.country),
    region: cf.region || '',
    ciudad: cf.city || '',
    latitud: cf.latitude || '',
    longitud: cf.longitude || '',
    proveedor_internet: cf.asOrganization || '',
    idioma: (h.get('accept-language') || '').split(',')[0],
    referer: h.get('referer') || '',
    visitante_id: await hashVisitante(ip, ua, env.ADMIN_KEY || ''),
  };

  try {
    await env.DB.prepare(
      `INSERT INTO clics (${CAMPOS_CLIC.join(',')}) VALUES (${CAMPOS_CLIC.map(() => '?').join(',')})`,
    ).bind(...CAMPOS_CLIC.map(c => String(clic[c] ?? ''))).run();
  } catch (e) {
    console.error('D1 no disponible, envío el clic directo a n8n', e);
    await enviarAN8n(env, [clic]);
  }
}

export function analizarUA(ua) {
  const p = re => re.test(ua);
  return {
    esBot: !ua || p(/bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|WhatsApp\/|TelegramBot|Twitterbot|Slackbot|LinkedInBot|Discordbot|Pinterest\/|Googlebot|bingbot|preview|HeadlessChrome|curl|wget|python-requests|axios|node-fetch/i),
    dispositivo:
      p(/iPad|Tablet|PlayBook|Silk/i) || (p(/Android/i) && !p(/Mobile/i)) ? 'Tablet'
      : p(/Mobi|iPhone|iPod|Android|Windows Phone/i) ? 'Móvil'
      : 'Escritorio',
    sistema:
      p(/iPhone|iPad|iPod/i) ? 'iOS'
      : p(/Android/i) ? 'Android'
      : p(/Windows/i) ? 'Windows'
      : p(/CrOS/i) ? 'ChromeOS'
      : p(/Mac OS X|Macintosh/i) ? 'macOS'
      : p(/Linux/i) ? 'Linux'
      : 'Otro',
    app_origen:
      p(/Instagram/i) ? 'Instagram'
      : p(/FBAN|FBAV|FB_IAB|FBIOS/i) ? 'Facebook'
      : p(/musical_ly|TikTok|BytedanceWebview|trill/i) ? 'TikTok'
      : p(/LinkedInApp/i) ? 'LinkedIn'
      : p(/Twitter/i) ? 'X / Twitter'
      : p(/Snapchat/i) ? 'Snapchat'
      : p(/Pinterest/i) ? 'Pinterest'
      : p(/Telegram/i) ? 'Telegram'
      : p(/GSA\//i) ? 'Google App'
      : 'Navegador',
    navegador:
      p(/Edg\//i) ? 'Edge'
      : p(/OPR\/|Opera/i) ? 'Opera'
      : p(/SamsungBrowser/i) ? 'Samsung Internet'
      : p(/Firefox|FxiOS/i) ? 'Firefox'
      : p(/Chrome|CriOS/i) ? 'Chrome'
      : p(/Safari|AppleWebKit/i) ? 'Safari'
      : 'Otro',
  };
}

function fechaLocal(zona) {
  let partes;
  try {
    partes = new Intl.DateTimeFormat('en-CA', {
      timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
  } catch {
    return fechaLocal('UTC');
  }
  const p = Object.fromEntries(partes.map(x => [x.type, x.value]));
  const dia = `${p.year}-${p.month}-${p.day}`;
  return { fecha: `${dia} ${p.hour}:${p.minute}:${p.second}`, dia, hora: p.hour };
}

function nombrePais(codigo) {
  if (!codigo) return 'Desconocido';
  try { return new Intl.DisplayNames(['es'], { type: 'region' }).of(codigo) || codigo; } catch { return codigo; }
}

async function hashVisitante(ip, ua, sal) {
  const datos = new TextEncoder().encode(`${sal}|${ip}|${ua}`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', datos));
  return [...h.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- sincronización con n8n

async function enviarAN8n(env, clics) {
  if (!env.N8N_CLICS_URL || !clics.length) return false;
  try {
    const r = await fetch(env.N8N_CLICS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Clave': env.N8N_CLAVE || '' },
      body: JSON.stringify({ clics }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) console.error('n8n respondió', r.status);
    return r.ok;
  } catch (e) {
    console.error('n8n no disponible', e);
    return false;
  }
}

export async function sincronizarConN8n(env) {
  if (!env.N8N_CLICS_URL) return { enviados: 0 };
  let enviados = 0;
  for (let vuelta = 0; vuelta < 5; vuelta++) {
    const { results } = await env.DB.prepare(
      `SELECT id, ${CAMPOS_CLIC.join(',')} FROM clics WHERE enviado = 0 ORDER BY id LIMIT ?`,
    ).bind(LOTE_SYNC).all();
    if (!results.length) break;

    const ok = await enviarAN8n(env, results.map(({ id, ...resto }) => resto));
    if (!ok) break;  // se reintenta en el próximo minuto

    // Los ids son crecientes: todo pendiente con id <= al último enviado ya fue incluido en este lote
    await env.DB.prepare('UPDATE clics SET enviado = 1 WHERE enviado = 0 AND id <= ?')
      .bind(results[results.length - 1].id).run();
    enviados += results.length;
    if (results.length < LOTE_SYNC) break;
  }
  return { enviados };
}

// ---------------------------------------------------------------- API de administración

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function json(datos, status = 200) {
  return new Response(JSON.stringify(datos), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

async function autorizado(request, env) {
  const dada = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const esperada = env.ADMIN_KEY || '';
  if (!esperada || dada.length !== esperada.length) return false;
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(dada), enc.encode(esperada));
}

async function api(request, env, url, partes) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!(await autorizado(request, env))) return json({ ok: false, error: 'Clave incorrecta' }, 401);

  const [recurso, id] = partes;
  const m = request.method;

  if (recurso === 'links' && id === 'importar' && m === 'POST') return importarEnlaces(request, env);
  if (recurso === 'links' && !id && m === 'GET') return json({ ok: true, enlaces: await listarEnlaces(env, url.searchParams.get('completo') === '1') });
  if (recurso === 'links' && !id && m === 'POST') return guardarEnlace(env, await leerJson(request), url, false);
  if (recurso === 'links' && id && m === 'PUT') return guardarEnlace(env, { ...(await leerJson(request)), slug: id }, url, true);
  if (recurso === 'links' && id && m === 'DELETE') {
    await env.LINKS.delete(clave(slugify(id)));
    return json({ ok: true });
  }
  if (recurso === 'stats' && m === 'GET') return json(await estadisticas(env, url.searchParams));
  if (recurso === 'salud' && m === 'GET') return json(await salud(env));
  if (recurso === 'sincronizar' && m === 'POST') return json({ ok: true, ...(await sincronizarConN8n(env)) });

  return json({ ok: false, error: 'Ruta no encontrada' }, 404);
}

async function leerJson(request) {
  try { return await request.json(); } catch { return {}; }
}

const clave = slug => `l:${slug}`;
const limpiar = v => String(v ?? '').trim();
export const slugify = s => limpiar(s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function validarEnlace(b) {
  const slug = slugify(b.slug || b.nombre);
  const telefono = limpiar(b.telefono).replace(/\D/g, '');
  if (!slug) return { error: 'Falta el nombre del enlace (slug)' };
  if (RESERVADOS.has(slug)) return { error: `"${slug}" es un nombre reservado` };
  if (telefono.length < 8 || telefono.length > 15) {
    return { error: 'Teléfono inválido: usa formato internacional sin +, ej: 5491122334455' };
  }
  return {
    enlace: {
      slug, telefono,
      mensaje: limpiar(b.mensaje),
      utm_source: slugify(b.utm_source),
      utm_medium: slugify(b.utm_medium),
      utm_campaign: slugify(b.utm_campaign),
      utm_content: slugify(b.utm_content),
      descripcion: limpiar(b.descripcion).slice(0, 300),
      activo: b.activo !== false,
      creado: limpiar(b.creado) || new Date().toISOString(),
    },
  };
}

async function escribirEnlace(env, e) {
  // La metadata permite listar los enlaces sin leer cada uno
  const { mensaje, ...meta } = e;
  meta.descripcion = meta.descripcion.slice(0, 120);
  await env.LINKS.put(clave(e.slug), JSON.stringify(e), { metadata: meta });
}

async function guardarEnlace(env, body, url, esEdicion) {
  const slug = slugify(body.slug || body.nombre);
  const existente = slug ? await env.LINKS.get(clave(slug), { type: 'json' }) : null;
  if (existente && !esEdicion) return json({ ok: false, error: `El enlace "${slug}" ya existe` }, 409);
  if (!existente && esEdicion) return json({ ok: false, error: `El enlace "${slug}" no existe` }, 404);

  // Al editar, los campos que no se envían se conservan
  const { enlace, error } = validarEnlace(esEdicion ? { ...existente, ...body, slug } : body);
  if (error) return json({ ok: false, error }, 400);
  if (existente) enlace.creado = existente.creado;

  await escribirEnlace(env, enlace);
  return json({ ok: true, ...enlace, enlace: `${url.origin}/${enlace.slug}` }, esEdicion ? 200 : 201);
}

async function importarEnlaces(request, env) {
  const { enlaces = [] } = await leerJson(request);
  const resultado = { creados: 0, existentes: 0, errores: [] };
  for (const b of enlaces) {
    const { enlace, error } = validarEnlace(b);
    if (error) { resultado.errores.push({ slug: b.slug, error }); continue; }
    if (await env.LINKS.get(clave(enlace.slug))) { resultado.existentes++; continue; }
    await escribirEnlace(env, enlace);
    resultado.creados++;
  }
  return json({ ok: true, ...resultado });
}

async function listarEnlaces(env, conMensaje = false) {
  const enlaces = [];
  let cursor;
  do {
    const r = await env.LINKS.list({ prefix: 'l:', cursor });
    enlaces.push(...r.keys.map(k => k.metadata || { slug: k.name.slice(2) }));
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  if (conMensaje) {
    for (const e of enlaces) e.mensaje = ((await env.LINKS.get(clave(e.slug), { type: 'json' })) || {}).mensaje || '';
  }
  return enlaces;
}

async function estadisticas(env, q) {
  const filtros = [], valores = [];
  const slug = slugify(q.get('slug'));
  if (slug) { filtros.push('slug = ?'); valores.push(slug); }
  if (q.get('desde')) { filtros.push('dia >= ?'); valores.push(q.get('desde')); }
  if (q.get('hasta')) { filtros.push('dia <= ?'); valores.push(q.get('hasta')); }
  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
  const consulta = sql => env.DB.prepare(sql).bind(...valores);

  const grupos = {
    por_fuente: 'utm_source', por_campana: 'utm_campaign', por_dispositivo: 'dispositivo',
    por_sistema: 'sistema', por_app: 'app_origen', por_navegador: 'navegador',
    por_pais: 'pais', por_ciudad: 'ciudad', por_dia: 'dia', por_hora: 'hora',
  };
  const ordenNatural = new Set(['dia', 'hora']);
  const nombres = Object.keys(grupos);

  const res = await env.DB.batch([
    consulta(`SELECT COUNT(*) AS total, COUNT(DISTINCT visitante_id) AS unicos FROM clics ${where}`),
    consulta(`SELECT slug, COUNT(*) AS clics, COUNT(DISTINCT visitante_id) AS unicos, MAX(fecha) AS ultimo_clic FROM clics ${where} GROUP BY slug`),
    consulta(`SELECT ${CAMPOS_CLIC.join(',')} FROM clics ${where} ORDER BY id DESC LIMIT 25`),
    ...nombres.map(n => {
      const col = grupos[n];
      return consulta(`SELECT COALESCE(NULLIF(${col}, ''), 'Sin dato') AS nombre, COUNT(*) AS total FROM clics ${where} GROUP BY nombre ORDER BY ${ordenNatural.has(col) ? 'nombre' : 'total DESC'} LIMIT 60`);
    }),
  ]);

  const [totales, porSlug, ultimos, ...agrupados] = res.map(r => r.results);
  const mapaSlug = Object.fromEntries(porSlug.map(r => [r.slug, r]));
  const enlaces = (await listarEnlaces(env))
    .filter(e => !slug || e.slug === slug)
    .map(e => ({ ...e, clics: 0, unicos: 0, ultimo_clic: '', ...(mapaSlug[e.slug] || {}) }))
    .sort((a, b) => b.clics - a.clics);

  return {
    ok: true,
    total_clics: totales[0].total,
    visitantes_unicos: totales[0].unicos,
    enlaces,
    ...Object.fromEntries(nombres.map((n, i) => [n, agrupados[i]])),
    ultimos_clics: ultimos,
  };
}

async function salud(env) {
  const estado = { ok: true, kv: false, d1: false, pendientes_n8n: null, n8n_configurado: Boolean(env.N8N_CLICS_URL) };
  try { await env.LINKS.list({ limit: 1 }); estado.kv = true; } catch { estado.ok = false; }
  try {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM clics WHERE enviado = 0').first();
    estado.d1 = true;
    estado.pendientes_n8n = r.n;
  } catch { estado.ok = false; }
  return estado;
}

// ---------------------------------------------------------------- panel

function panel() {
  // El panel usa el mismo dominio desde el que se abre (location.origin)
  const config = `<script>window.WA_CONFIG = { backend: 'cloudflare', url: location.origin, base: location.origin };</script>`;
  return new Response(PANEL_HTML.replace('<!--WA_CONFIG-->', config), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'X-Frame-Options': 'DENY',
    },
  });
}
