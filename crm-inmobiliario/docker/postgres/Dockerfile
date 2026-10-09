# Postgres 17 + pgvector + WAL-G (backups base incrementales + archivado continuo de WAL a S3/GCS).
FROM pgvector/pgvector:0.8.0-pg17

# Verificar versión y nombre del binario en https://github.com/wal-g/wal-g/releases antes de construir.
ARG WALG_VERSION=v3.0.5
ARG WALG_ASSET=wal-g-pg-ubuntu-22.04-amd64

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/${WALG_ASSET}.tar.gz" -o /tmp/walg.tgz \
 && tar -xzf /tmp/walg.tgz -C /tmp \
 && install -m 0755 "/tmp/${WALG_ASSET}" /usr/local/bin/wal-g \
 && rm -rf /tmp/walg* /var/lib/apt/lists/* \
 && wal-g --version

COPY backup/*.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/*.sh
