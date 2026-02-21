import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createDashboardServer } from '../src/http-server.ts';
import { StatusMonitor } from '../src/monitor.ts';
import type { DiscoveredService, HostMetricsSnapshot, ProbeResult } from '../src/types.ts';

function makeProbe(ok: boolean, statusCode?: number): ProbeResult {
  return {
    ok,
    statusCode,
    latencyMs: 12,
    checkedAt: new Date().toISOString(),
    error: ok ? undefined : 'probe failed',
  };
}

async function listenOrSkip(t: test.TestContext, server: ReturnType<typeof createDashboardServer>): Promise<number> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException;
    if (maybeError.code === 'EPERM') {
      t.skip('Skipping socket-listen integration test in sandboxed environment');
      return -1;
    }
    throw error;
  }

  return (server.address() as AddressInfo).port;
}

test('status API stays stable when discovery fails after initial success', async (t) => {
  const service: DiscoveredService = {
    id: 'portal-localhost',
    name: 'Portal',
    host: 'portal.localhost',
    routeUrl: 'https://portal.localhost',
    upstreamHost: '127.0.0.1',
    upstreamPort: 8080,
    backendKind: 'http',
    healthPath: '/health',
    expectedStatusCodes: [200],
  };

  let failDiscovery = false;

  const monitor = new StatusMonitor(
    {
      caddyBin: '/opt/homebrew/opt/caddy/bin/caddy',
      caddyfilePath: '/opt/homebrew/etc/Caddyfile',
      overridesPath: '/tmp/nowhere.yaml',
      discoveryIntervalMs: 30_000,
      probeIntervalMs: 5_000,
      probeTimeoutMs: 2_000,
      historyLimit: 100,
    },
    {
      discoverFn: async () => {
        if (failDiscovery) {
          throw new Error('simulated discovery failure');
        }
        return {
          discoveredAt: new Date().toISOString(),
          mtimeMs: 1,
          skipped: false,
          services: [service],
        };
      },
      loadOverridesFn: async () => ({ services: {} }),
      probeRouteFn: async () => makeProbe(false, 502),
      probeBackendFn: async () => makeProbe(true, 200),
    },
  );

  await monitor.refreshDiscovery(true);
  await monitor.runProbeCycle();

  const hostMetricsFixture: HostMetricsSnapshot = {
    sampledAt: new Date().toISOString(),
    cpu: {
      usagePercent: 42.5,
      cores: 8,
      loadAverage1m: 1.2,
      loadAverage5m: 0.9,
      loadAverage15m: 0.7,
    },
    memory: {
      totalBytes: 16 * 1024 * 1024 * 1024,
      usedBytes: 10 * 1024 * 1024 * 1024,
      freeBytes: 6 * 1024 * 1024 * 1024,
      usagePercent: 62.5,
    },
    network: {
      rxBytes: 123_456_789,
      txBytes: 987_654_321,
      rxBytesPerSec: 12_345,
      txBytesPerSec: 23_456,
      sampleWindowMs: 5_000,
    },
    uptimeSeconds: 321_000,
    warnings: [],
  };

  const currentFile = fileURLToPath(import.meta.url);
  const staticDir = path.resolve(path.dirname(currentFile), '..', 'src', 'static');
  const server = createDashboardServer(monitor, staticDir, {
    hostMetricsProvider: {
      sample: async () => hostMetricsFixture,
    },
  });

  const port = await listenOrSkip(t, server);
  if (port === -1) {
    return;
  }
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await monitor.stop();
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  const firstStatusResponse = await fetch(`${baseUrl}/api/v1/status`);
  assert.equal(firstStatusResponse.status, 200);
  const firstStatus = await firstStatusResponse.json();

  assert.equal(firstStatus.summary.total, 1);
  assert.equal(firstStatus.services[0].overall, 'DEGRADED');
  assert.equal(firstStatus.discovery.discoveryError, null);
  assert.deepEqual(firstStatus.hostMetrics, hostMetricsFixture);

  failDiscovery = true;
  await monitor.refreshDiscovery(true);

  const secondStatusResponse = await fetch(`${baseUrl}/api/v1/status`);
  assert.equal(secondStatusResponse.status, 200);
  const secondStatus = await secondStatusResponse.json();

  assert.equal(secondStatus.summary.total, 1);
  assert.match(secondStatus.discovery.discoveryError, /simulated discovery failure/);
  assert.deepEqual(secondStatus.hostMetrics, hostMetricsFixture);

  const detailResponse = await fetch(`${baseUrl}/api/v1/status/${service.id}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.service.host, 'portal.localhost');
  assert.equal(Array.isArray(detail.history), true);
});
