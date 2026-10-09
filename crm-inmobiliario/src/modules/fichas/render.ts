import PDFDocument from 'pdfkit';
import type { PublicListing } from './public-listing.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const money = (p?: { amount: number; currency: string } | null) =>
  p ? `${p.currency === 'USD' ? 'USD' : '$'} ${p.amount.toLocaleString('es-AR', { maximumFractionDigits: 0 })}` : 'Consultar';

const safeUrl = (u: string) => (/^https:\/\//i.test(u) ? u : '');

/** HTML autocontenido (sin JS) apto para compartir o imprimir. Todo valor se escapa. */
export function renderHtml(l: PublicListing): string {
  const color = /^#[0-9a-f]{6}$/i.test(l.branding?.primaryColor ?? '') ? l.branding!.primaryColor : '#1f3a5f';
  const photos = l.photos.map(safeUrl).filter(Boolean);
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(l.title)}</title>
<style>
  :root{--brand:${color};--ink:#1d2430;--muted:#5b6575;--line:#e3e7ee;--bg:#fff}
  @media (prefers-color-scheme:dark){:root{--ink:#e8ecf2;--muted:#a6b0bf;--line:#2b3340;--bg:#12161c}}
  *{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
  header{background:var(--brand);color:#fff;padding:16px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
  header img{max-height:44px}main{max-width:960px;margin:0 auto;padding:16px}
  h1{font-size:1.6rem;margin:.2em 0}.price{font-size:1.5rem;font-weight:700;color:var(--brand)}
  .meta{color:var(--muted)}.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin:16px 0}
  .gallery img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px}
  table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left}
  .chips span{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 10px;margin:2px;font-size:.9rem}
  footer{border-top:1px solid var(--line);margin-top:24px;padding:16px;color:var(--muted);font-size:.85rem}
  a{color:var(--brand)}
</style></head><body>
<header>
  <div>${l.branding?.logoUrl && safeUrl(l.branding.logoUrl) ? `<img src="${esc(l.branding.logoUrl)}" alt="${esc(l.branding.agencyName)}">` : `<strong>${esc(l.branding?.agencyName ?? 'Ficha de propiedad')}</strong>`}</div>
  <div>Ref. ${esc(l.reference)}</div>
</header>
<main>
  <p class="meta">${esc([l.operation, l.propertyType].filter(Boolean).join(' · '))}${l.development ? ` · ${esc(l.development.name)} (${esc(l.development.status)})` : ''}</p>
  <h1>${esc(l.title)}</h1>
  <p class="price">${esc(money(l.price))}${l.expenses ? ` <span class="meta">+ expensas ${esc(money(l.expenses))}</span>` : ''}</p>
  <p class="meta">📍 ${esc(l.location.address ?? l.location.label)}</p>
  ${photos.length ? `<div class="gallery">${photos.slice(0, 12).map((u) => `<img loading="lazy" src="${esc(u)}" alt="">`).join('')}</div>` : ''}
  ${l.specs.length ? `<table>${l.specs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
  ${l.description ? `<h2>Descripción</h2><p>${esc(l.description).replace(/\n/g, '<br>')}</p>` : ''}
  ${l.amenities.length ? `<h2>Amenities</h2><div class="chips">${l.amenities.map((a) => `<span>${esc(a)}</span>`).join('')}</div>` : ''}
  ${l.tours.length || l.videos.length ? `<h2>Recorridos y videos</h2><ul>${[...l.tours.map((t) => ({ label: `Recorrido 360° (${t.provider})`, url: t.url })), ...l.videos.map((v) => ({ label: 'Video', url: v }))].filter((x) => safeUrl(x.url)).map((x) => `<li><a href="${esc(x.url)}" rel="noopener" target="_blank">${esc(x.label)}</a></li>`).join('')}</ul>` : ''}
  ${l.units?.length ? `<h2>Unidades disponibles</h2><table><tr><th>Unidad</th><th>Tipología</th><th>m²</th><th>Estado</th><th>Precio</th></tr>${l.units.map((u) => `<tr><td>${esc(u.unit)}</td><td>${esc(u.typology)}</td><td>${esc(u.m2 ?? '-')}</td><td>${esc(u.status)}</td><td>${esc(u.price ? `${u.currency} ${Number(u.price).toLocaleString('es-AR')}` : 'Consultar')}</td></tr>`).join('')}</table>` : ''}
</main>
<footer>
  ${l.branding ? `<p><strong>${esc(l.branding.agencyName)}</strong>${[l.branding.phone, l.branding.email, l.branding.website, l.branding.address].filter(Boolean).map((x) => ` · ${esc(x)}`).join('')}</p>` : ''}
  <p>${esc(l.disclaimer)}</p>
</footer>
</body></html>`;
}

/** Anti-SSRF básico: solo https a hostnames públicos (sin IPs literales ni nombres internos). */
function isFetchable(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      !/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname) &&
      !/^[\d.]+$|^\[|:/.test(u.hostname) &&
      u.hostname.includes('.')
    );
  } catch {
    return false;
  }
}

async function fetchImage(url: string): Promise<Buffer | undefined> {
  if (!isFetchable(url)) return undefined;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !/image\/(jpeg|png)/.test(type)) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= 5 * 1024 * 1024 ? buf : undefined;
  } catch {
    return undefined;
  }
}

/** PDF descargable (A4) con la misma información que el HTML. */
export async function renderPdf(l: PublicListing): Promise<Buffer> {
  const color = /^#[0-9a-f]{6}$/i.test(l.branding?.primaryColor ?? '') ? l.branding!.primaryColor : '#1f3a5f';
  const [logo, ...photos] = await Promise.all([
    l.branding?.logoUrl ? fetchImage(l.branding.logoUrl) : Promise.resolve(undefined),
    ...l.photos.slice(0, 4).map(fetchImage),
  ]);

  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: l.title, Author: l.branding?.agencyName ?? 'Ficha neutra' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const width = doc.page.width - 80;

  // Encabezado
  doc.rect(0, 0, doc.page.width, 70).fill(color);
  if (logo) {
    try {
      doc.image(logo, 40, 15, { fit: [160, 40] });
    } catch {
      /* imagen corrupta: se omite */
    }
  } else {
    doc.fillColor('#ffffff').fontSize(16).text(l.branding?.agencyName ?? 'Ficha de propiedad', 40, 26);
  }
  doc.fillColor('#ffffff').fontSize(10).text(`Ref. ${l.reference}`, 40, 30, { width, align: 'right' });

  doc.fillColor('#555555').fontSize(10).text([l.operation, l.propertyType, l.development?.name].filter(Boolean).join(' · '), 40, 90);
  doc.fillColor('#111111').fontSize(20).text(l.title, { width });
  doc.moveDown(0.3).fillColor(color).fontSize(16).text(money(l.price) + (l.expenses ? `  + expensas ${money(l.expenses)}` : ''));
  doc.fillColor('#555555').fontSize(10).text(l.location.address ?? l.location.label);

  // Fotos en grilla 2x2
  const valid = photos.filter((p): p is Buffer => Boolean(p));
  if (valid.length) {
    const top = doc.y + 10;
    const w = (width - 10) / 2;
    valid.forEach((img, i) => {
      try {
        doc.image(img, 40 + (i % 2) * (w + 10), top + Math.floor(i / 2) * (w * 0.75 + 10), { cover: [w, w * 0.75] });
      } catch {
        /* se omite */
      }
    });
    doc.y = top + Math.ceil(valid.length / 2) * (w * 0.75 + 10);
  }

  doc.moveDown().fillColor('#111111');
  for (const [k, v] of l.specs) doc.fontSize(10).font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(v);
  if (l.description) doc.moveDown().fontSize(12).font('Helvetica-Bold').text('Descripción').font('Helvetica').fontSize(10).text(l.description, { width, align: 'justify' });
  if (l.amenities.length) doc.moveDown().fontSize(12).font('Helvetica-Bold').text('Amenities').font('Helvetica').fontSize(10).text(l.amenities.join(' · '), { width });
  if (l.tours.length) {
    doc.moveDown().fontSize(12).font('Helvetica-Bold').text('Recorridos 360°').font('Helvetica').fontSize(10);
    for (const t of l.tours) doc.fillColor(color).text(t.url, { link: safeUrl(t.url) || undefined, underline: true });
    doc.fillColor('#111111');
  }
  if (l.units?.length) {
    doc.moveDown().fontSize(12).font('Helvetica-Bold').text('Unidades disponibles').font('Helvetica').fontSize(9);
    for (const u of l.units) {
      doc.text(`${u.unit} · ${u.typology} · ${u.m2 ?? '-'} m² · ${u.status} · ${u.price ? `${u.currency} ${Number(u.price).toLocaleString('es-AR')}` : 'Consultar'}`);
    }
  }

  doc.moveDown(2).fontSize(8).fillColor('#777777');
  if (l.branding) {
    doc.text([l.branding.agencyName, l.branding.phone, l.branding.email, l.branding.website].filter(Boolean).join(' · '), { width });
  }
  doc.text(l.disclaimer, { width });
  doc.end();
  return done;
}
