import { promises as fs } from 'node:fs';
import type { DiscoveredService, OverridesConfig, ServiceOverride } from './types.ts';

const DEFAULT_EXPECTED_CODES = [200, 301, 302, 401, 403];

function normalizeExpectedStatusCodes(input: unknown): number[] {
  if (!Array.isArray(input)) {
    return [...DEFAULT_EXPECTED_CODES];
  }

  const codes = input
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 100 && value <= 599);

  if (codes.length === 0) {
    return [...DEFAULT_EXPECTED_CODES];
  }

  return [...new Set(codes)];
}

function parseArrayLiteral(raw: string): unknown[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner.length === 0) {
    return [];
  }
  return inner.split(',').map((item) => item.trim());
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return '';
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseArrayLiteral(trimmed).map((token) => {
      const numeric = Number(token);
      return Number.isNaN(numeric) ? token : numeric;
    });
  }

  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric)) {
    return numeric;
  }

  return trimmed;
}

function parseSimpleYaml(content: string): OverridesConfig {
  const config: OverridesConfig = { services: {} };
  let inServices = false;
  let currentHost: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const withoutComment = rawLine.split('#')[0] ?? '';
    const line = withoutComment.replace(/\t/g, '    ');
    if (line.trim().length === 0) {
      continue;
    }

    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = line.trim();

    if (indent === 0) {
      inServices = trimmed === 'services:';
      currentHost = null;
      continue;
    }

    if (!inServices) {
      continue;
    }

    if (indent === 2 && trimmed.endsWith(':')) {
      currentHost = trimmed.slice(0, -1).trim();
      if (!currentHost) {
        continue;
      }
      config.services[currentHost] = {};
      continue;
    }

    if (indent >= 4 && currentHost) {
      const separator = trimmed.indexOf(':');
      if (separator <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1);
      const parsedValue = parseScalar(rawValue);

      const current = config.services[currentHost] as Record<string, unknown>;
      current[key] = parsedValue;
    }
  }

  return config;
}

function sanitizeOverrides(input: OverridesConfig): OverridesConfig {
  const sanitized: OverridesConfig = { services: {} };

  for (const [host, rawOverride] of Object.entries(input.services ?? {})) {
    if (!rawOverride || typeof rawOverride !== 'object') {
      continue;
    }

    const typed = rawOverride as Record<string, unknown>;
    const override: ServiceOverride = {};

    if (typed.backendKind === 'http' || typed.backendKind === 'tcp') {
      override.backendKind = typed.backendKind;
    }

    if (typeof typed.healthPath === 'string' && typed.healthPath.trim().length > 0) {
      override.healthPath = typed.healthPath.trim();
    }

    if (Array.isArray(typed.expectedStatusCodes)) {
      override.expectedStatusCodes = normalizeExpectedStatusCodes(typed.expectedStatusCodes);
    }

    if (typeof typed.displayName === 'string' && typed.displayName.trim().length > 0) {
      override.displayName = typed.displayName.trim();
    }

    sanitized.services[host] = override;
  }

  return sanitized;
}

export async function loadOverridesConfig(path: string): Promise<OverridesConfig> {
  try {
    const content = await fs.readFile(path, 'utf8');
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return { services: {} };
    }

    let parsed: OverridesConfig;
    try {
      parsed = JSON.parse(trimmed) as OverridesConfig;
    } catch {
      parsed = parseSimpleYaml(content);
    }

    return sanitizeOverrides(parsed);
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException;
    if (maybeError.code === 'ENOENT') {
      return { services: {} };
    }
    throw error;
  }
}

export function applyOverrides(services: DiscoveredService[], overrides: OverridesConfig): DiscoveredService[] {
  return services.map((service) => {
    const override = overrides.services[service.host];
    if (!override) {
      return service;
    }

    const backendKind = override.backendKind ?? service.backendKind;
    const expectedStatusCodes = backendKind === 'http'
      ? normalizeExpectedStatusCodes(override.expectedStatusCodes ?? service.expectedStatusCodes)
      : [];

    const defaultHealthPath = service.healthPath ?? '/';
    const healthPath = backendKind === 'http'
      ? override.healthPath ?? defaultHealthPath
      : undefined;

    return {
      ...service,
      name: override.displayName ?? service.name,
      backendKind,
      healthPath,
      expectedStatusCodes,
    };
  });
}
