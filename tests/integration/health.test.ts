import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

describe('health endpoint', () => {
  afterEach(async () => {
    await app?.close();
  });

  let app: ReturnType<typeof buildApp> | undefined;

  it('reports a healthy application', async () => {
    app = buildApp({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
