# Enlaces de WhatsApp con seguimiento (tipo w.app) en n8n

Crea enlaces cortos con nombre propio hacia tu WhatsApp Business, con parámetros UTM, y registra cada clic con:

- **Origen de marketing**: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` y `ref`
- **Dispositivo**: móvil / tablet / escritorio, sistema (iOS, Android, Windows…), navegador
- **App desde donde se hizo clic**: Instagram, Facebook, TikTok, LinkedIn, X, Google App…
- **Geolocalización aproximada por IP**: país, región, ciudad, latitud/longitud, proveedor de internet
- **Visitantes únicos** (hash anónimo de IP + navegador; la IP no se guarda)

Además, el mensaje que se precarga en el chat incluye `(ref: nombre-del-enlace)`, así **al recibir la consulta en WhatsApp ya sabes de qué campaña viene**.

## Archivos

| Archivo | Qué es |
|---|---|
| `whatsapp_link_tracker.json` | Workflow de n8n (importar) con 3 flujos: redirección, crear enlace y estadísticas |
| `panel.html` | Panel web para crear enlaces (con QR) y ver estadísticas. Se abre en el navegador o se sube a cualquier hosting |

## Cómo funciona

```
Usuario hace clic en  https://tu-n8n.com/webhook/wa/promo-octubre?utm_source=instagram
        │
        ▼
 n8n busca "promo-octubre" en la hoja Enlaces
        │
        ├──► 302 inmediato a  https://wa.me/549...?text=Hola!...(ref: promo-octubre)
        │
        └──► (después de redirigir) detecta dispositivo/app, geolocaliza la IP
             y guarda una fila en la hoja Clics
```

La redirección se responde **antes** de geolocalizar, así el usuario no espera.
Las vistas previas que generan WhatsApp, Facebook, Telegram, etc. al pegar el link (bots) **no se cuentan como clics**.

## Instalación

### 1. Google Sheets

Crea una hoja de cálculo con dos pestañas y estos encabezados en la fila 1:

**Pestaña `Enlaces`**
```
slug	telefono	mensaje	utm_source	utm_medium	utm_campaign	utm_content	descripcion	creado
```

**Pestaña `Clics`**
```
fecha	dia	hora	slug	utm_source	utm_medium	utm_campaign	utm_content	ref	dispositivo	sistema	navegador	app_origen	pais	region	ciudad	latitud	longitud	proveedor_internet	idioma	referer	visitante_id
```

> Formatea la columna `telefono` como **Texto sin formato** para que Sheets no convierta el número.

### 2. n8n

1. *Workflows → Import from file* → `whatsapp_link_tracker.json`.
2. En los 6 nodos de Google Sheets: elige tu credencial y reemplaza `REEMPLAZAR_ID_DE_LA_HOJA` por el ID de tu hoja
   (lo que va entre `/d/` y `/edit` en la URL).
3. Cambia `CAMBIAR_ESTA_CLAVE` en los nodos **Validar Enlace** y **Calcular Estadisticas** (la misma clave en ambos).
4. Opcional, en **Analizar Visita**:
   - `DESTINO_SI_NO_EXISTE`: a dónde enviar si alguien entra a un enlace que no existe.
   - `AGREGAR_REFERENCIA`: `false` si no quieres el `(ref: …)` en el mensaje.
5. **Activa** el workflow.
6. Abre el nodo **Webhook Redireccion** y copia la *Production URL*. Debería ser `https://tu-n8n.com/webhook/wa/:slug`.
   Si n8n le puso otro prefijo (por ej. un ID largo), usa esa base en el panel, en “Base de los enlaces cortos”.

### 3. Panel

Abre `panel.html`, despliega “Configuración de conexión”, pon la URL de tu n8n y la clave, y guarda.
Desde ahí creas enlaces (te da el link y su QR) y ves las estadísticas con filtros por enlace y fechas.

## Uso de marketing recomendado

**Un enlace por punto de contacto**, con nombre legible:

| Enlace | Dónde se usa |
|---|---|
| `/wa/ig-bio` | Bio de Instagram |
| `/wa/ig-historias-oct` | Historias de octubre |
| `/wa/fb-ads-blackfriday` | Anuncios de Facebook Black Friday |
| `/wa/tiktok-bio` | Bio de TikTok |
| `/wa/qr-local` | QR impreso en el local / flyers |
| `/wa/firma-email` | Firma de email |

También puedes **reutilizar un mismo enlace** cambiando los UTM en la URL; tienen prioridad sobre los guardados:

```
https://tu-n8n.com/webhook/wa/promo?utm_source=instagram&utm_medium=reel&utm_content=video-1
https://tu-n8n.com/webhook/wa/promo?utm_source=tiktok&utm_medium=anuncio&utm_content=video-2
```

## API

| Método | Ruta | Parámetros |
|---|---|---|
| GET | `/webhook/wa/:slug` | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `ref` (opcionales) |
| POST | `/webhook/wa-crear` | JSON: `clave`, `slug`, `telefono`, `mensaje`, `utm_*`, `descripcion` |
| GET | `/webhook/wa-stats` | `clave`, `slug`, `desde`, `hasta` (fechas `yyyy-MM-dd`) |

## Limitaciones y notas

- **Geolocalización por IP**: precisión de ciudad, no de calle; con datos móviles a veces marca la ciudad del operador.
  La ubicación GPS exacta exigiría una página intermedia que pida permiso al usuario, lo que reduce la conversión,
  por eso no se usa. Se usa el servicio gratuito [ipwho.is](https://ipwho.is); para mucho volumen conviene uno con API key
  (ipinfo.io, ipapi.co) cambiando la URL del nodo **Geolocalizar IP**.
- Si tu n8n está detrás de Cloudflare, se usa `CF-Connecting-IP` y `CF-IPCountry` automáticamente.
- **Dominio propio**: para enlaces como `tumarca.link/promo`, apunta un dominio a tu n8n y redirige `/*` a `/webhook/wa/*`
  (por ejemplo con una regla de Cloudflare o un proxy Nginx).
- **Privacidad**: no se guarda la IP, solo un identificador anónimo. Aun así, menciona en tu política de privacidad que
  mides clics con fines estadísticos.
- Google Sheets aguanta bien unos miles de clics por mes. Si el volumen crece, reemplaza los nodos de Sheets por
  Postgres/Supabase sin cambiar el resto del flujo.
