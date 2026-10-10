-- =====================================================================
-- Producto de enlaces de WhatsApp con seguimiento (multi-cuenta)
-- Ejecutar una vez en Supabase → SQL Editor.
-- Reglas de acceso (RLS): cada cuenta solo puede leer y modificar lo suyo.
-- El Worker de Cloudflare usa la clave "service_role" (secreta) para registrar clics.
-- =====================================================================

-- ---------- Planes ----------
CREATE TABLE IF NOT EXISTS public.planes (
  id              TEXT PRIMARY KEY,
  nombre          TEXT NOT NULL,
  max_enlaces     INT  NOT NULL,
  dias_historial  INT,              -- NULL = sin límite
  orden           INT  NOT NULL DEFAULT 0
);

INSERT INTO public.planes (id, nombre, max_enlaces, dias_historial, orden) VALUES
  ('gratis',  'Gratis',  2,     30,   0),
  ('pro',     'Pro',     50,    365,  1),
  ('agencia', 'Agencia', 10000, NULL, 2)
ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre, max_enlaces = EXCLUDED.max_enlaces,
  dias_historial = EXCLUDED.dias_historial, orden = EXCLUDED.orden;

-- ---------- Cuentas (una por usuario) ----------
CREATE TABLE IF NOT EXISTS public.cuentas (
  id               UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email            TEXT,
  plan             TEXT NOT NULL DEFAULT 'gratis' REFERENCES public.planes (id),
  plan_vence       TIMESTAMPTZ,       -- NULL en el plan gratis
  stripe_cliente   TEXT UNIQUE,
  suspendida       BOOLEAN NOT NULL DEFAULT false,
  creado           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Crea la cuenta automáticamente cuando alguien se registra
CREATE OR REPLACE FUNCTION public.crear_cuenta() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.cuentas (id, email) VALUES (NEW.id, NEW.email) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS al_registrarse ON auth.users;
CREATE TRIGGER al_registrarse AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.crear_cuenta();

-- Plan vigente: si el pago venció, la cuenta vuelve a "gratis"
CREATE OR REPLACE FUNCTION public.plan_vigente(p_cuenta UUID) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN c.plan <> 'gratis' AND (c.plan_vence IS NULL OR c.plan_vence > now())
              THEN c.plan ELSE 'gratis' END
  FROM public.cuentas c WHERE c.id = p_cuenta
$$;

-- ---------- Enlaces ----------
CREATE TABLE IF NOT EXISTS public.enlaces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id     UUID NOT NULL DEFAULT auth.uid() REFERENCES public.cuentas (id) ON DELETE CASCADE,
  slug          TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$'),
  telefono      TEXT NOT NULL CHECK (telefono ~ '^[0-9]{8,15}$'),
  mensaje       TEXT NOT NULL DEFAULT '' CHECK (length(mensaje) <= 1000),
  utm_source    TEXT NOT NULL DEFAULT '',
  utm_medium    TEXT NOT NULL DEFAULT '',
  utm_campaign  TEXT NOT NULL DEFAULT '',
  utm_content   TEXT NOT NULL DEFAULT '',
  descripcion   TEXT NOT NULL DEFAULT '' CHECK (length(descripcion) <= 300),
  agregar_ref   BOOLEAN NOT NULL DEFAULT false,  -- suma "(ref: slug)" al mensaje para identificar la campaña en el chat
  activo        BOOLEAN NOT NULL DEFAULT true,   -- el dueño puede pausarlo
  bloqueado     BOOLEAN NOT NULL DEFAULT false,  -- solo el administrador (abuso)
  creado        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_enlaces_cuenta ON public.enlaces (cuenta_id);

-- Validaciones al crear o editar: nombres reservados, límite del plan,
-- y protección de campos que el usuario no puede tocar.
CREATE OR REPLACE FUNCTION public.validar_enlace() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_max INT;
  v_cant INT;
  -- administrador = clave service_role o el editor SQL de Supabase (sin usuario conectado)
  v_admin BOOLEAN := coalesce(auth.role(), '') = 'service_role' OR auth.uid() IS NULL;
BEGIN
  NEW.slug := lower(NEW.slug);
  IF NEW.slug IN ('app', 'api', 'admin', 'login', 'reportar', 'terminos', 'privacidad', 'precios',
                  'ayuda', 'soporte', 'www', 'robots-txt', 'favicon-ico') THEN
    RAISE EXCEPTION 'El nombre "%" está reservado. Elige otro.', NEW.slug USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT v_admin THEN
      NEW.cuenta_id := auth.uid();
      NEW.bloqueado := false;
    END IF;
    IF (SELECT suspendida FROM cuentas WHERE id = NEW.cuenta_id) THEN
      RAISE EXCEPTION 'La cuenta está suspendida.' USING ERRCODE = 'P0001';
    END IF;
    SELECT p.max_enlaces INTO v_max FROM planes p WHERE p.id = plan_vigente(NEW.cuenta_id);
    SELECT count(*) INTO v_cant FROM enlaces WHERE cuenta_id = NEW.cuenta_id;
    IF v_cant >= v_max THEN
      RAISE EXCEPTION 'Tu plan permite % enlaces. Mejora tu plan para crear más.', v_max USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF NOT v_admin THEN
      NEW.cuenta_id := OLD.cuenta_id;
      NEW.bloqueado := OLD.bloqueado;
      NEW.creado := OLD.creado;
    END IF;
    NEW.actualizado := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS validar_enlace ON public.enlaces;
CREATE TRIGGER validar_enlace BEFORE INSERT OR UPDATE ON public.enlaces
  FOR EACH ROW EXECUTE FUNCTION public.validar_enlace();

-- ---------- Clics ----------
CREATE TABLE IF NOT EXISTS public.clics (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_clic             UUID NOT NULL UNIQUE,
  enlace_id           UUID NOT NULL REFERENCES public.enlaces (id) ON DELETE CASCADE,
  cuenta_id           UUID NOT NULL REFERENCES public.cuentas (id) ON DELETE CASCADE,
  fecha               TIMESTAMPTZ NOT NULL,
  dia                 DATE NOT NULL,
  hora                SMALLINT,
  utm_source          TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, ref TEXT,
  dispositivo         TEXT, sistema TEXT, navegador TEXT, app_origen TEXT,
  pais                TEXT, region TEXT, ciudad TEXT, latitud TEXT, longitud TEXT, proveedor_internet TEXT,
  idioma              TEXT, referer TEXT, visitante_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_clics_cuenta_dia ON public.clics (cuenta_id, dia);
CREATE INDEX IF NOT EXISTS idx_clics_enlace_dia ON public.clics (enlace_id, dia);

-- ---------- Denuncias de abuso ----------
CREATE TABLE IF NOT EXISTS public.reportes (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug      TEXT NOT NULL,
  motivo    TEXT NOT NULL CHECK (length(motivo) <= 1000),
  contacto  TEXT CHECK (length(contacto) <= 200),
  revisado  BOOLEAN NOT NULL DEFAULT false,
  creado    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Reglas de acceso (RLS) ----------
ALTER TABLE public.planes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cuentas  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enlaces  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clics    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reportes ENABLE ROW LEVEL SECURITY;  -- sin políticas: solo el administrador

DROP POLICY IF EXISTS planes_lectura ON public.planes;
CREATE POLICY planes_lectura ON public.planes FOR SELECT USING (true);

DROP POLICY IF EXISTS cuenta_propia ON public.cuentas;
CREATE POLICY cuenta_propia ON public.cuentas FOR SELECT USING (id = auth.uid());
-- (sin política de UPDATE: el plan solo lo cambia el Worker al recibir un pago)

DROP POLICY IF EXISTS enlaces_propios_ver ON public.enlaces;
DROP POLICY IF EXISTS enlaces_propios_crear ON public.enlaces;
DROP POLICY IF EXISTS enlaces_propios_editar ON public.enlaces;
DROP POLICY IF EXISTS enlaces_propios_borrar ON public.enlaces;
CREATE POLICY enlaces_propios_ver    ON public.enlaces FOR SELECT USING (cuenta_id = auth.uid());
CREATE POLICY enlaces_propios_crear  ON public.enlaces FOR INSERT WITH CHECK (cuenta_id = auth.uid());
CREATE POLICY enlaces_propios_editar ON public.enlaces FOR UPDATE USING (cuenta_id = auth.uid()) WITH CHECK (cuenta_id = auth.uid());
CREATE POLICY enlaces_propios_borrar ON public.enlaces FOR DELETE USING (cuenta_id = auth.uid());

DROP POLICY IF EXISTS clics_propios ON public.clics;
CREATE POLICY clics_propios ON public.clics FOR SELECT USING (cuenta_id = auth.uid());

-- ---------- Funciones para el panel ----------

-- Resumen de la cuenta: plan vigente, límites y uso
CREATE OR REPLACE FUNCTION public.mi_cuenta() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT json_build_object(
    'email', c.email,
    'plan', plan_vigente(c.id),
    'plan_nombre', p.nombre,
    'plan_vence', c.plan_vence,
    'max_enlaces', p.max_enlaces,
    'dias_historial', p.dias_historial,
    'enlaces_usados', (SELECT count(*) FROM enlaces e WHERE e.cuenta_id = c.id),
    'suspendida', c.suspendida)
  FROM cuentas c JOIN planes p ON p.id = plan_vigente(c.id)
  WHERE c.id = auth.uid()
$$;

-- Estadísticas de la cuenta. Respeta el historial del plan y las reglas de acceso.
CREATE OR REPLACE FUNCTION public.estadisticas(p_slug TEXT DEFAULT NULL, p_desde DATE DEFAULT NULL, p_hasta DATE DEFAULT NULL)
RETURNS JSON LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_dias INT;
  v_desde DATE;
  v_res JSON;
BEGIN
  SELECT p.dias_historial INTO v_dias FROM planes p WHERE p.id = plan_vigente(auth.uid());
  v_desde := greatest(coalesce(p_desde, '1900-01-01'::date),
                      CASE WHEN v_dias IS NULL THEN '1900-01-01'::date ELSE current_date - v_dias END);

  WITH f AS (
    SELECT c.*, e.slug FROM clics c JOIN enlaces e ON e.id = c.enlace_id
    WHERE c.cuenta_id = auth.uid()
      AND (p_slug IS NULL OR p_slug = '' OR e.slug = lower(p_slug))
      AND c.dia >= v_desde
      AND (p_hasta IS NULL OR c.dia <= p_hasta)
  ),
  agrupar AS (
    SELECT 'por_fuente' AS grupo, coalesce(nullif(utm_source, ''), 'Sin dato') AS nombre, count(*) AS total FROM f GROUP BY 2
    UNION ALL SELECT 'por_campana', coalesce(nullif(utm_campaign, ''), 'Sin dato'), count(*) FROM f GROUP BY 2
    UNION ALL SELECT 'por_dispositivo', coalesce(dispositivo, 'Sin dato'), count(*) FROM f GROUP BY 2
    UNION ALL SELECT 'por_sistema', coalesce(sistema, 'Sin dato'), count(*) FROM f GROUP BY 2
    UNION ALL SELECT 'por_app', coalesce(app_origen, 'Sin dato'), count(*) FROM f GROUP BY 2
    UNION ALL SELECT 'por_pais', coalesce(nullif(pais, ''), 'Sin dato'), count(*) FROM f GROUP BY 2
    UNION ALL SELECT 'por_ciudad', coalesce(nullif(ciudad, ''), 'Sin dato'), count(*) FROM f GROUP BY 2
    UNION ALL SELECT 'por_dia', to_char(dia, 'YYYY-MM-DD'), count(*) FROM f GROUP BY 2
  )
  SELECT json_build_object(
    'ok', true,
    'desde', v_desde,
    'total_clics', (SELECT count(*) FROM f),
    'visitantes_unicos', (SELECT count(DISTINCT visitante_id) FROM f),
    'enlaces', coalesce((
      SELECT json_agg(x ORDER BY x.clics DESC, x.slug) FROM (
        SELECT e.slug, e.telefono, e.utm_source, e.utm_campaign, e.descripcion, e.activo, e.bloqueado,
               (SELECT count(*) FROM f WHERE f.enlace_id = e.id) AS clics,
               (SELECT count(DISTINCT visitante_id) FROM f WHERE f.enlace_id = e.id) AS unicos,
               (SELECT max(fecha) FROM f WHERE f.enlace_id = e.id) AS ultimo_clic
        FROM enlaces e
        WHERE e.cuenta_id = auth.uid() AND (p_slug IS NULL OR p_slug = '' OR e.slug = lower(p_slug))
      ) x), '[]'::json),
    'ultimos_clics', coalesce((
      SELECT json_agg(u) FROM (
        SELECT to_char(fecha AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS fecha, slug, utm_source, app_origen,
               dispositivo, sistema, ciudad, pais
        FROM f ORDER BY fecha DESC LIMIT 25) u), '[]'::json)
  )::jsonb
  || coalesce((
    SELECT jsonb_object_agg(grupo, lista) FROM (
      SELECT grupo, jsonb_agg(jsonb_build_object('nombre', nombre, 'total', total)
                              ORDER BY CASE WHEN grupo = 'por_dia' THEN nombre END, total DESC) AS lista
      FROM agrupar GROUP BY grupo) g), '{}'::jsonb)
  INTO v_res;
  RETURN v_res;
END $$;

-- ---------- Funciones para el Worker (solo con la clave service_role) ----------

-- Datos públicos mínimos de un enlace para redirigir
CREATE OR REPLACE FUNCTION public.enlace_publico(p_slug TEXT) RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT json_build_object(
    'id', e.id, 'cuenta_id', e.cuenta_id, 'slug', e.slug, 'telefono', e.telefono, 'mensaje', e.mensaje,
    'utm_source', e.utm_source, 'utm_medium', e.utm_medium, 'utm_campaign', e.utm_campaign,
    'utm_content', e.utm_content, 'agregar_ref', e.agregar_ref,
    'estado', CASE WHEN e.bloqueado OR c.suspendida THEN 'bloqueado'
                   WHEN NOT e.activo THEN 'pausado' ELSE 'activo' END)
  FROM enlaces e JOIN cuentas c ON c.id = e.cuenta_id
  WHERE e.slug = lower(p_slug)
$$;

REVOKE ALL ON FUNCTION public.enlace_publico(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enlace_publico(TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.plan_vigente(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.plan_vigente(UUID) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.crear_cuenta() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validar_enlace() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mi_cuenta() TO authenticated;
GRANT EXECUTE ON FUNCTION public.estadisticas(TEXT, DATE, DATE) TO authenticated;

-- ---------- Utilidades para el administrador (ejecutar a mano en el SQL Editor) ----------
--   Ver denuncias:            SELECT * FROM reportes WHERE NOT revisado ORDER BY creado DESC;
--   Bloquear un enlace:       UPDATE enlaces SET bloqueado = true WHERE slug = 'nombre';
--   Suspender una cuenta:     UPDATE cuentas SET suspendida = true WHERE email = 'persona@ejemplo.com';
--   Dar un plan a mano:       UPDATE cuentas SET plan = 'pro', plan_vence = now() + interval '30 days' WHERE email = '...';
