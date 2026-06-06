import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, schema } from '../../db/index.js';
import { upsertSetting } from '../../db/upsertSetting.js';
import { config } from '../../config.js';
import { eq } from 'drizzle-orm';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { parseMonitorConfigPayload } from '../../contracts/supportRoutePayloads.js';
import { getAccountsSnapshot } from '../../services/accountsOverviewService.js';

const MONITOR_AUTH_COOKIE = 'meta_monitor_auth';
const LDOH_BASE_URL = 'https://ldoh.105117.xyz';
const LDOH_COOKIE_SETTING_KEY = 'monitor_ldoh_cookie';

const limitMonitorOverviewRead = createRateLimitGuard({
  bucket: 'monitor-overview-read',
  max: 30,
  windowMs: 60_000,
});

const limitMonitorConfigRead = createRateLimitGuard({
  bucket: 'monitor-config-read',
  max: 30,
  windowMs: 60_000,
});

const limitMonitorConfigWrite = createRateLimitGuard({
  bucket: 'monitor-config-write',
  max: 10,
  windowMs: 60_000,
});

const limitMonitorSession = createRateLimitGuard({
  bucket: 'monitor-session',
  max: 10,
  windowMs: 60_000,
});

const limitMonitorProxy = createRateLimitGuard({
  bucket: 'monitor-proxy',
  max: 60,
  windowMs: 60_000,
});



async function getSettingString(key: string): Promise<string> {
  const row = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  if (!row?.value) return '';
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}

function parseCookies(raw: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw) return result;
  for (const part of raw.split(';')) {
    const entry = part.trim();
    if (!entry) continue;
    const idx = entry.indexOf('=');
    if (idx <= 0) continue;
    const key = entry.slice(0, idx).trim();
    const value = entry.slice(idx + 1).trim();
    if (!key) continue;
    result[key] = value;
  }
  return result;
}

function maskCookieValue(cookieText: string): string {
  const value = cookieText.trim();
  if (!value) return '';
  const idx = value.indexOf('=');
  const raw = idx >= 0 ? value.slice(idx + 1) : value;
  if (raw.length <= 10) return `${raw.slice(0, 2)}****`;
  return `${raw.slice(0, 6)}****${raw.slice(-4)}`;
}

function normalizeLdohCookie(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.includes('ld_auth_session=')) {
    const firstPair = trimmed.split(';')[0].trim();
    if (firstPair.startsWith('ld_auth_session=')) return firstPair;
  }
  return `ld_auth_session=${trimmed}`;
}

function rewriteProxyText(text: string): string {
  return text
    .replaceAll('https://ldoh.105117.xyz/', '/monitor-proxy/ldoh/')
    .replaceAll('https:\\/\\/ldoh.105117.xyz\\/', '\\/monitor-proxy\\/ldoh\\/')
    .replaceAll('src="/', 'src="/monitor-proxy/ldoh/')
    .replaceAll("src='/", "src='/monitor-proxy/ldoh/")
    .replaceAll('href="/', 'href="/monitor-proxy/ldoh/')
    .replaceAll("href='/", "href='/monitor-proxy/ldoh/")
    .replaceAll('action="/', 'action="/monitor-proxy/ldoh/')
    .replaceAll("action='/", "action='/monitor-proxy/ldoh/")
    .replaceAll('"/_next/', '"/monitor-proxy/ldoh/_next/')
    .replaceAll("'/_next/", "'/monitor-proxy/ldoh/_next/")
    .replaceAll('"\\/api/', '"\\/monitor-proxy\\/ldoh\\/api/')
    .replaceAll("'/api/", "'/monitor-proxy/ldoh/api/")
    .replaceAll('"/api/', '"/monitor-proxy/ldoh/api/');
}

function rewriteLocationHeader(location: string | null): string | null {
  if (!location) return null;
  if (location.startsWith(`${LDOH_BASE_URL}/`)) {
    return `/monitor-proxy/ldoh/${location.slice(LDOH_BASE_URL.length + 1)}`;
  }
  if (location.startsWith('/')) {
    return `/monitor-proxy/ldoh${location}`;
  }
  return location;
}

function ensureMonitorAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const cookies = parseCookies(request.headers.cookie);
  if (cookies[MONITOR_AUTH_COOKIE] !== config.authToken) {
    reply.code(401).send({ error: 'Missing or invalid monitor session' });
    return false;
  }
  return true;
}

function resolveLdohProxyPath(request: FastifyRequest): string {
  const rawUrl = String(request.url || '');
  const cleanPath = rawUrl.split('?')[0] || '';
  const prefix = '/monitor-proxy/ldoh';
  if (cleanPath === prefix || cleanPath === `${prefix}/`) return '';
  if (cleanPath.startsWith(`${prefix}/`)) return cleanPath.slice(prefix.length + 1);
  return String((request.params as Record<string, unknown>)['*'] || '');
}

function roundNumber(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isWithin24h(createdAt: string | null | undefined, nowMs: number): boolean {
  if (!createdAt) return false;
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp >= nowMs - 24 * 60 * 60 * 1000 && timestamp <= nowMs;
}

function isCooldownActive(value: string | null | undefined, nowMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > nowMs;
}

async function buildMonitorOverview(refresh: boolean) {
  const now = new Date();
  const nowMs = now.getTime();
  const [accountsSnapshot, routes, channels, proxyLogs] = await Promise.all([
    getAccountsSnapshot({ forceRefresh: refresh }),
    db.select().from(schema.tokenRoutes).all(),
    db.select().from(schema.routeChannels).all(),
    db.select().from(schema.proxyLogs).all(),
  ]);
  const { accounts, sites } = accountsSnapshot.payload;

  const siteById = new Map(sites.map((site) => [site.id, site]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const channelsByRouteId = new Map<number, typeof channels>();
  for (const channel of channels) {
    if (!channelsByRouteId.has(channel.routeId)) channelsByRouteId.set(channel.routeId, [] as typeof channels);
    channelsByRouteId.get(channel.routeId)!.push(channel);
  }

  const accountSummary = {
    total: accounts.length,
    healthy: 0,
    unhealthy: 0,
    unknown: 0,
    disabled: 0,
    expired: 0,
    problemItems: [] as Array<{
      id: number;
      username: string | null;
      siteId: number;
      siteName: string;
      status: string | null;
      runtimeHealth: {
        state: string;
        reason: string;
        source?: string;
        checkedAt?: string | null;
      };
    }>,
  };

  for (const account of accounts) {
    const state = account.runtimeHealth?.state || 'unknown';
    if (state === 'healthy') accountSummary.healthy += 1;
    else if (state === 'unhealthy' || state === 'degraded') accountSummary.unhealthy += 1;
    else if (state === 'disabled') accountSummary.disabled += 1;
    else accountSummary.unknown += 1;

    if (account.status === 'expired') accountSummary.expired += 1;
    if (state !== 'healthy') {
      accountSummary.problemItems.push({
        id: account.id,
        username: account.username,
        siteId: account.siteId,
        siteName: account.site?.name || siteById.get(account.siteId)?.name || '未知站点',
        status: account.status,
        runtimeHealth: {
          state,
          reason: account.runtimeHealth?.reason || '尚未检测',
          source: account.runtimeHealth?.source,
          checkedAt: account.runtimeHealth?.checkedAt,
        },
      });
    }
  }

  const routeProblemItems: Array<{
    id: number;
    title: string;
    modelPattern: string;
    enabled: boolean;
    channelCount: number;
    enabledChannelCount: number;
    cooldownChannelCount: number;
    failedChannelCount: number;
    siteNames: string[];
    decisionRefreshedAt: string | null;
  }> = [];
  let enabledRoutes = 0;
  let zeroEnabledChannels = 0;
  let cooldownChannels = 0;

  for (const route of routes) {
    if (route.enabled) enabledRoutes += 1;
    const routeChannels = channelsByRouteId.get(route.id) || [];
    const enabledChannelCount = routeChannels.filter((channel) => channel.enabled !== false).length;
    const routeCooldownCount = routeChannels.filter((channel) => isCooldownActive(channel.cooldownUntil, nowMs)).length;
    const failedChannelCount = routeChannels.filter((channel) => Number(channel.failCount || 0) > 0 || Number(channel.consecutiveFailCount || 0) > 0).length;
    cooldownChannels += routeCooldownCount;
    if (route.enabled && enabledChannelCount === 0) zeroEnabledChannels += 1;

    const siteNames = Array.from(new Set<string>(routeChannels.map((channel) => {
      const account = accountById.get(channel.accountId);
      return account?.site?.name || (account ? siteById.get(account.siteId)?.name : null) || null;
    }).filter((name): name is string => !!name)));

    if ((route.enabled && enabledChannelCount === 0) || routeCooldownCount > 0 || failedChannelCount > 0) {
      routeProblemItems.push({
        id: route.id,
        title: route.displayName || route.modelPattern,
        modelPattern: route.modelPattern,
        enabled: !!route.enabled,
        channelCount: routeChannels.length,
        enabledChannelCount,
        cooldownChannelCount: routeCooldownCount,
        failedChannelCount,
        siteNames,
        decisionRefreshedAt: route.decisionRefreshedAt,
      });
    }
  }

  const recentLogs = proxyLogs.filter((log) => isWithin24h(log.createdAt, nowMs));
  const totalLatencyRows = recentLogs.filter((log) => typeof log.latencyMs === 'number' && Number.isFinite(log.latencyMs));
  const success = recentLogs.filter((log) => log.status === 'success').length;
  const failed = recentLogs.filter((log) => log.status === 'failed').length;
  const retried = recentLogs.filter((log) => log.status === 'retried').length;
  const recentFailures = recentLogs
    .filter((log) => log.status === 'failed')
    .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
    .slice(0, 10)
    .map((log) => {
      const account = log.accountId == null ? null : accountById.get(log.accountId);
      return {
        id: log.id,
        modelRequested: log.modelRequested,
        modelActual: log.modelActual,
        siteName: account?.site?.name || (account ? siteById.get(account.siteId)?.name : null) || null,
        accountUsername: account?.username || null,
        httpStatus: log.httpStatus,
        errorMessage: log.errorMessage,
        createdAt: log.createdAt,
      };
    });

  return {
    generatedAt: now.toISOString(),
    accounts: accountSummary,
    sites: {
      total: sites.length,
      active: sites.filter((site) => site.status !== 'disabled').length,
      disabled: sites.filter((site) => site.status === 'disabled').length,
    },
    routes: {
      total: routes.length,
      enabled: enabledRoutes,
      disabled: routes.length - enabledRoutes,
      zeroEnabledChannels,
      cooldownChannels,
      problemItems: routeProblemItems,
    },
    traffic24h: {
      total: recentLogs.length,
      success,
      failed,
      retried,
      successRate: recentLogs.length > 0 ? roundNumber((success / recentLogs.length) * 100, 2) : 0,
      averageLatencyMs: totalLatencyRows.length > 0
        ? Math.round(totalLatencyRows.reduce((sum, log) => sum + Number(log.latencyMs || 0), 0) / totalLatencyRows.length)
        : null,
      totalCost: roundNumber(recentLogs.reduce((sum, log) => sum + Number(log.estimatedCost || 0), 0), 6),
      totalTokens: recentLogs.reduce((sum, log) => sum + Number(log.totalTokens || 0), 0),
      recentFailures,
    },
  };
}

export async function monitorRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>(
    '/api/monitor/overview',
    { preHandler: [limitMonitorOverviewRead] },
    async (request) => buildMonitorOverview(request.query?.refresh === '1'),
  );

  app.get('/api/monitor/config', { preHandler: [limitMonitorConfigRead] }, async () => {
    const ldohCookie = await getSettingString(LDOH_COOKIE_SETTING_KEY);
    return {
      ldohCookieConfigured: !!ldohCookie,
      ldohCookieMasked: ldohCookie ? maskCookieValue(ldohCookie) : '',
    };
  });

  app.put<{ Body: unknown }>(
    '/api/monitor/config',
    { preHandler: [limitMonitorConfigWrite] },
    async (request, reply) => {
    const parsedBody = parseMonitorConfigPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const raw = String(parsedBody.data.ldohCookie || '').trim();
    if (!raw) {
      await upsertSetting(LDOH_COOKIE_SETTING_KEY, '');
      return { success: true, message: 'LDOH Cookie 已清空', ldohCookieConfigured: false };
    }

    const normalized = normalizeLdohCookie(raw);
    if (!normalized.startsWith('ld_auth_session=') || normalized.length < 24) {
      return reply.code(400).send({ success: false, message: 'Cookie 格式无效，请填写 ld_auth_session 或其值' });
    }

    await upsertSetting(LDOH_COOKIE_SETTING_KEY, normalized);
    return {
      success: true,
      message: 'LDOH Cookie 已保存',
      ldohCookieConfigured: true,
      ldohCookieMasked: maskCookieValue(normalized),
    };
    },
  );

  app.post('/api/monitor/session', { preHandler: [limitMonitorSession] }, async (_, reply) => {
    // HttpOnly cookie for iframe proxy auth within current origin.
    reply.header(
      'Set-Cookie',
      `${MONITOR_AUTH_COOKIE}=${config.authToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200`,
    );
    return { success: true };
  });

  const handleLdohProxy = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ensureMonitorAuth(request, reply)) return;

    const storedCookie = await getSettingString(LDOH_COOKIE_SETTING_KEY);
    if (!storedCookie) {
      return reply.code(400).send('LDOH cookie not configured');
    }

    const wildcardPath = resolveLdohProxyPath(request);
    const targetUrl = new URL(`${LDOH_BASE_URL}/${wildcardPath}`);
    for (const [key, value] of Object.entries(request.query as Record<string, unknown>)) {
      if (value == null) continue;
      targetUrl.searchParams.set(key, String(value));
    }

    const upstreamHeaders: Record<string, string> = {
      cookie: storedCookie,
      accept: String(request.headers.accept || '*/*'),
      'accept-language': String(request.headers['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8'),
      'user-agent': String(request.headers['user-agent'] || 'metapiMonitorProxy/1.0'),
    };
    if (request.headers['content-type']) {
      upstreamHeaders['content-type'] = String(request.headers['content-type']);
    }
    if (request.headers.referer) {
      upstreamHeaders.referer = String(request.headers.referer).replace('/monitor-proxy/ldoh', '');
    }

    const method = request.method.toUpperCase();
    const bodyAllowed = !['GET', 'HEAD'].includes(method);
    const upstreamResponse = await fetch(targetUrl, {
      method,
      headers: upstreamHeaders,
      body: bodyAllowed ? (request.body as BodyInit | null | undefined) : undefined,
      redirect: 'manual',
    });

    const contentType = upstreamResponse.headers.get('content-type') || '';
    const location = rewriteLocationHeader(upstreamResponse.headers.get('location'));
    if (location) reply.header('location', location);
    if (contentType) reply.header('content-type', contentType);
    const cacheControl = upstreamResponse.headers.get('cache-control');
    if (cacheControl) reply.header('cache-control', cacheControl);

    reply.code(upstreamResponse.status);

    if (
      contentType.includes('text/html')
      || contentType.includes('application/javascript')
      || contentType.includes('text/javascript')
      || contentType.includes('text/css')
      || contentType.includes('application/json')
    ) {
      const text = await upstreamResponse.text();
      return reply.send(rewriteProxyText(text));
    }

    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
    return reply.send(buffer);
  };

  app.all('/monitor-proxy/ldoh', { preHandler: [limitMonitorProxy] }, handleLdohProxy);
  app.all('/monitor-proxy/ldoh/', { preHandler: [limitMonitorProxy] }, handleLdohProxy);
  app.all('/monitor-proxy/ldoh/*', { preHandler: [limitMonitorProxy] }, handleLdohProxy);
}
