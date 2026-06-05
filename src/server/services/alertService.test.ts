import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { mergeAccountExtraConfig } from './accountExtraConfig.js';

vi.mock('./notifyService.js', () => ({
  sendNotification: vi.fn().mockResolvedValue({
    throttled: false,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    failedChannels: [],
  }),
}));

type DbModule = typeof import('../db/index.js');

describe('alertService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-alert-service-'));
    process.env.DATA_DIR = dataDir;
    vi.resetModules();

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not expire api-key proxy-only accounts when a proxy request reports token expiration', async () => {
    const { reportTokenExpired } = await import('./alertService.js');
    const site = await db.insert(schema.sites).values({
      name: 'Relay Site',
      url: 'https://relay.example.com',
      platform: 'claude',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'relay-key',
      accessToken: '',
      apiToken: 'sk-relay-key',
      status: 'active',
      extraConfig: mergeAccountExtraConfig(null, { credentialMode: 'apikey' }),
    }).returning().get();

    await reportTokenExpired({
      accountId: account.id,
      username: account.username,
      siteName: site.name,
      detail: 'HTTP 401',
    });

    const latest = await db.select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(latest?.status).toBe('active');

    const events = await db.select()
      .from(schema.events)
      .where(eq(schema.events.relatedId, account.id))
      .all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'token',
      title: 'Token 已失效',
      relatedType: 'account',
    });
  });
});
