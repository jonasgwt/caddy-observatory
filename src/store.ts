import type {
  BackendKind,
  DiscoveredService,
  DiscoveryMeta,
  ProbeResult,
  ServiceDetailResponse,
  ServiceHistoryEntry,
  ServiceStatus,
  StatusSnapshot,
  OverallStatus,
} from './types.ts';

interface ServiceRuntime {
  service: DiscoveredService;
  latest: ServiceStatus | null;
  history: ServiceHistoryEntry[];
  consecutiveFailures: number;
}

const STATUS_WEIGHT: Record<OverallStatus, number> = {
  DOWN: 0,
  DEGRADED: 1,
  UP: 2,
};

type StoreStatusSnapshot = Omit<StatusSnapshot, 'hostMetrics'>;

export function deriveOverallStatus(routeOk: boolean, backendOk: boolean, backendKind: BackendKind): OverallStatus {
  if (backendKind === 'tcp') {
    return backendOk ? 'UP' : 'DOWN';
  }

  if (routeOk && backendOk) {
    return 'UP';
  }
  if (routeOk || backendOk) {
    return 'DEGRADED';
  }
  return 'DOWN';
}

function placeholderProbe(message: string): ProbeResult {
  return {
    ok: false,
    latencyMs: null,
    checkedAt: new Date().toISOString(),
    error: message,
  };
}

export class StatusStore {
  private readonly services = new Map<string, ServiceRuntime>();

  private readonly historyLimit: number;

  private discoveryMeta: DiscoveryMeta;

  constructor(historyLimit: number, sourceConfigPath: string) {
    this.historyLimit = historyLimit;
    this.discoveryMeta = {
      sourceConfigPath,
      lastDiscoveryAt: null,
      discoveryError: null,
    };
  }

  setServices(nextServices: DiscoveredService[]): void {
    const nextMap = new Map<string, ServiceRuntime>();

    for (const service of nextServices) {
      const existing = this.services.get(service.id);
      if (existing) {
        nextMap.set(service.id, {
          service,
          latest: existing.latest ? { ...existing.latest, serviceId: service.id } : null,
          history: [...existing.history],
          consecutiveFailures: existing.consecutiveFailures,
        });
      } else {
        nextMap.set(service.id, {
          service,
          latest: null,
          history: [],
          consecutiveFailures: 0,
        });
      }
    }

    this.services.clear();
    for (const [key, value] of nextMap.entries()) {
      this.services.set(key, value);
    }
  }

  getServices(): DiscoveredService[] {
    return [...this.services.values()].map((entry) => entry.service);
  }

  getDiscoveryMeta(): DiscoveryMeta {
    return { ...this.discoveryMeta };
  }

  updateDiscoverySuccess(discoveredAt: string): void {
    this.discoveryMeta = {
      ...this.discoveryMeta,
      lastDiscoveryAt: discoveredAt,
      discoveryError: null,
    };
  }

  updateDiscoveryError(errorMessage: string): void {
    this.discoveryMeta = {
      ...this.discoveryMeta,
      discoveryError: errorMessage,
    };
  }

  recordProbeResult(serviceId: string, route: ProbeResult, backend: ProbeResult): void {
    const runtime = this.services.get(serviceId);
    if (!runtime) {
      return;
    }

    const overall = deriveOverallStatus(route.ok, backend.ok, runtime.service.backendKind);
    const consecutiveFailures = overall === 'UP' ? 0 : runtime.consecutiveFailures + 1;

    const latest: ServiceStatus = {
      serviceId,
      overall,
      route,
      backend,
      consecutiveFailures,
    };

    const latestCheckedAt = route.checkedAt > backend.checkedAt ? route.checkedAt : backend.checkedAt;

    const historyEntry: ServiceHistoryEntry = {
      checkedAt: latestCheckedAt,
      overall,
      routeOk: route.ok,
      backendOk: backend.ok,
      routeLatencyMs: route.latencyMs,
      backendLatencyMs: backend.latencyMs,
    };

    runtime.latest = latest;
    runtime.consecutiveFailures = consecutiveFailures;
    runtime.history.push(historyEntry);
    if (runtime.history.length > this.historyLimit) {
      runtime.history.splice(0, runtime.history.length - this.historyLimit);
    }
  }

  private effectiveStatus(runtime: ServiceRuntime): ServiceStatus {
    if (runtime.latest) {
      return runtime.latest;
    }

    return {
      serviceId: runtime.service.id,
      overall: 'DOWN',
      route: placeholderProbe('Not probed yet'),
      backend: placeholderProbe('Not probed yet'),
      consecutiveFailures: runtime.consecutiveFailures,
    };
  }

  getSnapshot(): StoreStatusSnapshot {
    const effective = [...this.services.values()].map((runtime) => this.effectiveStatus(runtime));

    effective.sort((a, b) => {
      const bySeverity = STATUS_WEIGHT[a.overall] - STATUS_WEIGHT[b.overall];
      if (bySeverity !== 0) {
        return bySeverity;
      }
      return a.serviceId.localeCompare(b.serviceId);
    });

    const summary = {
      total: effective.length,
      up: effective.filter((status) => status.overall === 'UP').length,
      degraded: effective.filter((status) => status.overall === 'DEGRADED').length,
      down: effective.filter((status) => status.overall === 'DOWN').length,
    };

    return {
      generatedAt: new Date().toISOString(),
      summary,
      services: effective,
    };
  }

  getServiceDetail(serviceId: string): ServiceDetailResponse | null {
    const runtime = this.services.get(serviceId);
    if (!runtime) {
      return null;
    }

    return {
      service: runtime.service,
      latest: runtime.latest,
      history: [...runtime.history],
    };
  }
}
