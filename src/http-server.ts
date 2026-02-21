import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createUnavailableHostMetrics, HostMetricsSampler } from './host-metrics.ts';
import { StatusMonitor } from './monitor.ts';
import type { HostMetricsSnapshot } from './types.ts';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function jsonResponse(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function textResponse(res: http.ServerResponse, statusCode: number, payload: string): void {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function notFound(res: http.ServerResponse): void {
  jsonResponse(res, 404, { error: 'Not found' });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function serveStaticFile(
  res: http.ServerResponse,
  staticDir: string,
  pathname: string,
): Promise<void> {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(safePath).replace(/^\.+/, '');
  const absolutePath = path.join(staticDir, normalized);

  if (!absolutePath.startsWith(staticDir)) {
    notFound(res);
    return;
  }

  try {
    const data = await fs.readFile(absolutePath);
    const ext = path.extname(absolutePath).toLowerCase();
    const mime = MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60',
    });
    res.end(data);
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException;
    if (maybeError.code === 'ENOENT') {
      notFound(res);
      return;
    }
    jsonResponse(res, 500, { error: 'Failed to serve static file' });
  }
}

export interface HostMetricsProvider {
  sample(): Promise<HostMetricsSnapshot>;
}

export interface DashboardServerOptions {
  hostMetricsProvider?: HostMetricsProvider;
}

export function createDashboardServer(
  monitor: StatusMonitor,
  staticDir: string,
  options?: DashboardServerOptions,
): http.Server {
  const hostMetricsProvider = options?.hostMetricsProvider ?? new HostMetricsSampler();

  return http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        notFound(res);
        return;
      }

      const method = req.method ?? 'GET';
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const pathname = url.pathname;

      if (pathname.startsWith('/api/')) {
        if (method !== 'GET') {
          jsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }

        if (pathname === '/api/v1/services') {
          jsonResponse(res, 200, {
            generatedAt: new Date().toISOString(),
            discovery: monitor.store.getDiscoveryMeta(),
            services: monitor.store.getServices(),
          });
          return;
        }

        if (pathname === '/api/v1/status') {
          let hostMetrics: HostMetricsSnapshot;
          try {
            hostMetrics = await hostMetricsProvider.sample();
          } catch (error) {
            hostMetrics = createUnavailableHostMetrics(`Host metrics unavailable: ${toErrorMessage(error)}`);
          }

          jsonResponse(res, 200, {
            ...monitor.store.getSnapshot(),
            discovery: monitor.store.getDiscoveryMeta(),
            hostMetrics,
          });
          return;
        }

        if (pathname.startsWith('/api/v1/status/')) {
          const serviceId = decodeURIComponent(pathname.slice('/api/v1/status/'.length));
          const detail = monitor.store.getServiceDetail(serviceId);
          if (!detail) {
            notFound(res);
            return;
          }
          jsonResponse(res, 200, {
            generatedAt: new Date().toISOString(),
            discovery: monitor.store.getDiscoveryMeta(),
            ...detail,
          });
          return;
        }

        if (pathname === '/api/v1/health') {
          jsonResponse(res, 200, { ok: true, checkedAt: new Date().toISOString() });
          return;
        }

        notFound(res);
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        textResponse(res, 405, 'Method not allowed');
        return;
      }

      await serveStaticFile(res, staticDir, pathname);
    } catch (error) {
      jsonResponse(res, 500, {
        error: 'Unhandled server error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
