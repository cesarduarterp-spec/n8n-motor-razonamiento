# Enlaces de WhatsApp en Cloudflare Workers (versión con respaldo)

Es la versión "de producción" del rastreador de enlaces. Los enlaces se sirven desde la red de Cloudflare
(responden en milisegundos en todo el mundo) con **tu dominio de marca**, por ejemplo `wa.tumarca.com/promo`.
n8n queda como copia de los datos en Google Sheets y para conectar con tu CRM y tu agente de leads.

## Por qué no se cae

| Si falla… | Qué pasa |
|---|---|
| **n8n o Google Sheets** | Los enlaces siguen funcionando. Los clics se guardan en D1 y se reenvían solos cuando n8n vuelve (cada minuto, por lotes, sin duplicar) |
| **El límite de Google Sheets** | No se alcanza: se envía **un lote por minuto** en lugar de una escritura por clic |
| **La base de clics (D1)** | La redirección no se afecta y el clic se envía directo a n8n |
| **La base de enlaces (KV)**, o alguien entra a un enlace que no existe | Se manda a tu **WhatsApp de respaldo** (`TELEFONO_RESPALDO`), con `(ref: nombre-del-enlace)` para que sepas de dónde vino |
| **Error inesperado en el registro** | Siempre se redirige primero; el registro corre después y nunca bloquea al usuario |
| **Borras un enlace por error** | Lo restauras desde el **respaldo JSON** del panel. Además, D1 tiene *Time Travel*: restaura la base de clics a cualquier minuto de los últimos 7 días (30 en el plan pago) |

Además puedes **cambiar el número o el mensaje de un enlace sin cambiar la URL**. Los QR ya impresos siguen sirviendo.

La única dependencia que queda es Cloudflare, cuya disponibilidad es muy alta (sostiene una parte importante de internet).

## Qué se registra en cada clic

Fecha y hora, enlace, UTM (los de la URL tienen prioridad), `ref`, dispositivo, sistema, navegador, **app de origen**
(Instagram, Facebook, TikTok…), **país, región, ciudad, latitud/longitud y proveedor de internet** (Cloudflare los
entrega sin servicios externos), idioma, referer e identificador anónimo del visitante (no se guarda la IP).
Los bots de vista previa (WhatsApp, Facebook, Telegram…) redirigen pero no cuentan.

## Costo

Con el **plan gratuito de Cloudflare** tienes 100.000 clics por día, y D1 y KV de sobra para este uso.
Solo pagas el dominio (unos 10–15 USD al año).

## Instalación (unos 20 minutos)

### 1. Dominio en Cloudflare
1. Compra el dominio de tu marca (en Cloudflare Registrar o donde prefieras).
2. Agrégalo a tu cuenta de Cloudflare (*Add a site*, plan Free) y cambia los nameservers donde lo compraste, si hace falta.

### 2. Preparar el proyecto
```bash
cd cloudflare-worker
npm install
npx wrangler login
```

### 3. Crear las bases
```bash
npx wrangler kv namespace create LINKS      # copia el "id" en wrangler.toml → REEMPLAZAR_ID_KV
npx wrangler d1 create wa-clics              # copia el "database_id" en wrangler.toml → REEMPLAZAR_ID_D1
npm run db:remoto                            # crea la tabla de clics
```

### 4. Configurar `wrangler.toml`
- `routes`: cambia `wa.tumarca.com` por tu subdominio real.
- `TELEFONO_RESPALDO`: tu WhatsApp principal (formato internacional, sin +). **Muy recomendado.**
- `N8N_CLICS_URL`: la *Production URL* del nodo **Webhook Clics Cloudflare** de n8n
  (por ejemplo `https://tu-n8n.com/webhook/wa-clics-cf`).
- `ZONA_HORARIA`: la de tu negocio (ej. `America/Bogota`, `America/Mexico_City`, `Europe/Madrid`).
- `SITIO_WEB` (opcional): a dónde lleva `wa.tumarca.com/` sin nombre.

### 5. Secretos
```bash
npx wrangler secret put ADMIN_KEY    # clave del panel (larga y difícil de adivinar)
npx wrangler secret put N8N_CLAVE    # la misma que pongas en CLAVE_CLOUDFLARE del nodo "Validar Lote" en n8n
```

### 6. Publicar
```bash
npm run deploy
```

### 7. n8n
Importa el `whatsapp_link_tracker.json` actualizado (flujo **4) Recibir clics desde Cloudflare**), cambia
`CAMBIAR_ESTA_CLAVE_CF` en el nodo **Validar Lote**, agrega la columna `id_clic` al final de la pestaña `Clics` y activa el workflow.

Los flujos 1 a 3 de n8n (redirección propia) dejan de ser necesarios, pero puedes mantenerlos activos como **plan B**.

## Uso

- **Panel:** `https://wa.tumarca.com/admin`. Ingresa la `ADMIN_KEY` en "Configuración de conexión".
  Desde ahí creas enlaces con QR, ves las estadísticas y descargas el respaldo.
- **Enlaces:** `https://wa.tumarca.com/ig-bio`, `https://wa.tumarca.com/promo?utm_source=tiktok&utm_content=video-2`.
- **Salud del sistema:** `GET /api/salud` muestra si KV y D1 responden y cuántos clics esperan para ir a n8n.
  Si `pendientes_n8n` crece sin bajar, n8n está caído o la clave no coincide.
- **Logs en vivo:** `npm run logs`.

### API (cabecera `Authorization: Bearer <ADMIN_KEY>`)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/links` | Lista los enlaces (`?completo=1` incluye el mensaje; sirve de respaldo) |
| POST | `/api/links` | Crear: `slug`, `telefono`, `mensaje`, `utm_*`, `descripcion` |
| PUT | `/api/links/:slug` | Editar (solo los campos enviados; `"activo": false` lo pausa y manda al respaldo) |
| DELETE | `/api/links/:slug` | Borrar |
| POST | `/api/links/importar` | Restaurar o migrar: `{ "enlaces": [...] }` (no pisa los existentes) |
| GET | `/api/stats` | Estadísticas (`slug`, `desde`, `hasta`) |
| GET | `/api/salud` | Estado de KV, D1 y la cola hacia n8n |
| POST | `/api/sincronizar` | Fuerza el envío de los clics pendientes a n8n |

### Migrar los enlaces que ya creaste en n8n/Sheets
Descarga la pestaña `Enlaces` y conviértela a `{ "enlaces": [ { "slug": "...", "telefono": "...", ... } ] }`
(o pídeme que lo haga), y envíala a `POST /api/links/importar`.

## Desarrollo local
```bash
cp .dev.vars.example .dev.vars   # claves de prueba
npm run db:local
npm run dev                      # http://localhost:8787/admin
```
