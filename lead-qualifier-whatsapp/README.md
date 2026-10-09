# LeadQualifier por WhatsApp (Cloud API)

Versión del agente de calificación de leads (`checkpoint1_cesar_duarte`) conectada a una conversación real de
**WhatsApp Business Cloud API**. El archivo original queda intacto como entrega del Checkpoint 1.

## Errores encontrados en el agente original

| # | Problema | Impacto | Corrección |
|---|---|---|---|
| 1 | **El chat responde con la salida de Slack, no con la del agente** (`responseMode: lastNode` y Slack es el último nodo) | El prospecto no ve la respuesta del agente | La respuesta se envía explícitamente por WhatsApp y Slack queda solo como registro |
| 2 | **Sin memoria**: cada mensaje se procesa como si fuera el primero | La regla "pide una aclaración" no funciona: al responder, el agente ya olvidó la conversación | Memoria permanente en Postgres por contacto (clave = teléfono de WhatsApp) |
| 3 | **Se muestran datos internos al cliente**: el bloque `[SCORE] [CLASIFICACION] [ACCION_TOMADA]` y `ESCALAR_A_HUMANO` salen en la respuesta | En WhatsApp el prospecto vería su puntaje | El agente separa la respuesta pública de un JSON interno; un nodo los divide y limpia lo que se filtre |
| 4 | **Score BANT sin rúbrica** ("calcula de 0 a 100") | Puntajes inconsistentes entre conversaciones | Rúbrica explícita: Necesidad 30, Plazo 25, Presupuesto 25, Autoridad 20 |
| 5 | **El escalamiento no hace nada**: solo escribe una marca en el texto | Nadie se entera y el bot sigue respondiendo | Alerta `@channel` en Slack y el bot se pausa 24 h para ese contacto |
| 6 | **Registros duplicados**: `append` agrega una fila nueva en cada llamada | Con varios mensajes, el mismo lead aparece muchas veces | `appendOrUpdate` con el teléfono como clave: una fila por persona |
| 7 | **Canal de origen adivinado por la IA** | Dato poco confiable para medir campañas | Origen detectado por código: `(ref: …)` de tus enlaces o anuncio Click-to-WhatsApp de Meta |
| 8 | **`temperature: 0` con los modelos actuales** | Claude Haiku 5.5 rechaza `temperature` con error 400 | Se quita; el formato lo garantiza el prompt y el nodo de separación |
| 9 | `maxTokens: 1024` | Con el razonamiento interno activo de los modelos actuales, las respuestas pueden cortarse | 4096 (el costo real depende de lo generado, no del límite) |
| 10 | La nota dice "Claude 3.5 Sonnet" pero el nodo usa Haiku 4.5 | Documentación inconsistente | Actualizada a Claude Haiku 5.5 |
| 11 | Los leads FRÍOS no se guardan | Se pierden contactos útiles para remarketing | Se registran todos, con su clasificación |
| 12 | El prompt habla de "procesar mensajes" (analista interno) | En WhatsApp sonaría a formulario | Prompt conversacional: mensajes cortos, una pregunta por vez, cierre según la clasificación |

**Modelo:** `claude-haiku-5-5` (Claude Haiku 5.5). Es la Haiku actual: mejor y más barata que Haiku 4.5
(0,10 USD por millón de tokens de entrada frente a 1 USD). Si notas calificaciones flojas en casos ambiguos,
cambia a `claude-sonnet-5-5` en el nodo **Claude Haiku**.

## Cómo funciona

```
WhatsApp Trigger
  → Preparar Mensaje     ignora avisos de estado, detecta el origen y el tipo de mensaje
  → ¿Es audio?           sí → descarga el audio de Meta y lo transcribe (Whisper en Groq)
  → Guardar Mensaje      Postgres: descarta duplicados de Meta y guarda el origen del contacto
  → Esperar 7 s          por si la persona sigue escribiendo
  → Tomar Pendientes     solo sigue la ejecución del ÚLTIMO mensaje y junta toda la ráfaga en uno
  → ¿Atención humana?    si el contacto fue escalado → solo avisa en Slack (el bot no responde)
  → ¿Es texto?           sticker, imagen sin texto o audio no transcrito → pide que lo escriba
  → LeadQualifier        Claude Haiku 5.5 + memoria en Postgres + herramienta Registrar Lead (Sheets)
  → Separar Respuesta    mensaje para el cliente | evaluación interna (score, clasificación, escalar)
  → Responder por WhatsApp
  → Log de Supervisión (Slack)   🚨 escalados · 🔥 calientes · 🔍 resto
  → ¿Escalar?            sí → pausa el bot 24 h para ese contacto (Postgres)
```

### Mensajes en ráfaga
Mucha gente escribe en varios mensajes cortos ("Hola" / "quería consultar" / "por anuncios"). Cada mensaje se guarda,
se espera 7 segundos y solo la ejecución del último mensaje sigue: junta todos los pendientes y el agente responde
**una sola vez**. Si llega otro mensaje después, se responde en su propio turno. El tiempo se cambia en el nodo
**Esperar Más Mensajes**.

### Audios
Los audios se descargan de Meta y se transcriben con Whisper (`whisper-large-v3-turbo` en Groq, unos 0,04 USD por hora
de audio). El agente recibe el texto como `[audio transcrito] ...`. Si la transcripción falla, se le pide a la persona
que escriba. Las imágenes y videos con texto también se leen.

### Conexión con tus enlaces de WhatsApp
Los enlaces del rastreador (`whatsapp-link-tracker` / `cloudflare-worker`) agregan `(ref: nombre-del-enlace)` al mensaje.
Este agente lo lee, guarda el origen en la columna `Origen` de `CRM_Leads` y lo quita del texto antes de pasárselo a la IA.
Si el contacto llega desde un **anuncio Click-to-WhatsApp de Meta**, se registra el anuncio automáticamente.

## Instalación

### 1. WhatsApp Cloud API (Meta)
1. Crea una app en [developers.facebook.com](https://developers.facebook.com) de tipo *Business* y agrega el producto **WhatsApp**.
2. Agrega y verifica tu número de empresa. Genera un **token permanente** (usuario del sistema en Business Manager, con permisos
   `whatsapp_business_messaging` y `whatsapp_business_management`).
3. En n8n crea dos credenciales:
   - **WhatsApp OAuth API** (para el Trigger): Client ID y Client Secret de la app de Meta.
   - **WhatsApp API** (para enviar): el token permanente y el *Business Account ID*.
4. Al activar el workflow, n8n registra el webhook en Meta automáticamente.

> Un número conectado a la Cloud API no puede usarse a la vez en la app WhatsApp Business del celular, salvo que actives
> la función de *coexistencia* de Meta. Para que el equipo atienda a los contactos escalados, usa una bandeja compartida
> (por ejemplo Chatwoot o respond.io) conectada al mismo número.

### 2. Postgres (memoria y estado)
Sirve cualquier Postgres; lo más simple es **Supabase** (plan gratuito):
1. Crea un proyecto y copia los datos de conexión (*Project Settings → Database*; usa el *Session pooler*).
2. Abre el *SQL Editor* y ejecuta [`schema.sql`](schema.sql).
3. En n8n crea una credencial **Postgres** con esos datos.

La tabla de memoria del agente (`n8n_chat_histories`) la crea n8n sola la primera vez.

### 3. Transcripción de audios (Groq)
1. Crea una API key en [console.groq.com](https://console.groq.com).
2. En n8n crea una credencial **Header Auth**: nombre `Authorization`, valor `Bearer TU_API_KEY`.

Para usar OpenAI en su lugar: en el nodo **Transcribir Audio** cambia la URL a
`https://api.openai.com/v1/audio/transcriptions`, el modelo a `whisper-1` y usa tu key de OpenAI en la credencial.

### 4. Google Sheets
Pestaña `CRM_Leads` con estos encabezados en la fila 1:
```
Telefono	Origen	Nombre	Empresa	Necesidad	Plazo	Presupuesto	Autoridad	Score_BANT	Clasificacion	Ultima_Actualizacion
```
Formatea la columna `Telefono` como texto sin formato.

### 5. n8n
1. Importa `leadqualifier_whatsapp.json`.
2. Asigna las credenciales (WhatsApp, Postgres, Groq, Anthropic, Google Sheets y Slack) y reemplaza
   `REEMPLAZAR_ID_DE_LA_HOJA` y `REEMPLAZAR_ID_CANAL_SLACK`.
3. Revisa el prompt del nodo **LeadQualifier**: ajusta servicios, presupuesto mínimo (300 USD/mes) y tono a tu agencia.
4. **Probar sin WhatsApp:** el Trigger trae un mensaje de ejemplo fijado (*pinned data*). Pulsa *Test workflow* y verás el
   recorrido completo (el envío por WhatsApp fallará si no hay credenciales: es esperado). El ejemplo tiene un ID fijo:
   para repetir la prueba cámbialo (`wamid.EJEMPLO2`…), porque el segundo envío se descarta como duplicado.
5. Activa el workflow.

## Ajustes rápidos
- **Tiempo de espera de la ráfaga:** nodo **Esperar Más Mensajes** (7 segundos).
- **Horas de pausa tras escalar:** el `24` del nodo **Pausar Contacto**.
- **Reactivar el bot para un contacto:** `UPDATE wa_contactos SET pausado_hasta = NULL WHERE telefono = '549...';`
- **Largo de la memoria:** `contextWindowLength` en **Memoria por Contacto** (20 mensajes).
- **Versión de la API de Meta:** `v23.0` en el nodo **Obtener URL del Audio**. Meta retira versiones con el tiempo;
  si deja de funcionar, súbela a la versión vigente.

## Limitaciones conocidas
- La espera de 7 segundos agrega ese tiempo a cada respuesta: es lo normal en una conversación de WhatsApp y evita
  respuestas repetidas.
- Si un mensaje llega justo mientras el agente está respondiendo, se responde en un turno aparte.
- Los audios muy largos (más de 25 MB) no se transcriben y se pide que escriban.
- Imágenes sin texto: el agente no las "ve"; se pide que describan por escrito.
