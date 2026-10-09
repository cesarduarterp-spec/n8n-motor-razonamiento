-- Clics registrados por el Worker. "enviado" = 1 cuando ya se copió a n8n / Google Sheets.
CREATE TABLE IF NOT EXISTS clics (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  id_clic            TEXT UNIQUE,
  fecha              TEXT,
  dia                TEXT,
  hora               TEXT,
  slug               TEXT,
  utm_source         TEXT,
  utm_medium         TEXT,
  utm_campaign       TEXT,
  utm_content        TEXT,
  ref                TEXT,
  dispositivo        TEXT,
  sistema            TEXT,
  navegador          TEXT,
  app_origen         TEXT,
  pais               TEXT,
  region             TEXT,
  ciudad             TEXT,
  latitud            TEXT,
  longitud           TEXT,
  proveedor_internet TEXT,
  idioma             TEXT,
  referer            TEXT,
  visitante_id       TEXT,
  enviado            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_clics_slug_dia ON clics (slug, dia);
CREATE INDEX IF NOT EXISTS idx_clics_dia ON clics (dia);
CREATE INDEX IF NOT EXISTS idx_clics_pendientes ON clics (enviado, id);
