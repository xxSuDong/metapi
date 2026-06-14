import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { ClaudeAdapter } from './claude.js';

vi.mock('../siteProxy.js', () => ({
  withSiteProxyRequestInit: (_url: string, options: unknown) => options,
}));

describe('ClaudeAdapter', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let baseUrl: string;
  const requests: Array<{ url: string | undefined; headers: IncomingMessage['headers'] }> = [];

  afterEach(async () => {
    requests.length = 0;
    if (server) {
      const s = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        s.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    return new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        requests.push({ url: req.url, headers: req.headers });
        handler(req, res);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  class TestClaudeAdapter extends ClaudeAdapter {
    protected override async fetchJson<T>(url: string, options?: Parameters<ClaudeAdapter['fetchJson']>[1]): Promise<T> {
      return super.fetchJson(url.replace('qianfan.baidubce.com', '127.0.0.1'), options);
    }
  }

  it('reads models from the configured Claude models endpoint', async () => {
    await startServer((req, res) => {
      if (req.url === '/anthropic/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-test' }] }));
        return;
      }
      res.writeHead(404).end();
    });

    const adapter = new ClaudeAdapter();
    const models = await adapter.getModels(`${baseUrl}/anthropic`, 'tp-test');

    expect(models).toEqual(['claude-sonnet-test']);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers['x-api-key']).toBe('tp-test');
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  it('falls back from /anthropic to the parent OpenAI-compatible models endpoint', async () => {
    await startServer((req, res) => {
      if (req.url === '/anthropic/v1/models') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mimo-v2.5' }, { id: 'mimo-v2.5-pro' }] }));
        return;
      }
      res.writeHead(404).end();
    });

    const adapter = new ClaudeAdapter();
    const models = await adapter.getModels(`${baseUrl}/anthropic`, 'tp-test');

    expect(models).toEqual(['mimo-v2.5', 'mimo-v2.5-pro']);
    expect(requests.map((request) => request.url)).toEqual(['/anthropic/v1/models', '/v1/models']);
    expect(requests[0].headers['x-api-key']).toBe('tp-test');
    expect(requests[1].headers.authorization).toBe('Bearer tp-test');
    expect(requests[1].headers['x-api-key']).toBeUndefined();
  });

  it('falls back from Baidu /anthropic/coding to /v2/coding models endpoint', async () => {
    await startServer((req, res) => {
      if (req.url === '/anthropic/coding/v1/models') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      if (req.url === '/v2/coding/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'ernie-x1-turbo-32k' }, { id: 'ernie-4.5-turbo-32k' }] }));
        return;
      }
      res.writeHead(404).end();
    });

    const adapter = new TestClaudeAdapter();
    const qianfanClaudeBaseUrl = `${baseUrl}/anthropic/coding`.replace('127.0.0.1', 'qianfan.baidubce.com');
    const models = await adapter.getModels(qianfanClaudeBaseUrl, 'tp-test');

    expect(models).toEqual(['ernie-x1-turbo-32k', 'ernie-4.5-turbo-32k']);
    expect(requests.map((request) => request.url)).toEqual(['/anthropic/coding/v1/models', '/v2/coding/models']);
  });

  it('does not fall back for non-anthropic base urls', async () => {
    await startServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const adapter = new ClaudeAdapter();
    const models = await adapter.getModels(baseUrl, 'tp-test');

    expect(models).toEqual([]);
    expect(requests.map((request) => request.url)).toEqual(['/v1/models']);
  });
});
