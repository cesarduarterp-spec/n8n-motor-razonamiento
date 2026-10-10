// Producto de enlaces de WhatsApp con seguimiento (multi-cuenta) — Cloudflare Worker.
//
// - GET /<slug>          redirige a WhatsApp y registra el clic (después de redirigir)
// - GET /app             panel de clientes (login con Supabase)
// - GET /reportar        formulario de denuncia de abuso; POST /api/reportar lo guarda
// - POST /api/stripe     webhook de Stripe: activa, renueva o cancela planes
//
// Respaldo: si Supabase no responde, el enlace se resuelve con la última copia guardada en KV
// y el clic queda en D1 para reenviarse solo (cron cada minuto).

import PANEL_HTML from '../../app/app.html';
import { analizarUA } from './ua.js';

const RESERVADOS = new Set(['app', 'api', 'admin', 'login', 'reportar', 'terminos', 'privacidad', 'precios',
  'ayuda', 'soporte', 'www', 'robots.txt', 'favicon.ico']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ruta = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
    const primero = ruta.split('/')[0].toLowerCase();

    try {
      if (!ruta) return redireccion(env.SITIO_WEB || '/app');
      if (primero === 'app') return panel(env);
      if (primero === 'robots.txt') return texto('User-agent: *\nDisallow: /\n');
      if (primero === 'favicon.ico') return new Response(null, { status: 204 });
      if (primero === 'reportar' && request.method === 'GET') return paginaReportar(env, url.searchParams.get('slug') || '');
      if (ruta === 'api/reportar' && request.method === 'POST') return await guardarReporte(request, env);
      if (ruta === 'api/stripe' && request.method === 'POST') return await webhookStripe(request, env);
      if (primero === 'api') return json({ ok: false, error: 'Ruta no encontrada' }, 404);
    } catch (e) {
      console.error('Error interno', e);
      return json({ ok: false, error: 'Error interno' }, 500);
    }

    return redirigir(request, env, ctx, slugify(ruta.split('/')[0]), url.searchParams);
  },

  async scheduled(_evento, env, ctx) {
    ctx.waitUntil(reenviarPendientes(env));
  },
};

// ================================================================ redirección

async function redirigir(request, env, ctx, slug, query) {
  let enlace;
  try {
    enlace = await buscarEnlace(env, ctx, slug);
  } catch (e) {
    console.error('No se pudo resolver el enlace', slug, e);
    return pagina(env, 'Enlace no disponible por un momento', 'Intenta de nuevo en unos minutos.', 503);
  }

  if (!enlace) {
    return pagina(env, 'Este enlace no existe',
      `Revisa que esté bien escrito. ¿Quieres crear tus propios enlaces a WhatsApp? <a href="/app">Hazlo gratis aquí</a>.`, 404);
  }
  if (enlace.estado === 'bloqueado') {
    return pagina(env, 'Este enlace fue desactivado', 'Se desactivó por no cumplir los términos de uso.', 410);
  }
  if (enlace.estado === 'pausado') {
    return pagina(env, 'Este enlace está pausado', 'Su dueño lo desactivó por ahora. Intenta más tarde.', 200);
  }

  const ref = query.get('ref') || slug;
  let mensaje = enlace.mensaje || '';
  if (enlace.agregar_ref) mensaje = `${mensaje} (ref: ${ref})`.trim();

  if (request.method === 'GET') {
    ctx.waitUntil(registrarClic(request, env, enlace, query).catch(e => console.error('No se pudo registrar el clic', e)));
  }
  return redireccion(enlaceWhatsApp(enlace.telefono, mensaje));
}

// Copia en KV: rápida y sirve de respaldo si Supabase no responde
async function buscarEnlace(env, ctx, slug) {
  const clave = `e:${slug}`;
  let copia = null;
  try { copia = await env.CACHE.get(clave, { type: 'json' }); } catch { /* KV no disponible */ }
  const vigencia = Number(env.CACHE_SEGUNDOS ?? 60) * 1000;  // cuánto tarda en verse un cambio del panel
  if (copia && Date.now() - copia.t < vigencia) return copia.e;

  try {
    const e = await supabase(env, 'POST', '/rest/v1/rpc/enlace_publico', { p_slug: slug });
    ctx.waitUntil(env.CACHE.put(clave, JSON.stringify({ t: Date.now(), e }), { expirationTtl: 60 * 60 * 24 * 30 })
      .catch(err => console.error('KV', err)));
    return e;
  } catch (err) {
    if (copia) {
      console.error('Supabase no responde; uso la copia guardada', err);
      return copia.e;
    }
    throw err;
  }
}

function enlaceWhatsApp(telefono, mensaje) {
  const tel = String(telefono || '').replace(/\D/g, '');
  return `https://wa.me/${tel}` + (mensaje ? `?text=${encodeURIComponent(mensaje)}` : '');
}

// ================================================================ clics

async function registrarClic(request, env, enlace, query) {
  const h = request.headers;
  const ua = h.get('user-agent') || '';
  const info = analizarUA(ua);
  if (info.esBot) return;

  const cf = request.cf || {};
  const utm = k => String(query.get(k) || enlace[k] || '').toLowerCase().slice(0, 100);
  const ahora = new Date();
  const local = fechaLocal(ahora, env.ZONA_HORARIA || 'UTC');

  const clic = {
    id_clic: crypto.randomUUID(),
    enlace_id: enlace.id,
    cuenta_id: enlace.cuenta_id,
    fecha: ahora.toISOString(),
    dia: local.dia,
    hora: local.hora,
    utm_source: utm('utm_source'),
    utm_medium: utm('utm_medium'),
    utm_campaign: utm('utm_campaign'),
    utm_content: utm('utm_content'),
    ref: String(query.get('ref') || '').slice(0, 100),
    dispositivo: info.dispositivo,
    sistema: info.sistema,
    navegador: info.navegador,
    app_origen: info.app_origen,
    pais: nombrePais(cf.country),
    region: cf.region || '',
    ciudad: cf.city || '',
    latitud: String(cf.latitude || ''),
    longitud: String(cf.longitude || ''),
    proveedor_internet: cf.asOrganization || '',
    idioma: (h.get('accept-language') || '').split(',')[0].slice(0, 20),
    referer: (h.get('referer') || '').slice(0, 300),
    visitante_id: await hashVisitante(h.get('cf-connecting-ip') || '', ua, env.SUPABASE_SERVICE_KEY || ''),
  };

  try {
    await insertarClics(env, [clic]);
  } catch (e) {
    console.error('Supabase no responde; guardo el clic para reenviarlo', e);
    await env.PENDIENTES.prepare('INSERT INTO pendientes (datos) VALUES (?)').bind(JSON.stringify(clic)).run();
  }
}

function insertarClics(env, clics) {
  return supabase(env, 'POST', '/rest/v1/clics?on_conflict=id_clic', clics,
    { Prefer: 'resolution=ignore-duplicates,return=minimal' });
}

export async function reenviarPendientes(env) {
  const { results } = await env.PENDIENTES.prepare(
    'SELECT id, datos, intentos FROM pendientes ORDER BY id LIMIT 500').all();
  if (!results.length) return { enviados: 0 };

  const borrar = ids => ids.length && env.PENDIENTES.prepare(
    `DELETE FROM pendientes WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();

  try {
    await insertarClics(env, results.map(r => JSON.parse(r.datos)));
    for (let i = 0; i < results.length; i += 90) await borrar(results.slice(i, i + 90).map(r => r.id));
    return { enviados: results.length };
  } catch (e) {
    console.error('Reenvío por lote falló; pruebo uno por uno', e);
  }

  // Uno por uno: un clic de un enlace borrado no debe trabar a los demás
  let enviados = 0;
  for (const r of results) {
    try {
      await insertarClics(env, [JSON.parse(r.datos)]);
      await borrar([r.id]);
      enviados++;
    } catch (e) {
      if (/\b(409|23503)\b/.test(String(e.message)) || r.intentos >= 50) await borrar([r.id]);
      else await env.PENDIENTES.prepare('UPDATE pendientes SET intentos = intentos + 1 WHERE id = ?').bind(r.id).run();
    }
  }
  return { enviados };
}

function fechaLocal(fecha, zona) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(fecha).map(x => [x.type, x.value]));
    return { dia: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) };
  } catch {
    return { dia: fecha.toISOString().slice(0, 10), hora: fecha.getUTCHours() };
  }
}

function nombrePais(codigo) {
  if (!codigo) return '';
  try { return new Intl.DisplayNames(['es'], { type: 'region' }).of(codigo) || codigo; } catch { return codigo; }
}

async function hashVisitante(ip, ua, sal) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${sal}|${ip}|${ua}`)));
  return [...h.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ================================================================ Supabase

async function supabase(env, method, path, body, extra = {}) {
  const k = env.SUPABASE_SERVICE_KEY || '';
  // Las claves nuevas (sb_secret_...) van solo en "apikey"; las antiguas (JWT) también en Authorization
  const auth = k.startsWith('sb_') ? {} : { Authorization: `Bearer ${k}` };
  const r = await fetch(env.SUPABASE_URL.replace(/\/+$/, '') + path, {
    method,
    headers: { apikey: k, ...auth, 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

// ================================================================ denuncias

async function guardarReporte(request, env) {
  let d = {};
  const tipo = request.headers.get('content-type') || '';
  if (tipo.includes('application/json')) d = await request.json().catch(() => ({}));
  else d = Object.fromEntries(await request.formData().catch(() => new FormData()));

  const slug = slugify(d.slug);
  const motivo = String(d.motivo || '').trim().slice(0, 1000);
  if (!slug || motivo.length < 5) {
    return pagina(env, 'Faltan datos', 'Indica el enlace y el motivo de la denuncia. <a href="/reportar">Volver</a>', 400);
  }
  await supabase(env, 'POST', '/rest/v1/reportes', {
    slug, motivo, contacto: String(d.contacto || '').trim().slice(0, 200) || null,
  }, { Prefer: 'return=minimal' });
  return pagina(env, 'Gracias por avisar', 'Revisaremos el enlace a la brevedad.', 200);
}

function paginaReportar(env, slug) {
  return pagina(env, 'Denunciar un enlace', `
    <p>Si un enlace se usa para spam, estafas o suplantación, cuéntanos.</p>
    <form method="post" action="/api/reportar">
      <label>Enlace<input name="slug" value="${esc(slugify(slug))}" placeholder="nombre-del-enlace" required></label>
      <label>¿Qué pasó?<textarea name="motivo" required minlength="5" maxlength="1000"></textarea></label>
      <label>Tu email (opcional)<input name="contacto" type="email" maxlength="200"></label>
      <button>Enviar denuncia</button>
    </form>`, 200);
}

// ================================================================ Stripe

async function webhookStripe(request, env) {
  const cuerpo = await request.text();
  if (!(await firmaStripeValida(cuerpo, request.headers.get('stripe-signature') || '', env.STRIPE_WEBHOOK_SECRET || ''))) {
    return json({ ok: false, error: 'Firma inválida' }, 400);
  }
  const ev = JSON.parse(cuerpo);
  const o = (ev.data || {}).object || {};
  const planDePrecio = id => (id && id === env.STRIPE_PRECIO_PRO ? 'pro' : id && id === env.STRIPE_PRECIO_AGENCIA ? 'agencia' : null);
  const enDias = d => new Date(Date.now() + d * 864e5).toISOString();
  const actualizar = (filtro, datos) => supabase(env, 'PATCH', `/rest/v1/cuentas?${filtro}`, datos, { Prefer: 'return=minimal' });

  if (ev.type === 'checkout.session.completed') {
    const cuenta = String(o.client_reference_id || '');
    const plan = (o.metadata || {}).plan;
    if (/^[0-9a-f-]{36}$/i.test(cuenta) && ['pro', 'agencia'].includes(plan)) {
      await actualizar(`id=eq.${cuenta}`, { plan, stripe_cliente: o.customer || null, plan_vence: enDias(35) });
    } else {
      console.error('Checkout sin cuenta o plan reconocibles', o.id);
    }
  } else if (ev.type === 'invoice.paid' && o.customer) {
    const linea = ((o.lines || {}).data || [])[0] || {};
    const precio = (linea.price || {}).id || (((linea.pricing || {}).price_details || {}).price);
    const fin = (linea.period || {}).end;
    const datos = { plan_vence: fin ? new Date((fin + 3 * 86400) * 1000).toISOString() : enDias(35) };
    const plan = planDePrecio(precio);
    if (plan) datos.plan = plan;
    await actualizar(`stripe_cliente=eq.${encodeURIComponent(o.customer)}`, datos);
  } else if (ev.type === 'customer.subscription.deleted' && o.customer) {
    await actualizar(`stripe_cliente=eq.${encodeURIComponent(o.customer)}`, { plan: 'gratis', plan_vence: null });
  }
  return json({ ok: true });
}

export async function firmaStripeValida(cuerpo, cabecera, secreto) {
  if (!secreto || !cabecera) return false;
  const partes = cabecera.split(',').map(p => p.split('='));
  const t = (partes.find(([k]) => k === 't') || [])[1];
  const firmas = partes.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !firmas.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;

  const enc = new TextEncoder();
  const clave = await crypto.subtle.importKey('raw', enc.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', clave, enc.encode(`${t}.${cuerpo}`)));
  const esperada = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  return firmas.some(f => f.length === esperada.length &&
    crypto.subtle.timingSafeEqual(enc.encode(f), enc.encode(esperada)));
}

// ================================================================ utilidades

export const slugify = s => String(s ?? '').trim().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function redireccion(destino) {
  return new Response(null, { status: 302, headers: { Location: destino, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

function json(datos, status = 200) {
  return new Response(JSON.stringify(datos), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function texto(t) {
  return new Response(t, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function pagina(env, titulo, cuerpoHtml, status) {
  const nombre = esc(env.NOMBRE_PRODUCTO || 'Enlaces');
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(titulo)} · ${nombre}</title>
<style>
:root{--bg:#f6f7f5;--card:#fff;--text:#1b1f1d;--muted:#66706b;--line:#e3e6e3;--accent:#128c4a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1311;--card:#171c19;--text:#e8ece9;--muted:#98a29d;--line:#2a312d;--accent:#3ddc84}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:520px;margin:12vh auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:22px;margin:0 0 8px}p{color:var(--muted)}a{color:var(--accent)}
label{display:block;margin:12px 0 0;font-size:14px;color:var(--muted)}
input,textarea{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
textarea{min-height:90px}button{margin-top:16px;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer}
footer{margin-top:16px;font-size:13px;color:var(--muted);text-align:center}
</style></head><body><main><div class="card"><h1>${esc(titulo)}</h1>${cuerpoHtml.trim().startsWith('<') ? cuerpoHtml : `<p>${cuerpoHtml}</p>`}</div>
<footer>${nombre} · <a href="/reportar">Denunciar un enlace</a></footer></main></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function panel(env) {
  const config = {
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_ANON_KEY,
    nombre: env.NOMBRE_PRODUCTO || 'Enlaces',
    pagoPro: env.STRIPE_LINK_PRO || '',
    pagoAgencia: env.STRIPE_LINK_AGENCIA || '',
    terminos: env.URL_TERMINOS || '',
    privacidad: env.URL_PRIVACIDAD || '',
  };
  const html = PANEL_HTML.replace('<!--CONFIG-->',
    `<script>window.APP = ${JSON.stringify(config).replace(/</g, '\\u003c')};</script>`);
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex' },
  });
}
