-- Estado del LeadQualifier por WhatsApp. Ejecutar una vez en tu base Postgres (por ejemplo Supabase).
-- La tabla de memoria del agente (n8n_chat_histories) la crea n8n automáticamente.

-- Contactos: origen de marketing y pausa cuando una persona del equipo atiende la conversación
CREATE TABLE IF NOT EXISTS wa_contactos (
  telefono       TEXT PRIMARY KEY,
  nombre_perfil  TEXT,
  origen         TEXT,
  pausado_hasta  TIMESTAMPTZ,
  creado         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mensajes recibidos: evita duplicados de Meta y permite agrupar mensajes enviados en ráfaga
CREATE TABLE IF NOT EXISTS wa_mensajes (
  id         BIGSERIAL PRIMARY KEY,
  wamid      TEXT NOT NULL UNIQUE,
  telefono   TEXT NOT NULL REFERENCES wa_contactos (telefono),
  tipo       TEXT,
  texto      TEXT,
  recibido   TIMESTAMPTZ NOT NULL DEFAULT now(),
  procesado  BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_wa_mensajes_pendientes ON wa_mensajes (telefono, id) WHERE NOT procesado;

-- Utilidades:
--   Reactivar el bot para un contacto:  UPDATE wa_contactos SET pausado_hasta = NULL WHERE telefono = '5491122334455';
--   Pausar el bot manualmente 7 días:    UPDATE wa_contactos SET pausado_hasta = now() + interval '7 days' WHERE telefono = '...';
--   Limpiar mensajes viejos (mensual):    DELETE FROM wa_mensajes WHERE recibido < now() - interval '90 days';
