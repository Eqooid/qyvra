import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { ElasticsearchStore } from './elasticsearch-store';
import { validateTestEnvironment } from '../../../test/configuration.fixture';

describe('official client HTTP fixture (not a live Elasticsearch server)', () => {
  it('sends authenticated requests, times out without retries, and can recover on a later explicit call', async () => {
    let requests = 0,
      slow = true;
    const server = createServer((req, res) => {
      requests++;
      expect(req.headers.authorization).toBe(
        'Basic ' +
          Buffer.from('fixture:synthetic-fixture-password').toString('base64'),
      );
      const reply = () => {
        if (res.destroyed) return;
        res.setHeader('x-elastic-product', 'Elasticsearch');
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            req.url === '/'
              ? { version: { number: '9.4.6' } }
              : req.url?.startsWith('/_cluster/settings')
                ? {
                    persistent: {},
                    transient: {},
                    defaults: { action: { auto_create_index: 'false' } },
                  }
                : { status: 'green', timed_out: false },
          ),
        );
      };
      if (slow) setTimeout(reply, 2000).unref();
      else reply();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const config = validateTestEnvironment({
      DATABASE_URL: 'postgresql://localhost/search_test',
      ELASTICSEARCH_ENABLED: 'true',
      ELASTICSEARCH_URL: `http://127.0.0.1:${port}`,
      ELASTICSEARCH_ALLOW_HTTP: 'true',
      ELASTICSEARCH_USERNAME: 'fixture',
      ELASTICSEARCH_PASSWORD: 'synthetic-fixture-password',
      ELASTICSEARCH_TIMEOUT_MS: '1000',
    }).elasticsearch;
    const store = new ElasticsearchStore(config);
    try {
      await expect(store.availability()).rejects.toMatchObject({
        code: 'SEARCH_TIMEOUT',
      });
      expect(requests).toBe(1);
      slow = false;
      // A fresh request is explicitly initiated by the caller, not an automatic retry.
      expect(await store.availability()).toEqual({
        available: true,
        version: '9.4.6',
      });
      expect(requests).toBe(4);
    } finally {
      await store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
