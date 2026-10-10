# Producto: enlaces de WhatsApp con seguimiento (multi-cuenta)

Fase 1 del producto vendible: cualquier negocio se registra, crea enlaces cortos a **su** WhatsApp
(`tumarca.link/promo-ig`), los edita cuando quiere y ve sus estadísticas. Hay planes con límites y cobro con Stripe.

## Cómo está armado

| Parte | Dónde vive | Qué hace |
|---|---|---|
| `supabase/schema.sql` | Supabase | Cuentas, enlaces, clics, planes y denuncias. Las **reglas de acceso** impiden que una cuenta vea datos de otra |
| `worker/` | Cloudflare Workers | Redirige los enlaces, registra los clics, sirve el panel y recibe los pagos de Stripe |
| `app/app.html` | Servido por el Worker en `/app` | Panel de clientes: acceso por email o Google, enlaces, QR, estadísticas y planes |

### Qué protege a cada cliente
- **Reglas de acceso (RLS):** cada cuenta solo lee, crea, edita y borra lo suyo. Un cliente no puede cambiarse el plan,
  ni desbloquear un enlace bloqueado, ni usar un nombre ya tomado.
- **Límites del plan en la base de datos:** Gratis 2 enlaces y 30 días de historial; Pro 50 y 1 año; Agencia sin límite
  práctico. Si un pago vence, la cuenta vuelve sola a Gratis y conserva sus enlaces.
- **Clave secreta solo en el servidor:** el panel usa la clave pública de Supabase; la secreta solo la tiene el Worker.

### Qué lo hace resistente
- Copia de cada enlace en Cloudflare: si Supabase no responde, el enlace sigue redirigiendo con la última copia.
- Si un clic no se puede guardar, queda en una cola (D1) y se reenvía solo cada minuto.
- Los cambios del panel (número, mensaje, pausa) se ven en los enlaces en hasta 1 minuto.

### Protección contra abuso
- `/reportar`: cualquiera puede denunciar un enlace. Las denuncias quedan en la tabla `reportes`.
- El administrador bloquea enlaces o suspende cuentas desde el SQL Editor de Supabase (comandos al final de `schema.sql`).
- Enlace bloqueado o cuenta suspendida → página "desactivado". Enlace inexistente → página 404 que invita a crear el tuyo.

## Puesta en marcha

Necesitas: el dominio del producto en Cloudflare, una cuenta de Supabase, una de Stripe y una computadora con Node.js
(para publicar el Worker con `npm`). Si no te sientes cómodo con la terminal, pide ayuda solo para el paso 4.

### 1. Supabase
1. Crea un proyecto nuevo (distinto al del asistente de WhatsApp).
2. **SQL Editor** → pega todo `supabase/schema.sql` → **Run**.
3. **Authentication → URL Configuration:** en *Site URL* pon `https://tumarca.link/app` y agrégala también en
   *Redirect URLs*.
4. **Authentication → Providers:** deja activo **Email**. Para "Continuar con Google", activa **Google** y sigue las
   instrucciones de Supabase para crear las credenciales en Google Cloud.
5. **Project Settings → API Keys:** copia la **URL del proyecto**, la clave **anon** (pública) y la **service_role**
   (secreta). Si Supabase te muestra claves nuevas (*publishable* / *secret*), usa las de la pestaña *Legacy API keys*.
6. Recomendado: en **Authentication → Emails** configura un SMTP propio (Supabase limita los emails de prueba).

### 2. Stripe
1. Crea dos productos con precio **mensual recurrente**: *Pro* y *Agencia*. Copia el **ID de cada precio** (`price_...`).
2. Crea un **Payment Link** para cada uno. En sus opciones:
   - agrega el metadato `plan` = `pro` (o `agencia` en el otro);
   - en "Después del pago", redirige a `https://tumarca.link/app`.
3. **Developers → Webhooks → Add endpoint:** URL `https://tumarca.link/api/stripe`, eventos
   `checkout.session.completed`, `invoice.paid` y `customer.subscription.deleted`. Copia el **Signing secret** (`whsec_...`).

### 3. Configurar el Worker
En `worker/wrangler.toml` completa: `routes` (tu dominio), `NOMBRE_PRODUCTO`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`ZONA_HORARIA`, los dos `STRIPE_LINK_*`, los dos `STRIPE_PRECIO_*` y, cuando las tengas, `URL_TERMINOS` y `URL_PRIVACIDAD`.

### 4. Publicar
```bash
cd saas/worker
npm install
npx wrangler login
npx wrangler kv namespace create CACHE            # copia el id en wrangler.toml → REEMPLAZAR_ID_KV
npx wrangler d1 create enlaces-pendientes         # copia el database_id → REEMPLAZAR_ID_D1
npm run db:remoto
npx wrangler secret put SUPABASE_SERVICE_KEY      # pega la clave service_role
npx wrangler secret put STRIPE_WEBHOOK_SECRET     # pega el whsec_...
npm run deploy
```

### 5. Probar
1. Abre `https://tumarca.link/app`, entra con tu email y crea un enlace.
2. Ábrelo desde el celular: debe abrir WhatsApp. Pulsa **Actualizar** en el panel y verás el clic.
3. Paga el plan Pro con una tarjeta de prueba de Stripe (modo test): el panel debe mostrar **Plan Pro**.

## Tareas del administrador (SQL Editor de Supabase)
```sql
SELECT * FROM reportes WHERE NOT revisado ORDER BY creado DESC;            -- denuncias nuevas
UPDATE enlaces SET bloqueado = true WHERE slug = 'nombre';                   -- bloquear un enlace
UPDATE cuentas SET suspendida = true WHERE email = 'persona@ejemplo.com';    -- suspender una cuenta
UPDATE cuentas SET plan = 'pro', plan_vence = now() + interval '30 days' WHERE email = '...';  -- regalar un plan
```

## Pruebas realizadas
- **Base de datos (26 pruebas, Postgres real con simulación de Supabase Auth):** aislamiento entre cuentas, límites y
  vencimiento de planes, nombres reservados y repetidos, historial según plan, bloqueo y suspensión.
- **Worker + panel (28 pruebas, Cloudflare local + navegador):** registro de enlaces desde el panel, redirección, clic
  registrado sin contar bots, edición y pausa, mensajes de error claros, respaldo con Supabase caído y reenvío de clics,
  denuncias, webhooks de Stripe (firma falsa y repetida rechazadas; alta, renovación y baja de plan), vista en celular.
- **No probado contra servicios reales:** Supabase, Stripe y Cloudflare de producción (requieren tus cuentas).

## Pendiente para fases siguientes
- Páginas de Términos de uso y Política de privacidad (enlazarlas con `URL_TERMINOS` / `URL_PRIVACIDAD`).
- Cobro con Mercado Pago.
- Dominio propio por cliente, equipos, exportar a Sheets/CRM, reportes por email.
- Zona horaria por cliente (hoy se usa `ZONA_HORARIA` para todos).
