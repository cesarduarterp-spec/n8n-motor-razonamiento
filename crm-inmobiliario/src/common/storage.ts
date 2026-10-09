import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { env } from '../config/env.js';

/**
 * Almacenamiento de archivos particionado por tenant. Implementación en disco
 * (volumen compartido entre API y worker); reemplazable por S3/GCS manteniendo
 * la interfaz `put/get`.
 */
@Injectable()
export class StorageService {
  async put(tenantId: string, folder: string, data: Buffer, ext: string): Promise<{ path: string; sha256: string }> {
    const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    const path = join(tenantId, folder, `${randomUUID()}.${safeExt}`);
    const abs = this.resolve(path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data, { mode: 0o600 });
    return { path, sha256: createHash('sha256').update(data).digest('hex') };
  }

  async get(tenantId: string, path: string): Promise<Buffer> {
    if (!path.startsWith(`${tenantId}/`)) throw new Error('Acceso a archivo de otro tenant');
    return readFile(this.resolve(path));
  }

  private resolve(path: string): string {
    const root = env().STORAGE_DIR;
    const abs = normalize(join(root, path));
    if (!abs.startsWith(normalize(root))) throw new Error('Path traversal');
    return abs;
  }
}
