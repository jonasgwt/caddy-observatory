export type BackendKind = 'http' | 'tcp';
export type OverallStatus = 'UP' | 'DEGRADED' | 'DOWN';

export interface DiscoveredService {
  id: string;
  name: string;
  host: string;
  routeUrl: string;
  upstreamHost: string;
  upstreamPort: number;
  backendKind: BackendKind;
  healthPath?: string;
  expectedStatusCodes: number[];
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  checkedAt: string;
  error?: string;
  statusCode?: number;
}

export interface ServiceStatus {
  serviceId: string;
  overall: OverallStatus;
  route: ProbeResult;
  backend: ProbeResult;
  consecutiveFailures: number;
}

export interface StatusSummary {
  total: number;
  up: number;
  degraded: number;
  down: number;
}

export interface HostCpuMetrics {
  usagePercent: number | null;
  cores: number;
  loadAverage1m: number | null;
  loadAverage5m: number | null;
  loadAverage15m: number | null;
}

export interface HostMemoryMetrics {
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  usagePercent: number | null;
}

export interface HostNetworkMetrics {
  rxBytes: number | null;
  txBytes: number | null;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  sampleWindowMs: number | null;
}

export interface HostMetricsSnapshot {
  sampledAt: string;
  cpu: HostCpuMetrics;
  memory: HostMemoryMetrics;
  network: HostNetworkMetrics;
  uptimeSeconds: number | null;
  warnings: string[];
}

export interface StatusSnapshot {
  generatedAt: string;
  summary: StatusSummary;
  services: ServiceStatus[];
  hostMetrics: HostMetricsSnapshot;
}

export interface ServiceHistoryEntry {
  checkedAt: string;
  overall: OverallStatus;
  routeOk: boolean;
  backendOk: boolean;
  routeLatencyMs: number | null;
  backendLatencyMs: number | null;
}

export interface ServiceDetailResponse {
  service: DiscoveredService;
  latest: ServiceStatus | null;
  history: ServiceHistoryEntry[];
}

export interface ServiceOverride {
  backendKind?: BackendKind;
  healthPath?: string;
  expectedStatusCodes?: number[];
  displayName?: string;
}

export interface OverridesConfig {
  services: Record<string, ServiceOverride>;
}

export interface DiscoveryMeta {
  sourceConfigPath: string;
  lastDiscoveryAt: string | null;
  discoveryError: string | null;
}
