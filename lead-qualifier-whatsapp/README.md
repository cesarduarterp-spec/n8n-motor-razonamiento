# LeadQualifier por WhatsApp (Cloud API)

Versión del agente de calificación de leads (`checkpoint1_cesar_duarte`) conectada a una conversación real de
**WhatsApp Business Cloud API**. El archivo original queda intacto como entrega del Checkpoint 1.

## Errores encontrados en el agente original

| # | Problema | Impacto | Corrección |
|---|---|---|---|
| 1 | **El chat responde con la salida de Slack, no con la del agente** (`responseMode: lastNode` y Slack es el último nodo) | El prospecto no ve la respuesta del agente | La respuesta se envía explícitamente por WhatsApp y Slack queda solo como registro |
| 2 | **Sin memoria**: cada mensaje se procesa como si fuera el primero | La regla "pide una aclaración" no funciona: al responder, el agente ya olvidó la conversación | Memoria por contacto (clave = teléfono de WhatsApp) |
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
  → Preparar Mensaje     ignora avisos de estado y duplicados, detecta el origen, arma el contexto
  → ¿Atención humana?    si el contacto fue escalado → solo avisa en Slack (el bot no responde)
  → ¿Es texto?           audio, imagen o sticker → pide que lo escriba
  → LeadQualifier        Claude Haiku 5.5 + memoria por contacto + herramienta Registrar Lead (Sheets)
  → Separar Respuesta    mensaje para el cliente | evaluación interna (score, clasificación, escalar)
  → Responder por WhatsApp
  → Log de Supervisión (Slack)   🚨 escalados · 🔥 calientes · 🔍 resto
```

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

### 2. Google Sheets
Pestaña `CRM_Leads` con estos encabezados en la fila 1:
```
Telefono	Origen	Nombre	Empresa	Necesidad	Plazo	Presupuesto	Autoridad	Score_BANT	Clasificacion	Ultima_Actualizacion
```
Formatea la columna `Telefono` como texto sin formato.

### 3. n8n
1. Importa `leadqualifier_whatsapp.json`.
2. Asigna las credenciales (WhatsApp ×3 nodos, Anthropic, Google Sheets, Slack ×2) y reemplaza `REEMPLAZAR_ID_DE_LA_HOJA`
   y `REEMPLAZAR_ID_CANAL_SLACK`.
3. Revisa el prompt del nodo **LeadQualifier**: ajusta servicios, presupuesto mínimo (300 USD/mes) y tono a tu agencia.
4. **Probar sin WhatsApp:** el Trigger trae un mensaje de ejemplo fijado (*pinned data*). Pulsa *Test workflow* y verás el
   recorrido completo (el envío por WhatsApp fallará si no hay credenciales: es esperado).
5. Activa el workflow.

## Ajustes rápidos
- **Horas de pausa tras escalar:** constante `HORAS_PAUSA_ESCALADO` en **Separar Respuesta**.
- **Largo de la memoria:** `contextWindowLength` en **Memoria por Contacto** (20 mensajes).
- **Reactivar el bot antes de tiempo:** ejecuta el workflow manualmente o espera a que venza la pausa.

## Limitaciones conocidas
- **Memoria en RAM:** se borra si n8n se reinicia y no sirve en modo *queue* con varios workers. Para producción, cambia
  el nodo por **Postgres Chat Memory** o **Redis Chat Memory** (misma clave: el teléfono).
- **Mensajes en ráfaga:** si alguien envía 3 mensajes seguidos, el agente responde 3 veces. Se puede agrupar con una espera
  de unos segundos (mejora futura).
- **Audios:** hoy se pide que escriban. Se pueden transcribir descargando el audio y pasándolo por un servicio de
  transcripción (mejora futura).
- La pausa por escalamiento y el control de duplicados usan la memoria interna del workflow (*static data*), que solo se
  guarda en ejecuciones de producción (workflow activo), no en pruebas manuales.
