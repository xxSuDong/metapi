import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('TokenRouter dynamic passthrough downstream policy', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-dynamic-policy-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  it('allows same-family dynamic models for allowed route ids without opening unrelated families', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'dynamic-allowed-route',
      url: 'https://dynamic-allowed-route.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'dynamic-allowed-user',
      accessToken: 'dynamic-allowed-access',
      apiToken: 'sk-dynamic-allowed',
      status: 'active',
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.5',
      enabled: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const policy: any = {
      allowedRouteIds: [route.id],
      supportedModels: [],
      siteWeightMultipliers: {},
      excludedSiteIds: [],
      excludedCredentialRefs: [],
      denyAllWhenEmpty: true,
    };

    const pick = await router.selectChannel('gpt-5.6', policy);
    const blocked = await router.selectChannel('claude-opus-5', policy);

    expect(pick?.channel.id).toBe(channel.id);
    expect(pick?.actualModel).toBe('gpt-5.6');
    expect(blocked).toBeNull();
  });
});
