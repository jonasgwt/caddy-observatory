import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import type { DiscoveredService, BackendKind } from './types.ts';

const execFileAsync = promisify(execFile);

const DEFAULT_EXPECTED_CODES = [200, 301, 302, 401, 403];
const TCP_DEFAULT_PORTS = new Set([3306, 3307, 6379]);

type RouteTarget = {
  host: string;
  scheme: 'http' | 'https';
  upstreamHost: string;
  upstreamPort: number;
};

export interface DiscoveryOptions {
  caddyBin: string;
  caddyfilePath: string;
  previousMtimeMs: number | null;
  force?: boolean;
}

export interface DiscoveryResult {
  discoveredAt: string;
  mtimeMs: number;
  skipped: boolean;
  services: DiscoveredService[];
}

export function inferBackendKindForPort(port: number): BackendKind {
  return TCP_DEFAULT_PORTS.has(port) ? 'tcp' : 'http';
}

export function deriveServiceName(host: string): string {
  const left = host.split('.')[0] ?? host;
  if (left.length === 0) {
    return host;
  }
  return left
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function createServiceId(host: string): string {
  const clean = host.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return clean.length > 0 ? clean : `service-${Date.now()}`;
}

export function parseDialAddress(dial: string): { host: string; port: number } | null {
  if (!dial || typeof dial !== 'string') {
    return null;
  }

  if (dial.startsWith('unix/') || dial.startsWith('unix//')) {
    return null;
  }

  const ipv6 = dial.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) {
    const port = Number.parseInt(ipv6[2], 10);
    if (Number.isNaN(port)) {
      return null;
    }
    return { host: ipv6[1], port };
  }

  const separator = dial.lastIndexOf(':');
  if (separator <= 0 || separator === dial.length - 1) {
    return null;
  }

  const host = dial.slice(0, separator);
  const port = Number.parseInt(dial.slice(separator + 1), 10);
  if (Number.isNaN(port)) {
    return null;
  }

  return { host, port };
}

export function parseAdaptOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error('caddy adapt returned empty output');
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const appsMarker = '"apps"';
    const markerIndex = trimmed.lastIndexOf(appsMarker);
    if (markerIndex < 0) {
      throw new Error('Unable to locate adapted Caddy JSON payload in caddy output');
    }

    let cursor = trimmed.lastIndexOf('{', markerIndex);
    while (cursor >= 0) {
      const candidate = trimmed.slice(cursor).trim();
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && 'apps' in (parsed as Record<string, unknown>)) {
          return parsed;
        }
      } catch {
        // Keep searching for the next object boundary.
      }
      cursor = trimmed.lastIndexOf('{', cursor - 1);
    }

    throw new Error('Unable to parse adapted Caddy JSON payload');
  }
}

function listenToScheme(listen: string[]): 'http' | 'https' {
  if (listen.some((entry) => entry.includes(':443'))) {
    return 'https';
  }
  return 'http';
}

function collectHosts(route: Record<string, unknown>, inheritedHosts: string[]): string[] {
  const hosts = new Set(inheritedHosts);

  const matchers = Array.isArray(route.match) ? route.match : [];
  for (const matcher of matchers) {
    if (!matcher || typeof matcher !== 'object') {
      continue;
    }
    const hostList = (matcher as Record<string, unknown>).host;
    if (!Array.isArray(hostList)) {
      continue;
    }
    for (const host of hostList) {
      if (typeof host === 'string' && host.length > 0) {
        hosts.add(host);
      }
    }
  }

  return [...hosts];
}

function walkRoutes(
  routes: unknown[],
  inheritedHosts: string[],
  scheme: 'http' | 'https',
  out: RouteTarget[],
): void {
  for (const routeValue of routes) {
    if (!routeValue || typeof routeValue !== 'object') {
      continue;
    }

    const route = routeValue as Record<string, unknown>;
    const currentHosts = collectHosts(route, inheritedHosts);

    const handles = Array.isArray(route.handle) ? route.handle : [];
    for (const handleValue of handles) {
      if (!handleValue || typeof handleValue !== 'object') {
        continue;
      }

      const handle = handleValue as Record<string, unknown>;
      if (handle.handler === 'reverse_proxy' && Array.isArray(handle.upstreams)) {
        for (const upstreamValue of handle.upstreams) {
          if (!upstreamValue || typeof upstreamValue !== 'object') {
            continue;
          }
          const dial = (upstreamValue as Record<string, unknown>).dial;
          if (typeof dial !== 'string') {
            continue;
          }
          const parsed = parseDialAddress(dial);
          if (!parsed) {
            continue;
          }

          for (const host of currentHosts) {
            out.push({
              host,
              scheme,
              upstreamHost: parsed.host,
              upstreamPort: parsed.port,
            });
          }
        }
      }

      if (Array.isArray(handle.routes)) {
        walkRoutes(handle.routes, currentHosts, scheme, out);
      }
    }

    if (Array.isArray(route.routes)) {
      walkRoutes(route.routes, currentHosts, scheme, out);
    }
  }
}

export function parseAdaptedCaddyConfig(config: unknown): RouteTarget[] {
  if (!config || typeof config !== 'object') {
    throw new Error('Adapted Caddy config is not an object');
  }

  const root = config as Record<string, unknown>;
  const apps = root.apps;
  if (!apps || typeof apps !== 'object') {
    throw new Error('Adapted Caddy config missing apps');
  }

  const httpApp = (apps as Record<string, unknown>).http;
  if (!httpApp || typeof httpApp !== 'object') {
    return [];
  }

  const servers = (httpApp as Record<string, unknown>).servers;
  if (!servers || typeof servers !== 'object') {
    return [];
  }

  const collected: RouteTarget[] = [];

  for (const serverValue of Object.values(servers)) {
    if (!serverValue || typeof serverValue !== 'object') {
      continue;
    }

    const server = serverValue as Record<string, unknown>;
    const listen = Array.isArray(server.listen)
      ? server.listen.filter((entry): entry is string => typeof entry === 'string')
      : [];

    const scheme = listenToScheme(listen);
    const routes = Array.isArray(server.routes) ? server.routes : [];
    walkRoutes(routes, [], scheme, collected);
  }

  const byHost = new Map<string, RouteTarget>();
  for (const target of collected) {
    if (!byHost.has(target.host)) {
      byHost.set(target.host, target);
    }
  }

  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
}

export async function discoverServices(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const caddyfileStat = await fs.stat(options.caddyfilePath);
  const mtimeMs = caddyfileStat.mtimeMs;

  if (!options.force && options.previousMtimeMs !== null && options.previousMtimeMs === mtimeMs) {
    return {
      discoveredAt: new Date().toISOString(),
      mtimeMs,
      skipped: true,
      services: [],
    };
  }

  const { stdout } = await execFileAsync(options.caddyBin, [
    'adapt',
    '--config',
    options.caddyfilePath,
    '--adapter',
    'caddyfile',
    '--pretty',
  ], {
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8',
  });

  const adapted = parseAdaptOutput(stdout);
  const targets = parseAdaptedCaddyConfig(adapted);

  const services: DiscoveredService[] = targets.map((target) => {
    const backendKind = inferBackendKindForPort(target.upstreamPort);
    return {
      id: createServiceId(target.host),
      name: deriveServiceName(target.host),
      host: target.host,
      routeUrl: `${target.scheme}://${target.host}`,
      upstreamHost: target.upstreamHost,
      upstreamPort: target.upstreamPort,
      backendKind,
      healthPath: backendKind === 'http' ? '/' : undefined,
      expectedStatusCodes: backendKind === 'http' ? [...DEFAULT_EXPECTED_CODES] : [],
    };
  });

  return {
    discoveredAt: new Date().toISOString(),
    mtimeMs,
    skipped: false,
    services,
  };
}
