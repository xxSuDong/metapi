import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('TokenRouter dynamic model passthrough', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let dataDir = '';
  let idSeed = 0;

  const nextId = () => {
    idSeed += 1;
    return idSeed;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-dynamic-'));
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
    idSeed = 0;
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

  async function createRoutedModel(modelPattern: string, options: { platform?: string; sourceModel?: string | null } = {}) {
    const id = nextId();
    const site = await db.insert(schema.sites).values({
      name: `dynamic-site-${id}`,
      url: `https://dynamic-site-${id}.example.com`,
      platform: options.platform ?? 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `dynamic-user-${id}`,
      accessToken: `access-${id}`,
      apiToken: `sk-${id}`,
      status: 'active',
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      sourceModel: options.sourceModel ?? null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    return { site, account, route, channel };
  }

  it('passthroughs newer GPT aliases through an existing OpenAI-compatible GPT route', async () => {
    const { channel } = await createRoutedModel('gpt-5.5');
    const router = new TokenRouter();

    const dashed = await router.selectChannel('gpt-5.6');
    const compact = await router.selectChannel('gpt5.6');
    const solAlias = await router.selectChannel('5.6sol');
    const decision = await router.explainSelection('gpt-5.6');

    expect(dashed?.channel.id).toBe(channel.id);
    expect(dashed?.actualModel).toBe('gpt-5.6');
    expect(compact?.channel.id).toBe(channel.id);
    expect(compact?.actualModel).toBe('gpt5.6');
    expect(solAlias?.channel.id).toBe(channel.id);
    expect(solAlias?.actualModel).toBe('5.6sol');
    expect(decision.matched).toBe(true);
    expect(decision.modelPattern).toBe('gpt-5.6');
    expect(decision.selectedChannelId).toBe(channel.id);
  });

  it('treats k3 as a Kimi/Moonshot family alias before using generic fallback channels', async () => {
    const gpt = await createRoutedModel('gpt-5.5');
    const kimi = await createRoutedModel('kimi-code/k2.6');
    const router = new TokenRouter();

    const selected = await router.selectChannel('k3');
    const namespaced = await router.selectChannel('moonshotai/kimi-k3');
    const decision = await router.explainSelection('k3');

    expect(selected?.channel.id).toBe(kimi.channel.id);
    expect(selected?.channel.id).not.toBe(gpt.channel.id);
    expect(selected?.actualModel).toBe('k3');
    expect(namespaced?.channel.id).toBe(kimi.channel.id);
    expect(namespaced?.actualModel).toBe('moonshotai/kimi-k3');
    expect(decision.matched).toBe(true);
    expect(decision.modelPattern).toBe('k3');
    expect(decision.candidates.map((candidate) => candidate.channelId)).toEqual([kimi.channel.id]);
  });

  it('keeps dynamic passthrough candidates eligible when preserving the requested model', async () => {
    const { channel } = await createRoutedModel('gpt-5.5');
    const router = new TokenRouter();

    const decision = await router.explainSelection('gpt-5.6');

    expect(decision.selectedChannelId).toBe(channel.id);
    expect(decision.actualModel).toBe('gpt-5.6');
    expect(decision.candidates).toHaveLength(1);
    expect(decision.candidates[0]?.eligible).toBe(true);
    expect(decision.candidates[0]?.reason).not.toContain('来源模型不匹配');
  });

  it('uses healthy OpenAI-compatible channels as a last-resort passthrough for safe unknown aliases', async () => {
    const { channel } = await createRoutedModel('gpt-5.5');
    await createRoutedModel('claude-opus-4-6', { platform: 'claude' });
    const router = new TokenRouter();

    const selected = await router.selectChannel('fable5');
    const rejected = await router.selectChannel('../not-a-model');

    expect(selected?.channel.id).toBe(channel.id);
    expect(selected?.actualModel).toBe('fable5');
    expect(rejected).toBeNull();
  });
});
