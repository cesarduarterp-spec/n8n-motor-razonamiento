import { Injectable } from '@nestjs/common';
import { env } from '../../config/env.js';
import { TenantSecretsService } from '../tenants/tenant-secrets.service.js';
import type { Interval } from './slots.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy'];

export const refreshTokenSecret = (userId: string) => `google_refresh_token:${userId}`;

/**
 * Cliente mínimo de Google Calendar (REST) con OAuth por asesor. El refresh
 * token vive cifrado en tenant_secrets; el access token se cachea en memoria
 * hasta 1 minuto antes de expirar.
 */
@Injectable()
export class GoogleCalendarClient {
  private readonly tokens = new Map<string, { token: string; exp: number }>();

  constructor(private readonly secrets: TenantSecretsService) {}

  isConfigured(): boolean {
    return Boolean(env().GOOGLE_OAUTH_CLIENT_ID && env().GOOGLE_OAUTH_CLIENT_SECRET);
  }

  async hasCalendar(tenantId: string, userId: string): Promise<boolean> {
    return this.isConfigured() && Boolean(await this.secrets.get(tenantId, refreshTokenSecret(userId)));
  }

  authUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: env().GOOGLE_OAUTH_CLIENT_ID ?? '',
      redirect_uri: `${env().PUBLIC_BASE_URL}/integrations/google/callback`,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent', // garantiza refresh_token
      scope: GOOGLE_SCOPES.join(' '),
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async exchangeCode(code: string): Promise<{ refreshToken: string }> {
    const res = await this.form(TOKEN_URL, {
      code,
      client_id: env().GOOGLE_OAUTH_CLIENT_ID ?? '',
      client_secret: env().GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      redirect_uri: `${env().PUBLIC_BASE_URL}/integrations/google/callback`,
      grant_type: 'authorization_code',
    });
    if (!res.refresh_token) throw new Error('Google no devolvió refresh_token');
    return { refreshToken: String(res.refresh_token) };
  }

  private async accessToken(tenantId: string, userId: string): Promise<string> {
    const key = `${tenantId}:${userId}`;
    const hit = this.tokens.get(key);
    if (hit && hit.exp > Date.now()) return hit.token;
    const refresh = await this.secrets.get(tenantId, refreshTokenSecret(userId));
    if (!refresh) throw new Error('El asesor no conectó su Google Calendar');
    const res = await this.form(TOKEN_URL, {
      client_id: env().GOOGLE_OAUTH_CLIENT_ID ?? '',
      client_secret: env().GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      refresh_token: refresh,
      grant_type: 'refresh_token',
    });
    const token = String(res.access_token);
    this.tokens.set(key, { token, exp: Date.now() + (Number(res.expires_in ?? 3600) - 60) * 1000 });
    return token;
  }

  async busy(tenantId: string, userId: string, calendarId: string, from: Date, to: Date): Promise<Interval[]> {
    const body = await this.json(tenantId, userId, `${API}/freeBusy`, 'POST', {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      items: [{ id: calendarId }],
    });
    const cal = (body.calendars as Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }>)?.[calendarId];
    if (cal?.errors?.length) throw new Error(`freeBusy: ${JSON.stringify(cal.errors)}`);
    return (cal?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  async createEvent(
    tenantId: string,
    userId: string,
    calendarId: string,
    ev: { summary: string; description: string; location?: string; start: Date; end: Date; visitId: string },
  ): Promise<string> {
    const body = await this.json(tenantId, userId, `${API}/calendars/${encodeURIComponent(calendarId)}/events`, 'POST', {
      summary: ev.summary,
      description: ev.description,
      location: ev.location,
      start: { dateTime: ev.start.toISOString() },
      end: { dateTime: ev.end.toISOString() },
      reminders: { useDefault: true },
      extendedProperties: { private: { crmVisitId: ev.visitId } },
    });
    return String(body.id);
  }

  async deleteEvent(tenantId: string, userId: string, calendarId: string, eventId: string): Promise<void> {
    await this.json(tenantId, userId, `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, 'DELETE');
  }

  private async json(tenantId: string, userId: string, url: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken(tenantId, userId)}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 204) return {};
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Google Calendar ${method} → HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  }

  private async form(url: string, data: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(url, { method: 'POST', body: new URLSearchParams(data), signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`OAuth Google → HTTP ${res.status}: ${String(json.error ?? '')}`);
    return json;
  }
}
