import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer } from './http-server.ts';
import { StatusMonitor } from './monitor.ts';

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function main(): Promise<void> {
  const currentFile = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(currentFile), '..');

  const host = process.env.DASHBOARD_HOST ?? '127.0.0.1';
  const port = readPositiveInt('DASHBOARD_PORT', 9079);
  const caddyBin = process.env.CADDY_BIN ?? '/opt/homebrew/opt/caddy/bin/caddy';
  const caddyfilePath = process.env.CADDYFILE_PATH ?? '/opt/homebrew/etc/Caddyfile';
  const overridesPath = process.env.OVERRIDES_PATH ?? path.join(projectRoot, 'config', 'services.overrides.yaml');

  const discoveryIntervalMs = readPositiveInt('DISCOVERY_INTERVAL_MS', 30_000);
  const probeIntervalMs = readPositiveInt('PROBE_INTERVAL_MS', 5_000);
  const probeTimeoutMs = readPositiveInt('PROBE_TIMEOUT_MS', 2_000);
  const historyLimit = readPositiveInt('HISTORY_LIMIT', 100);

  const monitor = new StatusMonitor({
    caddyBin,
    caddyfilePath,
    overridesPath,
    discoveryIntervalMs,
    probeIntervalMs,
    probeTimeoutMs,
    historyLimit,
  });

  await monitor.start();

  const staticDir = path.join(projectRoot, 'src', 'static');
  const server = createDashboardServer(monitor, staticDir);

  const closeServer = async (): Promise<void> => {
    await monitor.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  const handleShutdown = (signal: string): void => {
    console.log(`[dashboard] received ${signal}, shutting down...`);
    void closeServer()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('[dashboard] shutdown error:', error);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  server.on('error', (error) => {
    console.error('[dashboard] server listen error:', error);
    void monitor.stop().finally(() => process.exit(1));
  });

  server.listen(port, host, () => {
    console.log(`[dashboard] listening on http://${host}:${port}`);
    console.log(`[dashboard] discovery source: ${caddyfilePath}`);
  });
}

void main().catch((error) => {
  console.error('[dashboard] startup failed:', error);
  process.exit(1);
});
