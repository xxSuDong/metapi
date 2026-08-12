import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildConfig, buildFastifyOptions } from './config.js';

describe('buildConfig', () => {
  it('defaults to external listen host for server deployments', () => {
    const config = buildConfig({});

    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.port).toBe(4000);
    expect(config.dataDir).toBe('./data');
  });

  it('aligns desktop deployments with server deployments for listen host', () => {
    const config = buildConfig({
      HOST: '0.0.0.0',
      METAPI_DESKTOP: '1',
      PORT: '4312',
      DATA_DIR: '/tmp/metapi-data',
    });

    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.port).toBe(4312);
    expect(config.dataDir).toBe('/tmp/metapi-data');
  });

  it('honors explicit loopback host outside desktop mode', () => {
    const config = buildConfig({
      HOST: '127.0.0.1',
    });

    expect(config.listenHost).toBe('127.0.0.1');
  });

  it('defaults telegram api base url to the official endpoint', () => {
    const config = buildConfig({});

    expect(config.telegramApiBaseUrl).toBe('https://api.telegram.org');
    expect(config.telegramMessageThreadId).toBe('');
  });

  it('accepts telegram message thread id from environment', () => {
    const config = buildConfig({
      TELEGRAM_MESSAGE_THREAD_ID: '77',
    });

    expect(config.telegramMessageThreadId).toBe('77');
  });

  it('ships CLI-aligned OAuth defaults', () => {
    const config = buildConfig({});

    expect(config.codexClientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(config.codexResponsesWebsocketBeta).toBe('responses_websockets=2026-02-06');
    expect(config.claudeClientId).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(config.claudeClientSecret).toBe('');
    expect(config.geminiCliClientId).toBe('681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
    expect(config.geminiCliClientSecret).toBe('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');
  });

  it('allows overriding the codex websocket beta gate from environment', () => {
    const config = buildConfig({
      CODEX_RESPONSES_WEBSOCKET_BETA: 'responses_websockets=2099-01-01',
    });

    expect(config.codexResponsesWebsocketBeta).toBe('responses_websockets=2099-01-01');
  });

  it('uses a larger default request body limit for long Codex payloads', () => {
    const config = buildConfig({});
    const fastifyOptions = buildFastifyOptions(config);

    expect(config.requestBodyLimit).toBe(100 * 1024 * 1024);
    expect(fastifyOptions.bodyLimit).toBe(100 * 1024 * 1024);
  });

  it('allows request body limit overrides from environment', () => {
    const config = buildConfig({
      REQUEST_BODY_LIMIT_MB: '128',
    });
    const bytesConfig = buildConfig({
      REQUEST_BODY_LIMIT_BYTES: String(150 * 1024 * 1024),
      REQUEST_BODY_LIMIT_MB: '128',
    });

    expect(config.requestBodyLimit).toBe(128 * 1024 * 1024);
    expect(bytesConfig.requestBodyLimit).toBe(150 * 1024 * 1024);
  });

  it('accepts long Codex-sized JSON request bodies', async () => {
    const app = Fastify(buildFastifyOptions(buildConfig({})));
    const largeText = 'a'.repeat(21 * 1024 * 1024);

    app.post('/echo', async (request) => {
      const body = request.body as { text?: string };
      return { textLength: body.text?.length ?? 0 };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { text: largeText },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ textLength: largeText.length });
    await app.close();
  });

  it('trusts forwarded client IP headers for reverse-proxy deployments', async () => {
    const app = Fastify(buildFastifyOptions(buildConfig({})));

    app.get('/ip', async (request) => ({
      ip: request.ip,
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '10.0.0.8',
      headers: {
        'x-forwarded-for': '203.0.113.5, 10.0.0.8',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ip: '203.0.113.5' });
    await app.close();
  });
});
