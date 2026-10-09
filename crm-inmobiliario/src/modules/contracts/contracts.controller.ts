import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { type AuthUser, CurrentUser, Roles } from '../../common/auth/auth.js';
import { type ContractExtractionJob, defaultJobOptions, Q } from '../../common/queue/queues.js';
import { StorageService } from '../../common/storage.js';
import { DatabaseService } from '../../database/database.service.js';
import { contractDocuments, contracts, paymentSchedules } from '../../database/schema.js';

const ALLOWED = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

@Controller('contracts')
export class ContractsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    @InjectQueue(Q.CONTRACTS) private readonly queue: Queue<ContractExtractionJob>,
  ) {}

  /** Sube un contrato (PDF/imagen) y encola su extracción. Responde 202 con el id del documento. */
  @Post('documents')
  @Roles('admin', 'broker', 'back_office')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 30 * 1024 * 1024 } }))
  async upload(@CurrentUser() user: AuthUser, @UploadedFile() file?: { buffer: Buffer; mimetype: string }) {
    if (!file) throw new BadRequestException('Falta el archivo (campo "file")');
    const ext = ALLOWED.get(file.mimetype);
    if (!ext) throw new BadRequestException(`Tipo no soportado: ${file.mimetype}`);

    const stored = await this.storage.put(user.tenantId, 'contracts', file.buffer, ext);
    const doc = await this.db.withTenant(user.tenantId, async (tx) => {
      const [row] = await tx
        .insert(contractDocuments)
        .values({
          tenantId: user.tenantId,
          uploadedBy: user.userId,
          storagePath: stored.path,
          mimeType: file.mimetype,
          sha256: stored.sha256,
        })
        .returning({ id: contractDocuments.id });
      return row!;
    });

    // jobId por hash: re-subir el mismo archivo no dispara una segunda extracción en paralelo.
    await this.queue.add(
      'extract',
      { tenantId: user.tenantId, documentId: doc.id },
      { ...defaultJobOptions, attempts: 3, jobId: `${user.tenantId}-${stored.sha256}` },
    );
    return { documentId: doc.id, status: 'uploaded' };
  }

  @Get('documents/:id')
  async document(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const [doc] = await this.db.withTenant(user.tenantId, (tx) =>
      tx.select().from(contractDocuments).where(eq(contractDocuments.id, id)),
    );
    if (!doc) throw new NotFoundException();
    return doc;
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, async (tx) => {
      const [contract] = await tx.select().from(contracts).where(eq(contracts.id, id));
      if (!contract) throw new NotFoundException();
      const schedule = await tx
        .select()
        .from(paymentSchedules)
        .where(eq(paymentSchedules.contractId, id))
        .orderBy(paymentSchedules.periodNumber);
      return { contract, schedule };
    });
  }

  /** Un martillero/admin revisa y aprueba un contrato extraído con advertencias. */
  @Post(':id/approve')
  @Roles('admin', 'broker')
  async approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const [row] = await this.db.withTenant(user.tenantId, (tx) =>
      tx
        .update(contracts)
        .set({ status: 'active' })
        .where(and(eq(contracts.id, id), eq(contracts.status, 'needs_review')))
        .returning({ id: contracts.id }),
    );
    if (!row) throw new NotFoundException('Contrato inexistente o no pendiente de revisión');
    return { id: row.id, status: 'active' };
  }
}
