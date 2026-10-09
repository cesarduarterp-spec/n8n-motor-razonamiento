import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module.js';
import { ClaudeSpecialist } from './claude-specialist.service.js';
import { GeminiFrontline } from './gemini-frontline.service.js';
import { LlmClients } from './llm-clients.js';

/** Clientes LLM por tenant + motores. Lo usan la API (embeddings, borradores) y los workers. */
@Module({
  imports: [TenantsModule],
  providers: [LlmClients, GeminiFrontline, ClaudeSpecialist],
  exports: [LlmClients, GeminiFrontline, ClaudeSpecialist],
})
export class AgentsCoreModule {}
