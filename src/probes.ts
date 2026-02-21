import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { DiscoveredService, ProbeResult } from './types.ts';

function nowIso(): string {
  return new Date().toISOString();
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function toProbeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const reasons = error.errors
      .map((item) => (item instanceof Error ? item.message : String(item)))
      .filter((item) => item.trim().length > 0);
    if (reasons.length > 0) {
      return reasons.join('; ');
    }
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message.trim().length > 0) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return String(error);
}

type HttpProbeOptions = {
  timeoutMs: number;
  allowInsecureTls?: boolean;
  isOkStatus: (statusCode: number) => boolean;
};

function httpProbe(url: URL, options: HttpProbeOptions): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const checkedAt = nowIso();
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    let settled = false;

    const finish = (result: ProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        timeout: options.timeoutMs,
        rejectUnauthorized: isHttps ? !options.allowInsecureTls : undefined,
        headers: {
          'User-Agent': 'caddy-service-status-dashboard/1.0',
          Accept: '*/*',
        },
      },
      (res) => {
        res.resume();
        const statusCode = typeof res.statusCode === 'number' ? res.statusCode : 0;
        const ok = options.isOkStatus(statusCode);
        finish({
          ok,
          latencyMs: Date.now() - startedAt,
          checkedAt,
          statusCode,
          error: ok ? undefined : `Unexpected status ${statusCode}`,
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${options.timeoutMs}ms`));
    });

    req.on('error', (error) => {
      finish({
        ok: false,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: toProbeError(error),
      });
    });

    req.end();
  });
}

export function probeTcp(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const checkedAt = nowIso();
    let settled = false;

    const socket = net.createConnection({ host, port });

    const finish = (result: ProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      finish({
        ok: true,
        latencyMs: Date.now() - startedAt,
        checkedAt,
      });
    });

    socket.on('timeout', () => {
      finish({
        ok: false,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: `timeout after ${timeoutMs}ms`,
      });
    });

    socket.on('error', (error) => {
      finish({
        ok: false,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: toProbeError(error),
      });
    });
  });
}

export async function probeRoute(service: DiscoveredService, timeoutMs: number): Promise<ProbeResult> {
  const routeUrl = new URL(service.routeUrl);
  routeUrl.pathname = '/';
  routeUrl.search = '';

  return httpProbe(routeUrl, {
    timeoutMs,
    allowInsecureTls: routeUrl.protocol === 'https:',
    isOkStatus: (statusCode) => statusCode >= 100 && statusCode < 500,
  });
}

export async function probeBackend(service: DiscoveredService, timeoutMs: number): Promise<ProbeResult> {
  if (service.backendKind === 'tcp') {
    return probeTcp(service.upstreamHost, service.upstreamPort, timeoutMs);
  }

  const healthPath = ensureLeadingSlash(service.healthPath ?? '/');
  const expected = new Set(service.expectedStatusCodes.length > 0 ? service.expectedStatusCodes : [200]);
  const backendUrl = new URL(`http://${service.upstreamHost}:${service.upstreamPort}${healthPath}`);

  return httpProbe(backendUrl, {
    timeoutMs,
    isOkStatus: (statusCode) => expected.has(statusCode),
  });
}
