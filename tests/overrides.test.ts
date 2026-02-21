import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { applyOverrides, loadOverridesConfig } from '../src/overrides.ts';
import type { DiscoveredService } from '../src/types.ts';

test('loadOverridesConfig and applyOverrides merge values correctly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'caddy-overrides-'));
  const file = path.join(dir, 'services.overrides.yaml');

  await fs.writeFile(file, [
    'services:',
    '  portal.localhost:',
    '    displayName: Portal UI',
    '    backendKind: http',
    '    healthPath: /healthz',
    '    expectedStatusCodes: [200, 204]',
  ].join('\n'));

  const config = await loadOverridesConfig(file);
  const base: DiscoveredService[] = [
    {
      id: 'portal-localhost',
      name: 'Portal',
      host: 'portal.localhost',
      routeUrl: 'https://portal.localhost',
      upstreamHost: 'localhost',
      upstreamPort: 8080,
      backendKind: 'http',
      healthPath: '/',
      expectedStatusCodes: [200, 301, 302, 401, 403],
    },
  ];

  const merged = applyOverrides(base, config);
  assert.equal(merged[0].name, 'Portal UI');
  assert.equal(merged[0].healthPath, '/healthz');
  assert.deepEqual(merged[0].expectedStatusCodes, [200, 204]);
});
