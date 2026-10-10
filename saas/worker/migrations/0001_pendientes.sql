-- Clics que no se pudieron guardar en Supabase; el cron los reenvía cada minuto.
CREATE TABLE IF NOT EXISTS pendientes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  datos     TEXT NOT NULL,
  intentos  INTEGER NOT NULL DEFAULT 0,
  creado    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
