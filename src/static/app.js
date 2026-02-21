const DEFAULT_POLL_INTERVAL_MS = 5000;
const REFRESH_INTERVAL_OPTIONS = [5000, 10000, 30000, 60000, 300000];
const REFRESH_INTERVAL_SET = new Set(REFRESH_INTERVAL_OPTIONS);
const STORAGE_INTERVAL_KEY = 'caddy_status_refresh_interval_ms';
const STORAGE_AUTO_REFRESH_KEY = 'caddy_status_auto_refresh_enabled';
const STORAGE_THEME_KEY = 'caddy_status_theme';
const THEME_OPTIONS = ['light', 'dark'];
const THEME_SET = new Set(THEME_OPTIONS);

function readStoredRefreshIntervalMs() {
  try {
    const raw = window.localStorage.getItem(STORAGE_INTERVAL_KEY);
    if (!raw) {
      return DEFAULT_POLL_INTERVAL_MS;
    }
    const parsed = Number.parseInt(raw, 10);
    return REFRESH_INTERVAL_SET.has(parsed) ? parsed : DEFAULT_POLL_INTERVAL_MS;
  } catch {
    return DEFAULT_POLL_INTERVAL_MS;
  }
}

function readStoredAutoRefreshEnabled() {
  try {
    const raw = window.localStorage.getItem(STORAGE_AUTO_REFRESH_KEY);
    if (raw == null) {
      return true;
    }
    return raw === 'true';
  } catch {
    return true;
  }
}

function readStoredTheme() {
  try {
    const raw = window.localStorage.getItem(STORAGE_THEME_KEY);
    if (raw && THEME_SET.has(raw)) {
      return raw;
    }
  } catch {
    // Ignore persistence failures in constrained browser contexts.
  }

  try {
    const mediaQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    return mediaQuery?.matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function persistRefreshSettings() {
  try {
    window.localStorage.setItem(STORAGE_INTERVAL_KEY, String(state.refreshIntervalMs));
    window.localStorage.setItem(STORAGE_AUTO_REFRESH_KEY, String(state.autoRefreshEnabled));
  } catch {
    // Ignore persistence failures in constrained browser contexts.
  }
}

function persistThemeSetting() {
  try {
    window.localStorage.setItem(STORAGE_THEME_KEY, state.theme);
  } catch {
    // Ignore persistence failures in constrained browser contexts.
  }
}

const state = {
  filter: 'all',
  servicesById: new Map(),
  snapshot: null,
  theme: readStoredTheme(),
  refreshIntervalMs: readStoredRefreshIntervalMs(),
  autoRefreshEnabled: readStoredAutoRefreshEnabled(),
  nextRefreshAt: null,
  pollTimerId: null,
  countdownTimerId: null,
  isRefreshing: false,
};

const summaryTotalEl = document.getElementById('summary-total');
const summaryUpEl = document.getElementById('summary-up');
const summaryDegradedEl = document.getElementById('summary-degraded');
const summaryDownEl = document.getElementById('summary-down');
const lastRefreshEl = document.getElementById('last-refresh');
const refreshTimerEl = document.getElementById('refresh-timer');
const refreshIntervalEl = document.getElementById('refresh-interval');
const toggleRefreshEl = document.getElementById('toggle-refresh');
const refreshNowEl = document.getElementById('refresh-now');
const servicesGridEl = document.getElementById('services-grid');
const discoveryTextEl = document.getElementById('discovery-text');
const errorBannerEl = document.getElementById('error-banner');
const templateEl = document.getElementById('service-card-template');
const hostCpuUsageEl = document.getElementById('host-cpu-usage');
const hostCpuLoadEl = document.getElementById('host-cpu-load');
const hostCpuBarEl = document.getElementById('host-cpu-bar');
const hostMemoryUsageEl = document.getElementById('host-memory-usage');
const hostMemoryBreakdownEl = document.getElementById('host-memory-breakdown');
const hostMemoryBarEl = document.getElementById('host-memory-bar');
const hostNetworkRxEl = document.getElementById('host-network-rx');
const hostNetworkTxEl = document.getElementById('host-network-tx');
const hostNetworkTotalsEl = document.getElementById('host-network-totals');
const hostUptimeEl = document.getElementById('host-uptime');
const hostMetricsSampledEl = document.getElementById('host-metrics-sampled');
const hostMetricsWarningEl = document.getElementById('host-metrics-warning');
const themeButtons = document.querySelectorAll('.theme-button');

function humanTime(isoString) {
  if (!isoString) {
    return '--';
  }
  const date = new Date(isoString);
  return date.toLocaleString();
}

function formatDuration(ms) {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

function formatUptime(seconds) {
  if (typeof seconds !== 'number' || seconds < 0) {
    return '--';
  }

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

function formatPercent(value) {
  if (typeof value !== 'number') {
    return '--';
  }
  return `${value.toFixed(1)}%`;
}

function formatBytes(value) {
  if (typeof value !== 'number' || value < 0) {
    return '--';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }

  const precision = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(precision)} ${units[unitIndex]}`;
}

function formatBytesPerSec(value) {
  if (typeof value !== 'number' || value < 0) {
    return '--/s';
  }
  return `${formatBytes(value)}/s`;
}

function formatLoad(value) {
  if (typeof value !== 'number') {
    return '--';
  }
  return value.toFixed(2);
}

function setMeterFill(element, percent) {
  if (!element) {
    return;
  }

  if (typeof percent !== 'number') {
    element.style.width = '0%';
    element.classList.add('unknown');
    return;
  }

  const clamped = Math.max(0, Math.min(100, percent));
  element.style.width = `${clamped}%`;
  element.classList.remove('unknown');
}

function renderHostMetrics(snapshot) {
  const hostMetrics = snapshot?.hostMetrics;
  if (!hostMetrics) {
    return;
  }

  const cpuPercent = hostMetrics.cpu?.usagePercent;
  if (hostCpuUsageEl) {
    const cpuText = typeof cpuPercent === 'number' ? `${formatPercent(cpuPercent)} (${hostMetrics.cpu.cores} cores)` : '--';
    hostCpuUsageEl.textContent = cpuText;
  }
  if (hostCpuLoadEl) {
    hostCpuLoadEl.textContent = [
      `Load 1m ${formatLoad(hostMetrics.cpu?.loadAverage1m)}`,
      `5m ${formatLoad(hostMetrics.cpu?.loadAverage5m)}`,
      `15m ${formatLoad(hostMetrics.cpu?.loadAverage15m)}`,
    ].join(' | ');
  }
  setMeterFill(hostCpuBarEl, cpuPercent);

  const memoryPercent = hostMetrics.memory?.usagePercent;
  if (hostMemoryUsageEl) {
    hostMemoryUsageEl.textContent = formatPercent(memoryPercent);
  }
  if (hostMemoryBreakdownEl) {
    hostMemoryBreakdownEl.textContent = `Used: ${formatBytes(hostMetrics.memory?.usedBytes)} / ${formatBytes(hostMetrics.memory?.totalBytes)}`;
  }
  setMeterFill(hostMemoryBarEl, memoryPercent);

  if (hostNetworkRxEl) {
    hostNetworkRxEl.textContent = `RX ${formatBytesPerSec(hostMetrics.network?.rxBytesPerSec)}`;
  }
  if (hostNetworkTxEl) {
    hostNetworkTxEl.textContent = `TX ${formatBytesPerSec(hostMetrics.network?.txBytesPerSec)}`;
  }
  if (hostNetworkTotalsEl) {
    hostNetworkTotalsEl.textContent = `Total: RX ${formatBytes(hostMetrics.network?.rxBytes)} | TX ${formatBytes(hostMetrics.network?.txBytes)}`;
  }

  if (hostUptimeEl) {
    hostUptimeEl.textContent = formatUptime(hostMetrics.uptimeSeconds);
  }
  if (hostMetricsSampledEl) {
    hostMetricsSampledEl.textContent = `Sampled: ${humanTime(hostMetrics.sampledAt)}`;
  }
  if (hostMetricsWarningEl) {
    const warnings = Array.isArray(hostMetrics.warnings) ? hostMetrics.warnings : [];
    if (warnings.length > 0) {
      hostMetricsWarningEl.textContent = warnings.join(' | ');
      hostMetricsWarningEl.classList.remove('hidden');
    } else {
      hostMetricsWarningEl.textContent = '';
      hostMetricsWarningEl.classList.add('hidden');
    }
  }
}

function applyTheme(theme) {
  const resolvedTheme = THEME_SET.has(theme) ? theme : 'light';
  state.theme = resolvedTheme;
  document.documentElement.dataset.theme = resolvedTheme;

  themeButtons.forEach((button) => {
    const isActive = button.dataset.theme === resolvedTheme;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function statusClass(overall) {
  if (overall === 'UP') {
    return 'status-up';
  }
  if (overall === 'DEGRADED') {
    return 'status-degraded';
  }
  return 'status-down';
}

function formatProbeStatus(probe) {
  if (!probe) {
    return 'N/A';
  }
  const code = typeof probe.statusCode === 'number' ? ` (${probe.statusCode})` : '';
  return probe.ok ? `OK${code}` : `DOWN${code}`;
}

function formatLatency(route, backend, isTcpService) {
  if (isTcpService) {
    return backend.latencyMs == null ? 'backend: --' : `backend: ${backend.latencyMs}ms`;
  }

  const routePart = route.latencyMs == null ? 'route: --' : `route: ${route.latencyMs}ms`;
  const backendPart = backend.latencyMs == null ? 'backend: --' : `backend: ${backend.latencyMs}ms`;
  return `${routePart} | ${backendPart}`;
}

function latestCheckTime(route, backend) {
  if (!route?.checkedAt) {
    return backend?.checkedAt ?? null;
  }
  if (!backend?.checkedAt) {
    return route.checkedAt;
  }
  return route.checkedAt > backend.checkedAt ? route.checkedAt : backend.checkedAt;
}

function updateSummary(snapshot) {
  summaryTotalEl.textContent = String(snapshot.summary.total);
  summaryUpEl.textContent = String(snapshot.summary.up);
  summaryDegradedEl.textContent = String(snapshot.summary.degraded);
  summaryDownEl.textContent = String(snapshot.summary.down);
  lastRefreshEl.textContent = `Last refresh: ${humanTime(snapshot.generatedAt)}`;
}

function updateDiscovery(meta) {
  if (!meta) {
    discoveryTextEl.textContent = 'No discovery metadata available yet.';
    return;
  }

  const lastDiscoveryText = meta.lastDiscoveryAt
    ? `Last discovery: ${humanTime(meta.lastDiscoveryAt)}`
    : 'No successful discovery yet';
  discoveryTextEl.textContent = `${lastDiscoveryText} | Source: ${meta.sourceConfigPath}`;

  if (meta.discoveryError) {
    errorBannerEl.textContent = `Discovery warning: ${meta.discoveryError}`;
    errorBannerEl.classList.remove('hidden');
  } else {
    errorBannerEl.classList.add('hidden');
    errorBannerEl.textContent = '';
  }
}

function renderEmpty(message) {
  servicesGridEl.innerHTML = `<div class="empty-state">${message}</div>`;
}

function renderCards(snapshot) {
  const rows = snapshot.services
    .map((status) => {
      const service = state.servicesById.get(status.serviceId) ?? {
        id: status.serviceId,
        name: status.serviceId,
        host: status.serviceId,
        routeUrl: '#',
        upstreamHost: 'unknown',
        upstreamPort: 0,
      };
      return { service, status };
    })
    .filter((entry) => (state.filter === 'unhealthy' ? entry.status.overall !== 'UP' : true));

  if (rows.length === 0) {
    renderEmpty(state.filter === 'unhealthy' ? 'No unhealthy services right now.' : 'No services discovered.');
    return;
  }

  servicesGridEl.innerHTML = '';

  rows.forEach((entry, index) => {
    const fragment = templateEl.content.cloneNode(true);

    const card = fragment.querySelector('.service-card');
    const serviceName = fragment.querySelector('.service-name');
    const serviceHost = fragment.querySelector('.service-host');
    const statusPill = fragment.querySelector('.status-pill');
    const routeStatus = fragment.querySelector('.route-status');
    const backendStatus = fragment.querySelector('.backend-status');
    const latency = fragment.querySelector('.latency-status');
    const checkedAt = fragment.querySelector('.checked-at');
    const upstream = fragment.querySelector('.upstream');
    const failures = fragment.querySelector('.failures');
    const openLink = fragment.querySelector('.open-link');
    const errorText = fragment.querySelector('.error-text');
    const isTcpService = entry.service.backendKind === 'tcp';

    card.style.setProperty('--delay', `${Math.min(index * 35, 300)}ms`);

    serviceName.textContent = entry.service.name;
    serviceHost.textContent = entry.service.host;

    statusPill.textContent = entry.status.overall;
    statusPill.classList.add(statusClass(entry.status.overall));

    if (isTcpService) {
      routeStatus.textContent = 'N/A (TCP service)';
      routeStatus.classList.add('na');
      routeStatus.classList.remove('ok', 'bad');
    } else {
      routeStatus.textContent = formatProbeStatus(entry.status.route);
      routeStatus.classList.toggle('ok', entry.status.route.ok);
      routeStatus.classList.toggle('bad', !entry.status.route.ok);
      routeStatus.classList.remove('na');
    }

    backendStatus.textContent = formatProbeStatus(entry.status.backend);
    backendStatus.classList.toggle('ok', entry.status.backend.ok);
    backendStatus.classList.toggle('bad', !entry.status.backend.ok);

    latency.textContent = formatLatency(entry.status.route, entry.status.backend, isTcpService);
    checkedAt.textContent = humanTime(latestCheckTime(entry.status.route, entry.status.backend));
    upstream.textContent = `${entry.service.upstreamHost}:${entry.service.upstreamPort}`;
    failures.textContent = String(entry.status.consecutiveFailures);

    openLink.href = entry.service.routeUrl;

    const errors = [isTcpService ? null : entry.status.route.error, entry.status.backend.error].filter(Boolean);
    if (errors.length > 0) {
      errorText.textContent = errors.join(' | ');
      errorText.classList.remove('hidden');
    } else {
      errorText.textContent = '';
      errorText.classList.add('hidden');
    }

    servicesGridEl.appendChild(fragment);
  });
}

function updateRefreshTimerText() {
  if (!refreshTimerEl) {
    return;
  }

  const intervalText = formatDuration(state.refreshIntervalMs);
  if (!state.autoRefreshEnabled) {
    refreshTimerEl.textContent = `Auto-refresh: paused (interval ${intervalText})`;
    return;
  }

  if (!state.nextRefreshAt) {
    refreshTimerEl.textContent = `Auto-refresh: every ${intervalText}`;
    return;
  }

  const remainingMs = Math.max(0, state.nextRefreshAt - Date.now());
  refreshTimerEl.textContent = `Auto-refresh: every ${intervalText} | next ${formatDuration(remainingMs)}`;
}

function clearAutoRefreshTimer() {
  if (state.pollTimerId != null) {
    clearTimeout(state.pollTimerId);
    state.pollTimerId = null;
  }
  state.nextRefreshAt = null;
}

function scheduleNextAutoRefresh() {
  clearAutoRefreshTimer();

  if (!state.autoRefreshEnabled) {
    updateRefreshTimerText();
    return;
  }

  state.nextRefreshAt = Date.now() + state.refreshIntervalMs;
  state.pollTimerId = setTimeout(async () => {
    await tick();
    scheduleNextAutoRefresh();
  }, state.refreshIntervalMs);

  updateRefreshTimerText();
}

function startRefreshTicker() {
  if (state.countdownTimerId != null) {
    clearInterval(state.countdownTimerId);
  }

  state.countdownTimerId = setInterval(() => {
    updateRefreshTimerText();
  }, 1000);
}

function setRefreshingState(isRefreshing) {
  state.isRefreshing = isRefreshing;
  if (!refreshNowEl) {
    return;
  }

  refreshNowEl.disabled = isRefreshing;
  refreshNowEl.textContent = isRefreshing ? 'Refreshing...' : 'Refresh now';
}

function updateRefreshControls() {
  if (refreshIntervalEl) {
    refreshIntervalEl.value = String(state.refreshIntervalMs);
  }

  if (toggleRefreshEl) {
    toggleRefreshEl.textContent = state.autoRefreshEnabled ? 'Pause' : 'Resume';
    toggleRefreshEl.classList.toggle('paused', !state.autoRefreshEnabled);
  }

  updateRefreshTimerText();
}

async function fetchState() {
  const [servicesResponse, statusResponse] = await Promise.all([
    fetch('/api/v1/services', { cache: 'no-store' }),
    fetch('/api/v1/status', { cache: 'no-store' }),
  ]);

  if (!servicesResponse.ok) {
    throw new Error(`services API failed with ${servicesResponse.status}`);
  }
  if (!statusResponse.ok) {
    throw new Error(`status API failed with ${statusResponse.status}`);
  }

  const servicesPayload = await servicesResponse.json();
  const statusPayload = await statusResponse.json();

  state.servicesById.clear();
  for (const service of servicesPayload.services ?? []) {
    state.servicesById.set(service.id, service);
  }

  state.snapshot = statusPayload;
  updateSummary(statusPayload);
  updateDiscovery(statusPayload.discovery ?? servicesPayload.discovery);
  renderHostMetrics(statusPayload);
  renderCards(statusPayload);
}

async function tick() {
  if (state.isRefreshing) {
    return;
  }

  setRefreshingState(true);
  try {
    await fetchState();
  } catch (error) {
    errorBannerEl.textContent = `Refresh error: ${error instanceof Error ? error.message : String(error)}`;
    errorBannerEl.classList.remove('hidden');
  } finally {
    setRefreshingState(false);
    updateRefreshTimerText();
  }
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('.filter-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === filter);
  });

  if (state.snapshot) {
    renderCards(state.snapshot);
  }
}

function initializeFilters() {
  document.querySelectorAll('.filter-button').forEach((button) => {
    button.addEventListener('click', () => {
      const filter = button.dataset.filter;
      if (!filter) {
        return;
      }
      setFilter(filter);
    });
  });
}

function initializeThemeControls() {
  applyTheme(state.theme);

  themeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const nextTheme = button.dataset.theme;
      if (!nextTheme || !THEME_SET.has(nextTheme) || nextTheme === state.theme) {
        return;
      }

      applyTheme(nextTheme);
      persistThemeSetting();
    });
  });
}

function initializeRefreshControls() {
  if (refreshIntervalEl) {
    refreshIntervalEl.value = String(state.refreshIntervalMs);
    refreshIntervalEl.addEventListener('change', () => {
      const parsed = Number.parseInt(refreshIntervalEl.value, 10);
      if (!REFRESH_INTERVAL_SET.has(parsed)) {
        refreshIntervalEl.value = String(state.refreshIntervalMs);
        return;
      }

      state.refreshIntervalMs = parsed;
      persistRefreshSettings();
      updateRefreshControls();

      if (state.autoRefreshEnabled) {
        scheduleNextAutoRefresh();
      }
    });
  }

  if (toggleRefreshEl) {
    toggleRefreshEl.addEventListener('click', () => {
      state.autoRefreshEnabled = !state.autoRefreshEnabled;
      persistRefreshSettings();

      if (state.autoRefreshEnabled) {
        scheduleNextAutoRefresh();
      } else {
        clearAutoRefreshTimer();
      }

      updateRefreshControls();
    });
  }

  if (refreshNowEl) {
    refreshNowEl.addEventListener('click', async () => {
      await tick();
      if (state.autoRefreshEnabled) {
        scheduleNextAutoRefresh();
      }
    });
  }

  setRefreshingState(false);
  updateRefreshControls();
}

initializeThemeControls();
initializeFilters();
initializeRefreshControls();
startRefreshTicker();
void tick().finally(() => {
  if (state.autoRefreshEnabled) {
    scheduleNextAutoRefresh();
  } else {
    updateRefreshTimerText();
  }
});
