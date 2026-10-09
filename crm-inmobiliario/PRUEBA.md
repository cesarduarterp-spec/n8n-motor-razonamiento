# Guía del modo prueba (costo mínimo)

Esta guía levanta el CRM completo en **tu Docker local** (o en un servidor gratuito) gastando lo mínimo posible.

| Pieza | En la prueba | Costo |
|---|---|---|
| Servidor | Tu PC con Docker, o Oracle Cloud *Always Free* | $0 |
| Base de datos y colas | Postgres + Redis dentro de Docker | $0 |
| IA de atención (Gemini) | API key gratuita de Google AI Studio (cupo diario) | $0 |
| IA legal (Claude) | **Apagada** (`CLAUDE_ENABLED=false`): reclamos y mora se derivan a una persona | $0 |
| Agenda | Agenda propia del CRM + link iCal (sin Google OAuth) | $0 |
| WhatsApp | Número de prueba gratuito de Meta | $0 |
| Webhooks desde internet | Túnel ngrok con dominio fijo (plan gratis) | $0 |
| Backups a la nube | Desactivados (los datos quedan en tu Docker) | $0 |

> ⚠️ **Datos de prueba, no de clientes reales.** En el plan gratuito de Gemini, Google puede usar el contenido de las consultas para mejorar sus productos. Para datos reales hay que pasar a un plan pago.

> Incluye un **panel web** (negro, blanco y verde) en <http://localhost:3000>: inicio con indicadores, **simulador de chat** para probar el asistente sin WhatsApp, pipeline Kanban, propiedades con fichas, agenda y aprobaciones.

---

## 1. Requisitos

- Docker Desktop (Windows/Mac) o Docker Engine (Linux), con unos **2 GB de RAM libres**.
- `openssl` para generar claves y `jq` para los ejemplos con `curl` (en Windows, usar Git Bash o WSL).

## 2. Configurar

```bash
cd crm-inmobiliario
cp .env.prueba.example .env
openssl rand -base64 48   # pegar en JWT_SECRET
openssl rand -base64 32   # pegar en MASTER_ENCRYPTION_KEY
```

Crear la API key de Gemini en <https://aistudio.google.com> → *Get API key* y pegarla en `GEMINI_API_KEY`.

## 3. Levantar

```bash
docker compose -f docker-compose.yml -f docker-compose.prueba.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prueba.yml ps        # todo "running"/"healthy"
curl http://localhost:3000/health                                           # {"status":"ok"}
```

Crear la inmobiliaria y el usuario administrador:

```bash
docker compose -f docker-compose.yml -f docker-compose.prueba.yml run --rm \
  -e SEED_SLUG=demo -e SEED_ADMIN_EMAIL=admin@demo.com -e SEED_ADMIN_PASSWORD='UnaClaveLarga123' \
  api node dist/database/seed.js
```

Para no repetir el `-f … -f …`, se puede crear un alias: `alias dc='docker compose -f docker-compose.yml -f docker-compose.prueba.yml'`.

## 4. Probar desde el panel

Abrí **<http://localhost:3000>** e ingresá con la inmobiliaria `demo`, tu email y contraseña.

| Sección | Qué probar |
|---|---|
| **Inicio** | Leads por etapa, próximas visitas, aprobaciones pendientes, uso de IA del día y actividad reciente. |
| **Simulador de chat** | Escribí como si fueras un cliente (o usá los ejemplos). A la derecha ves *qué pensó el asistente*: intención detectada, si lo atendió Gemini, el especialista o una persona, por qué, y qué herramientas usó (buscar propiedades, ver horarios, reservar). Cada chat nuevo crea un contacto y un lead que aparecen en el pipeline. |
| **Pipeline** | Arrastrá las tarjetas entre etapas (o tocá una tarjeta para moverla desde el detalle, cómodo en el celular). *Nuevo lead* lo asigna solo por round-robin. |
| **Propiedades** | Cargá inmuebles, buscá en lenguaje natural (“depto luminoso cerca del subte que acepte mascotas”) y generá la **ficha pública** o la **ficha neutra** (web o PDF) con un link para compartir. *Interesados* muestra los leads afines. |
| **Agenda** | Visitas agendadas por el asistente, bloqueos de horario y el link para verlas en el celular. |
| **Aprobaciones** | Lo que el especialista legal redacta con riesgo espera tu OK; podés editar el texto antes de aprobar. |

> Para que el asistente responda hace falta `GEMINI_API_KEY` válida y el contenedor `worker` corriendo. Si algo falla, el simulador muestra el motivo en rojo.

<details>
<summary>Probar por API (curl), opcional</summary>

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"tenant":"demo","email":"admin@demo.com","password":"UnaClaveLarga123"}' | jq -r .accessToken)
curl -s localhost:3000/pipeline -H "authorization: Bearer $TOKEN"
curl -s -X POST localhost:3000/audit/verify -H "authorization: Bearer $TOKEN"
```
El listado completo de endpoints está en el [README](README.md#endpoints).
</details>

## 5. Agenda de visitas (sin Google)

El bot ofrece horarios libres y reserva solo; la agenda vive en el CRM.

- **Bloquear horarios** (vacaciones, trámites):
  `POST /agenda/blocks` con `{"startsAt":"2026-10-20T09:00:00-03:00","endsAt":"2026-10-20T13:00:00-03:00","reason":"Trámite"}`
- **Ver las visitas en el celular**: `POST /agenda/feed-link` devuelve un link `.ics` privado. En Google Calendar (desde la web): *Otros calendarios → + → Desde URL* y pegarlo. En iPhone: *Ajustes → Calendario → Cuentas → Añadir calendario suscrito*.
  - El link tiene que ser **público** (con el túnel o en un servidor); `localhost` no le sirve a Google. Con el dominio fijo de ngrok el link no cambia.
  - Google actualiza los calendarios suscritos cada varias horas (Apple y Outlook, más seguido). La reserva en el CRM es inmediata; lo que demora es verlo en el celular.
  - Si se comparte por error: `POST /agenda/feed-link` de nuevo genera otro y anula el anterior.
- **Opcional, que el bot respete tu agenda personal**: en Google Calendar → *Configuración* → tu calendario → *Dirección secreta en formato iCal* → copiarla y enviarla con `PUT /agenda/external-calendar {"url":"https://calendar.google.com/…/basic.ics"}`. El CRM la lee cada 5 minutos (solo lectura; se guarda cifrada).

## 6. WhatsApp de prueba (opcional, gratis)

1. **Túnel con dirección fija (una sola vez):** crear cuenta gratis en <https://dashboard.ngrok.com>, copiar el *Authtoken* y, en *Domains*, reclamar el dominio gratuito (ej. `tu-inmobiliaria.ngrok-free.app`). Completar en `.env`:
   ```
   NGROK_AUTHTOKEN=<tu authtoken>
   NGROK_DOMAIN=tu-inmobiliaria.ngrok-free.app
   PUBLIC_BASE_URL=https://tu-inmobiliaria.ngrok-free.app
   ```
   y levantar: `docker compose -f docker-compose.yml -f docker-compose.prueba.yml --profile tunnel up -d`.
   Probar desde cualquier lado: `https://tu-inmobiliaria.ngrok-free.app/health`.
2. En <https://developers.facebook.com> crear una app de tipo *Business* → agregar **WhatsApp**. Meta da un **número de prueba gratuito** que puede escribir hasta a 5 números verificados (el tuyo, por ejemplo).
3. *WhatsApp → Configuración → Webhook*: URL `https://tu-inmobiliaria.ngrok-free.app/webhooks/meta`, token de verificación = `META_VERIFY_TOKEN`; suscribir el campo `messages`. Copiar el *App Secret* (Configuración básica) en `META_APP_SECRET`.
4. Vincular el número a tu inmobiliaria (ID del número y token de acceso, en *API Setup*):
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prueba.yml run --rm \
     -e SEED_SLUG=demo -e SEED_WA_PHONE_NUMBER_ID=<id del número> -e SEED_WA_TOKEN=<token> \
     api node dist/database/seed.js
   ```
5. Escribirle al número de prueba desde tu WhatsApp: "Hola, busco un 2 ambientes en Palermo".

Limitaciones del modo gratuito: el plan gratis de ngrok tiene un cupo mensual de tráfico (de sobra para una prueba) y, al abrir la URL desde un **navegador**, muestra una página de aviso la primera vez (a los webhooks de Meta y a los calendarios no les afecta). El token temporal de Meta vence a las 24 h: para algo estable, generar un token de *usuario del sistema* en Meta Business.

¿Sin cuenta en ngrok? `--profile tunnel-rapido` usa Cloudflare sin registrarse, pero la URL cambia en cada reinicio y hay que actualizarla en Meta.

## 7. Servidor gratuito (si no querés dejar la PC prendida)

- **Oracle Cloud – Always Free**: una VM ARM de hasta 4 núcleos y 24 GB de RAM sin costo, suficiente para todo este stack. Pide tarjeta para verificar identidad (no cobra mientras se use solo lo gratuito). Instalar Docker y seguir esta misma guía; abrir el puerto 443 o usar el túnel.
- Render, Railway o Fly.io tienen planes gratuitos o de prueba, pero con suspensión por inactividad o sin Redis/Postgres persistentes: sirven para una demo puntual, no para dejar el bot atendiendo.

## 8. Apagar / borrar

```bash
docker compose -f docker-compose.yml -f docker-compose.prueba.yml down       # apaga y conserva los datos
docker compose -f docker-compose.yml -f docker-compose.prueba.yml down -v    # apaga y BORRA todo
```

## 9. Pasar de prueba a producción

`cp .env.example .env` (y completar), activar Claude (`CLAUDE_ENABLED=true` + `ANTHROPIC_API_KEY`), configurar backups (`backup.env`, ver README) y levantar **sin** `docker-compose.prueba.yml`.
