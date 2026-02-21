import { discoverServices } from './discovery.ts';
import type { DiscoveryOptions, DiscoveryResult } from './discovery.ts';
import { loadOverridesConfig, applyOverrides } from './overrides.ts';
import { probeBackend, probeRoute } from './probes.ts';
import { StatusStore } from './store.ts';
import type { DiscoveredService, OverridesConfig, ProbeResult } from './types.ts';

export interface MonitorOptions {
  caddyBin: string;
  caddyfilePath: string;
  overridesPath: string;
  discoveryIntervalMs: number;
  probeIntervalMs: number;
  probeTimeoutMs: number;
  historyLimit: number;
}

type DiscoverFn = (options: DiscoveryOptions) => Promise<DiscoveryResult>;
type LoadOverridesFn = (path: string) => Promise<OverridesConfig>;
type ProbeFn = (service: DiscoveredService, timeoutMs: number) => Promise<ProbeResult>;

interface MonitorDeps {
  discoverFn: DiscoverFn;
  loadOverridesFn: LoadOverridesFn;
  probeRouteFn: ProbeFn;
  probeBackendFn: ProbeFn;
}

export class StatusMonitor {
  readonly store: StatusStore;

  private readonly options: MonitorOptions;

  private readonly deps: MonitorDeps;

  private lastCaddyMtimeMs: number | null = null;

  private discoveryTimer: NodeJS.Timeout | null = null;

  private probeTimer: NodeJS.Timeout | null = null;

  private discoverInFlight = false;

  private probeInFlight = false;

  private started = false;

  constructor(options: MonitorOptions, deps?: Partial<MonitorDeps>) {
    this.options = options;
    this.store = new StatusStore(options.historyLimit, options.caddyfilePath);
    this.deps = {
      discoverFn: deps?.discoverFn ?? discoverServices,
      loadOverridesFn: deps?.loadOverridesFn ?? loadOverridesConfig,
      probeRouteFn: deps?.probeRouteFn ?? probeRoute,
      probeBackendFn: deps?.probeBackendFn ?? probeBackend,
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    await this.refreshDiscovery(true);
    await this.runProbeCycle();

    this.discoveryTimer = setInterval(() => {
      void this.refreshDiscovery(false);
    }, this.options.discoveryIntervalMs);

    this.probeTimer = setInterval(() => {
      void this.runProbeCycle();
    }, this.options.probeIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }

    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }

    this.started = false;
  }

  async refreshDiscovery(force: boolean): Promise<void> {
    if (this.discoverInFlight) {
      return;
    }

    this.discoverInFlight = true;

    try {
      const discovery = await this.deps.discoverFn({
        caddyBin: this.options.caddyBin,
        caddyfilePath: this.options.caddyfilePath,
        previousMtimeMs: this.lastCaddyMtimeMs,
        force,
      });

      if (!discovery.skipped) {
        const overrides = await this.deps.loadOverridesFn(this.options.overridesPath);
        const merged = applyOverrides(discovery.services, overrides);
        this.store.setServices(merged);
        this.lastCaddyMtimeMs = discovery.mtimeMs;
      }

      this.store.updateDiscoverySuccess(discovery.discoveredAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateDiscoveryError(message);
    } finally {
      this.discoverInFlight = false;
    }
  }

  private async guardedProbe(service: DiscoveredService, probeFn: ProbeFn): Promise<ProbeResult> {
    try {
      return await probeFn(service, this.options.probeTimeoutMs);
    } catch (error) {
      return {
        ok: false,
        latencyMs: null,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private notApplicableRouteProbe(): ProbeResult {
    return {
      ok: true,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      error: 'Not applicable for TCP service',
    };
  }

  async runProbeCycle(): Promise<void> {
    if (this.probeInFlight) {
      return;
    }

    const services = this.store.getServices();
    if (services.length === 0) {
      return;
    }

    this.probeInFlight = true;

    try {
      await Promise.all(
        services.map(async (service) => {
          const backendProbePromise = this.guardedProbe(service, this.deps.probeBackendFn);
          const routeProbePromise = service.backendKind === 'tcp'
            ? Promise.resolve(this.notApplicableRouteProbe())
            : this.guardedProbe(service, this.deps.probeRouteFn);

          const [route, backend] = await Promise.all([routeProbePromise, backendProbePromise]);
          this.store.recordProbeResult(service.id, route, backend);
        }),
      );
    } finally {
      this.probeInFlight = false;
    }
  }
}
