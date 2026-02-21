import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import type { HostMetricsSnapshot, HostNetworkMetrics } from './types.ts';

const execFileAsync = promisify(execFile);

export interface CpuTimesSnapshot {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

export interface NetworkCounterSnapshot {
  rxBytes: number;
  txBytes: number;
}

interface NetworkRateSample {
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  sampleWindowMs: number | null;
  warning?: string;
}

interface PreviousNetworkSample {
  sampledAtMs: number;
  counters: NetworkCounterSnapshot;
}

interface MemorySample {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

function clampPercent(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return Number(value.toFixed(1));
}

function cpuTimesTotal(cpu: CpuTimesSnapshot): number {
  return cpu.user + cpu.nice + cpu.sys + cpu.idle + cpu.irq;
}

function normalizeCpuTimes(cpu: os.CpuInfo): CpuTimesSnapshot {
  return {
    user: cpu.times.user,
    nice: cpu.times.nice,
    sys: cpu.times.sys,
    idle: cpu.times.idle,
    irq: cpu.times.irq,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseCounter(raw: string): number | null {
  const cleaned = raw.replaceAll(',', '');
  const parsed = Number.parseInt(cleaned, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseVmStatPages(lines: string[], key: string): number | null {
  const target = `${key}:`;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(target)) {
      continue;
    }

    const match = trimmed.match(/:\s*([\d,\.]+)/);
    if (!match) {
      return null;
    }

    const parsed = Number.parseInt(match[1].replace(/[,\.\s]/g, ''), 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

export function computeCpuUsagePercent(
  previous: CpuTimesSnapshot[] | null,
  current: CpuTimesSnapshot[],
): number | null {
  if (!previous || previous.length === 0) {
    return null;
  }
  if (previous.length !== current.length) {
    return null;
  }

  let totalDelta = 0;
  let idleDelta = 0;

  for (let i = 0; i < current.length; i += 1) {
    const prev = previous[i];
    const curr = current[i];
    const prevTotal = cpuTimesTotal(prev);
    const currTotal = cpuTimesTotal(curr);
    const nextTotalDelta = currTotal - prevTotal;
    if (nextTotalDelta < 0) {
      return null;
    }

    const nextIdleDelta = curr.idle - prev.idle;
    if (nextIdleDelta < 0) {
      return null;
    }

    totalDelta += nextTotalDelta;
    idleDelta += nextIdleDelta;
  }

  if (totalDelta <= 0) {
    return null;
  }

  return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

export function parseLinuxProcNetDev(content: string): NetworkCounterSnapshot {
  const lines = content.split(/\r?\n/);
  let rxBytes = 0;
  let txBytes = 0;
  let matched = 0;

  for (const line of lines) {
    if (!line.includes(':')) {
      continue;
    }

    const [ifaceRaw, metricsRaw] = line.split(':', 2);
    const iface = ifaceRaw.trim();
    if (!iface || iface.startsWith('lo')) {
      continue;
    }

    const columns = metricsRaw.trim().split(/\s+/);
    if (columns.length < 9) {
      continue;
    }

    const rx = parseCounter(columns[0]);
    const tx = parseCounter(columns[8]);
    if (rx == null || tx == null) {
      continue;
    }

    rxBytes += rx;
    txBytes += tx;
    matched += 1;
  }

  if (matched === 0) {
    throw new Error('No non-loopback network counters found in /proc/net/dev');
  }

  return { rxBytes, txBytes };
}

export function parseMacosNetstatIbn(content: string): NetworkCounterSnapshot {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const headerIndex = lines.findIndex((line) => line.includes('Name') && line.includes('Ibytes') && line.includes('Obytes'));
  if (headerIndex < 0) {
    throw new Error('Unable to locate Name/Ibytes/Obytes headers in netstat output');
  }

  const headerColumns = lines[headerIndex].trim().split(/\s+/);
  const nameIndex = headerColumns.indexOf('Name');
  const iBytesIndex = headerColumns.indexOf('Ibytes');
  const oBytesIndex = headerColumns.indexOf('Obytes');

  if (nameIndex < 0 || iBytesIndex < 0 || oBytesIndex < 0) {
    throw new Error('netstat output missing required columns');
  }

  const maxByInterface = new Map<string, NetworkCounterSnapshot>();
  const lastColumnIndex = Math.max(nameIndex, iBytesIndex, oBytesIndex);

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const columns = lines[i].trim().split(/\s+/);
    if (columns.length <= lastColumnIndex) {
      continue;
    }

    const iface = columns[nameIndex];
    if (!iface || iface.startsWith('lo')) {
      continue;
    }

    const rx = parseCounter(columns[iBytesIndex]);
    const tx = parseCounter(columns[oBytesIndex]);
    if (rx == null || tx == null) {
      continue;
    }

    const existing = maxByInterface.get(iface);
    if (!existing) {
      maxByInterface.set(iface, { rxBytes: rx, txBytes: tx });
      continue;
    }

    maxByInterface.set(iface, {
      rxBytes: Math.max(existing.rxBytes, rx),
      txBytes: Math.max(existing.txBytes, tx),
    });
  }

  if (maxByInterface.size === 0) {
    throw new Error('No non-loopback byte counters found in netstat output');
  }

  let rxBytes = 0;
  let txBytes = 0;
  for (const sample of maxByInterface.values()) {
    rxBytes += sample.rxBytes;
    txBytes += sample.txBytes;
  }

  return { rxBytes, txBytes };
}

export function parseMacosVmStatMemory(content: string, totalBytes: number): MemorySample {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = lines[0] ?? '';
  const pageSizeMatch = header.match(/page size of\s+(\d+)\s+bytes/i);
  if (!pageSizeMatch) {
    throw new Error('Unable to parse vm_stat page size');
  }

  const pageSize = Number.parseInt(pageSizeMatch[1], 10);
  if (Number.isNaN(pageSize) || pageSize <= 0) {
    throw new Error('vm_stat page size is invalid');
  }

  const activePages = parseVmStatPages(lines, 'Pages active');
  const wiredPages = parseVmStatPages(lines, 'Pages wired down');
  const compressedPages = parseVmStatPages(lines, 'Pages occupied by compressor')
    ?? parseVmStatPages(lines, 'Pages stored in compressor');

  if (activePages == null || wiredPages == null || compressedPages == null) {
    throw new Error('vm_stat missing active/wired/compressed page counters');
  }

  const usedBytes = Math.min(totalBytes, (activePages + wiredPages + compressedPages) * pageSize);
  const freeBytes = Math.max(0, totalBytes - usedBytes);

  return {
    totalBytes,
    usedBytes,
    freeBytes,
  };
}

export function computeNetworkRateSample(
  previous: NetworkCounterSnapshot,
  current: NetworkCounterSnapshot,
  elapsedMs: number,
): NetworkRateSample {
  if (elapsedMs <= 0) {
    return {
      rxBytesPerSec: null,
      txBytesPerSec: null,
      sampleWindowMs: null,
      warning: 'Network throughput is unavailable because sample window is invalid.',
    };
  }

  if (current.rxBytes < previous.rxBytes || current.txBytes < previous.txBytes) {
    return {
      rxBytesPerSec: null,
      txBytesPerSec: null,
      sampleWindowMs: elapsedMs,
      warning: 'Network counters were reset. Throughput will recover on the next sample.',
    };
  }

  const rxBytesPerSec = Math.round(((current.rxBytes - previous.rxBytes) * 1000) / elapsedMs);
  const txBytesPerSec = Math.round(((current.txBytes - previous.txBytes) * 1000) / elapsedMs);

  return {
    rxBytesPerSec,
    txBytesPerSec,
    sampleWindowMs: elapsedMs,
  };
}

async function readLinuxNetworkCounters(): Promise<NetworkCounterSnapshot> {
  const content = await fs.readFile('/proc/net/dev', 'utf8');
  return parseLinuxProcNetDev(content);
}

async function readMacosNetworkCounters(): Promise<NetworkCounterSnapshot> {
  const { stdout } = await execFileAsync('netstat', ['-ibn'], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  return parseMacosNetstatIbn(stdout);
}

async function readMacosMemorySample(totalBytes: number): Promise<MemorySample> {
  const { stdout } = await execFileAsync('vm_stat', [], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });

  return parseMacosVmStatMemory(stdout, totalBytes);
}

async function readNetworkCountersForPlatform(): Promise<NetworkCounterSnapshot> {
  if (process.platform === 'linux') {
    return readLinuxNetworkCounters();
  }
  if (process.platform === 'darwin') {
    return readMacosNetworkCounters();
  }

  throw new Error(`network counters are not supported on platform ${process.platform}`);
}

function emptyNetworkMetrics(): HostNetworkMetrics {
  return {
    rxBytes: null,
    txBytes: null,
    rxBytesPerSec: null,
    txBytesPerSec: null,
    sampleWindowMs: null,
  };
}

export function createUnavailableHostMetrics(warning: string): HostMetricsSnapshot {
  return {
    sampledAt: new Date().toISOString(),
    cpu: {
      usagePercent: null,
      cores: 0,
      loadAverage1m: null,
      loadAverage5m: null,
      loadAverage15m: null,
    },
    memory: {
      totalBytes: null,
      usedBytes: null,
      freeBytes: null,
      usagePercent: null,
    },
    network: emptyNetworkMetrics(),
    uptimeSeconds: null,
    warnings: [warning],
  };
}

export class HostMetricsSampler {
  private previousCpuTimes: CpuTimesSnapshot[] | null = null;

  private previousNetwork: PreviousNetworkSample | null = null;

  async sample(): Promise<HostMetricsSnapshot> {
    const sampledAt = new Date().toISOString();
    const sampledAtMs = Date.now();
    const warnings: string[] = [];

    const cpus = os.cpus();
    const currentCpuTimes = cpus.map(normalizeCpuTimes);
    const cpuUsagePercent = computeCpuUsagePercent(this.previousCpuTimes, currentCpuTimes);
    this.previousCpuTimes = currentCpuTimes;

    if (cpuUsagePercent == null) {
      warnings.push('CPU usage will be available after one additional refresh.');
    }

    const totalBytes = os.totalmem();
    let usedBytes = totalBytes - os.freemem();
    let freeBytes = totalBytes - usedBytes;

    if (process.platform === 'darwin') {
      try {
        const macMemory = await readMacosMemorySample(totalBytes);
        usedBytes = macMemory.usedBytes;
        freeBytes = macMemory.freeBytes;
      } catch (error) {
        warnings.push(`Memory metric fallback (total-free): ${toErrorMessage(error)}`);
      }
    }

    const memoryUsagePercent = totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : null;

    const load = process.platform === 'win32' ? [null, null, null] : os.loadavg();

    const network: HostNetworkMetrics = emptyNetworkMetrics();
    try {
      const counters = await readNetworkCountersForPlatform();
      network.rxBytes = counters.rxBytes;
      network.txBytes = counters.txBytes;

      if (!this.previousNetwork) {
        warnings.push('Network throughput will be available after one additional refresh.');
      } else {
        const sample = computeNetworkRateSample(
          this.previousNetwork.counters,
          counters,
          sampledAtMs - this.previousNetwork.sampledAtMs,
        );
        network.rxBytesPerSec = sample.rxBytesPerSec;
        network.txBytesPerSec = sample.txBytesPerSec;
        network.sampleWindowMs = sample.sampleWindowMs;
        if (sample.warning) {
          warnings.push(sample.warning);
        }
      }

      this.previousNetwork = {
        sampledAtMs,
        counters,
      };
    } catch (error) {
      warnings.push(`Network metrics unavailable: ${toErrorMessage(error)}`);
      this.previousNetwork = null;
    }

    return {
      sampledAt,
      cpu: {
        usagePercent: cpuUsagePercent,
        cores: cpus.length,
        loadAverage1m: load[0],
        loadAverage5m: load[1],
        loadAverage15m: load[2],
      },
      memory: {
        totalBytes,
        usedBytes,
        freeBytes,
        usagePercent: memoryUsagePercent,
      },
      network,
      uptimeSeconds: Math.round(os.uptime()),
      warnings,
    };
  }
}
