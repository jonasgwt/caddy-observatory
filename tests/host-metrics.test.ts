import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCpuUsagePercent,
  computeNetworkRateSample,
  parseLinuxProcNetDev,
  parseMacosVmStatMemory,
  parseMacosNetstatIbn,
} from '../src/host-metrics.ts';

test('computeCpuUsagePercent uses delta between samples', () => {
  const usage = computeCpuUsagePercent(
    [{ user: 100, nice: 0, sys: 50, idle: 850, irq: 0 }],
    [{ user: 160, nice: 0, sys: 90, idle: 890, irq: 0 }],
  );

  assert.equal(usage, 71.4);
});

test('computeCpuUsagePercent returns null when previous sample is missing', () => {
  const usage = computeCpuUsagePercent(null, [{ user: 1, nice: 0, sys: 1, idle: 8, irq: 0 }]);
  assert.equal(usage, null);
});

test('parseLinuxProcNetDev sums non-loopback interfaces', () => {
  const sample = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0',
    '  eth0: 1000 10 0 0 0 0 0 0 3000 30 0 0 0 0 0 0',
    '  enp1s0: 500 5 0 0 0 0 0 0 700 7 0 0 0 0 0 0',
  ].join('\n');

  const counters = parseLinuxProcNetDev(sample);
  assert.deepEqual(counters, { rxBytes: 1500, txBytes: 3700 });
});

test('parseMacosNetstatIbn deduplicates interfaces using max byte counters', () => {
  const sample = [
    'Name  Mtu Network     Address            Ipkts Ierrs Opkts Oerrs Coll Drop Ibytes Obytes',
    'en0   1500 <Link#4>   ac:de:48:00:11:22  1000  0     900   0     0    0    100000 200000',
    'en0   1500 10.0.0/24  10.0.0.10          500   0     450   0     0    0    80000  150000',
    'en1   1500 <Link#5>   ac:de:48:00:33:44  400   0     300   0     0    0    40000  50000',
    'lo0   16384 <Link#1>  00:00:00:00:00:00  100   0     100   0     0    0    99999  99999',
  ].join('\n');

  const counters = parseMacosNetstatIbn(sample);
  assert.deepEqual(counters, { rxBytes: 140000, txBytes: 250000 });
});

test('parseMacosVmStatMemory aligns used memory with active+wired+compressed pages', () => {
  const pageSize = 4096;
  const totalBytes = 1000 * pageSize;
  const sample = [
    `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)`,
    'Pages free:                               100.',
    'Pages active:                             400.',
    'Pages inactive:                           150.',
    'Pages speculative:                         20.',
    'Pages wired down:                         200.',
    'Pages occupied by compressor:              50.',
  ].join('\n');

  const memory = parseMacosVmStatMemory(sample, totalBytes);
  assert.equal(memory.usedBytes, (400 + 200 + 50) * pageSize);
  assert.equal(memory.freeBytes, totalBytes - ((400 + 200 + 50) * pageSize));
});

test('parseMacosVmStatMemory falls back to stored-in-compressor counter', () => {
  const pageSize = 4096;
  const totalBytes = 500 * pageSize;
  const sample = [
    `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)`,
    'Pages active:                             100.',
    'Pages wired down:                          50.',
    'Pages stored in compressor:                25.',
  ].join('\n');

  const memory = parseMacosVmStatMemory(sample, totalBytes);
  assert.equal(memory.usedBytes, (100 + 50 + 25) * pageSize);
});

test('computeNetworkRateSample calculates throughput from cumulative counters', () => {
  const sample = computeNetworkRateSample(
    { rxBytes: 1000, txBytes: 2000 },
    { rxBytes: 4000, txBytes: 5000 },
    2000,
  );

  assert.equal(sample.rxBytesPerSec, 1500);
  assert.equal(sample.txBytesPerSec, 1500);
  assert.equal(sample.sampleWindowMs, 2000);
  assert.equal(sample.warning, undefined);
});

test('computeNetworkRateSample handles counter reset', () => {
  const sample = computeNetworkRateSample(
    { rxBytes: 5000, txBytes: 9000 },
    { rxBytes: 1000, txBytes: 1500 },
    3000,
  );

  assert.equal(sample.rxBytesPerSec, null);
  assert.equal(sample.txBytesPerSec, null);
  assert.equal(sample.sampleWindowMs, 3000);
  assert.match(sample.warning ?? '', /reset/i);
});
