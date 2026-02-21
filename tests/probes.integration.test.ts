import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { probeBackend, probeRoute } from '../src/probes.ts';
import type { DiscoveredService } from '../src/types.ts';

const execFileAsync = promisify(execFile);

function makeService(base: Partial<DiscoveredService>): DiscoveredService {
  return {
    id: base.id ?? 'svc',
    name: base.name ?? 'svc',
    host: base.host ?? 'svc.localhost',
    routeUrl: base.routeUrl ?? 'https://svc.localhost',
    upstreamHost: base.upstreamHost ?? '127.0.0.1',
    upstreamPort: base.upstreamPort ?? 1,
    backendKind: base.backendKind ?? 'http',
    healthPath: base.healthPath,
    expectedStatusCodes: base.expectedStatusCodes ?? [200],
  };
}

async function listenOrSkip(
  t: test.TestContext,
  server: http.Server | https.Server | net.Server,
): Promise<number> {
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

async function makeSelfSignedCertOrSkip(
  t: test.TestContext,
): Promise<{ key: Buffer; cert: Buffer } | null> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'caddy-dashboard-cert-'));
  const keyPath = path.join(tempDir, 'key.pem');
  const certPath = path.join(tempDir, 'cert.pem');

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  try {
    await execFileAsync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ]);
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException;
    if (maybeError.code === 'ENOENT') {
      t.skip('Skipping self-signed route probe test because openssl is unavailable');
      return null;
    }
    throw error;
  }

  const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
  return { key, cert };
}

test('backend probes work for http and tcp services', async (t) => {
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const httpPort = await listenOrSkip(t, httpServer);
  if (httpPort === -1) {
    return;
  }
  t.after(() => httpServer.close());

  const tcpServer = net.createServer((socket) => {
    socket.end();
  });
  const tcpPort = await listenOrSkip(t, tcpServer);
  if (tcpPort === -1) {
    return;
  }
  t.after(() => tcpServer.close());

  const httpService = makeService({
    id: 'http-service',
    host: 'http.localhost',
    upstreamPort: httpPort,
    backendKind: 'http',
    healthPath: '/health',
    expectedStatusCodes: [200],
  });

  const tcpService = makeService({
    id: 'tcp-service',
    host: 'tcp.localhost',
    upstreamPort: tcpPort,
    backendKind: 'tcp',
    expectedStatusCodes: [],
  });

  const [httpResult, tcpResult] = await Promise.all([
    probeBackend(httpService, 2000),
    probeBackend(tcpService, 2000),
  ]);

  assert.equal(httpResult.ok, true);
  assert.equal(tcpResult.ok, true);
});

test('route probe accepts self-signed certificate', async (t) => {
  const certPair = await makeSelfSignedCertOrSkip(t);
  if (!certPair) {
    return;
  }

  const tlsServer = https.createServer(certPair, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });

  const tlsPort = await listenOrSkip(t, tlsServer);
  if (tlsPort === -1) {
    return;
  }
  t.after(() => tlsServer.close());

  const service = makeService({
    id: 'route-service',
    host: 'route.localhost',
    routeUrl: `https://127.0.0.1:${tlsPort}`,
    upstreamPort: tlsPort,
    backendKind: 'tcp',
    expectedStatusCodes: [],
  });

  const routeResult = await probeRoute(service, 2000);
  assert.equal(routeResult.ok, true);
  assert.equal(routeResult.statusCode, 200);
});
