import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  buildSystemdRunArguments,
  createTaskDirectory,
  finalizePublication,
  inspectMainPid,
  MAIN_PID_DIAGNOSTIC_CODES,
  publishStagedArtifact,
  TASK_DIRECTORY_MODE,
  taskSettlementDetails,
  waitForStarted,
} from '../src/resource-systemd-runner.mjs';
import { processIdentity } from '../src/resource-reference-scan.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

it('keeps task state unlistable while permitting the setuid worker to traverse absolute paths', () => {
  expect(TASK_DIRECTORY_MODE).toBe(0o711);
  expect(TASK_DIRECTORY_MODE & 0o006).toBe(0);
  expect(TASK_DIRECTORY_MODE & 0o001).toBe(0o001);
});

it('applies task traversal mode despite the owner service umask', () => {
  const root = mkdtempSync(join(tmpdir(), 'resource-task-mode-'));
  roots.push(root);
  const task = join(root, 'task-abc');
  const previous = process.umask(0o077);
  try {
    createTaskDirectory(task);
  } finally {
    process.umask(previous);
  }
  expect(statSync(task).mode & 0o777).toBe(0o711);
});

it('parses a stable process identity when comm contains spaces and parentheses', () => {
  const stat = `42 (worker (media) owner) S ${Array(18).fill('0').join(' ')} 98765 1 2`;
  expect(processIdentity(stat)).toEqual({ state: 'S', starttime: '98765' });
  expect(() => processIdentity('42 (worker) S 0')).toThrow('starttime');
});

const aliveStat = `42 (resource task) S ${Array(18).fill('0').join(' ')} 98765 1 2`;
function procError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
function identityFixture(overrides: {
  stat?: () => string;
  cgroup?: () => string;
  exe?: () => string;
} = {}) {
  return inspectMainPid(42, '/system.slice/task.service', {
    expectedExe: '/usr/bin/node',
    readFile(path: string) {
      if (path.endsWith('/stat')) return overrides.stat?.() ?? aliveStat;
      if (path.endsWith('/cgroup'))
        return overrides.cgroup?.() ?? '0::/system.slice/task.service\n';
      throw new Error(`Unexpected read: ${path}`);
    },
    realpath(path: string) {
      if (path.endsWith('/exe')) return overrides.exe?.() ?? '/usr/bin/node';
      return path;
    },
  });
}

it('distinguishes not-yet-readable MainPID fields from a confirmed mismatch', () => {
  const pending = identityFixture({
    exe: () => {
      throw procError('ENOENT', 'exe link is not populated yet');
    },
  });
  expect(pending).toMatchObject({
    status: MAIN_PID_DIAGNOSTIC_CODES.fieldsNotReady,
    checks: { exe: { result: 'not_ready' }, cgroup: { result: 'match' } },
  });
  expect(identityFixture({ exe: () => '/usr/bin/python3' })).toMatchObject({
    status: MAIN_PID_DIAGNOSTIC_CODES.identityMismatch,
    checks: { exe: { result: 'mismatch' }, cgroup: { result: 'match' } },
  });
});

it('retries only the observed systemd exec stub and keeps other executable mismatches determinate', () => {
  expect(identityFixture({ exe: () => '/usr/lib/systemd/systemd' })).toMatchObject({
    status: MAIN_PID_DIAGNOSTIC_CODES.startupTransient,
    checks: {
      exe: {
        result: 'startup_transient',
        observed: '/usr/lib/systemd/systemd',
        reason: 'systemd_exec_stub_before_target_exec',
      },
      cgroup: { result: 'match' },
    },
  });
  expect(identityFixture({ exe: () => '/usr/bin/systemd' })).toMatchObject({
    status: MAIN_PID_DIAGNOSTIC_CODES.identityMismatch,
    checks: { exe: { result: 'mismatch' }, cgroup: { result: 'match' } },
  });
});

it('distinguishes a departed MainPID from a proc field read error', () => {
  expect(
    identityFixture({
      stat: () => {
        throw procError('ENOENT', 'process has exited');
      },
    }),
  ).toMatchObject({
    status: MAIN_PID_DIAGNOSTIC_CODES.processExited,
    checks: { process: { result: 'process_exited', error: { code: 'ENOENT' } } },
  });
  expect(
    identityFixture({
      cgroup: () => {
        throw procError('EACCES', 'permission denied reading cgroup');
      },
    }),
  ).toMatchObject({
    status: MAIN_PID_DIAGNOSTIC_CODES.readError,
    checks: {
      cgroup: {
        result: 'read_error',
        error: { code: 'EACCES', message: 'permission denied reading cgroup' },
      },
    },
  });
});

it('retries only a not-ready identity inside the original startup window', async () => {
  let clock = 0;
  const inspect = vi
    .fn()
    .mockReturnValueOnce({
      status: MAIN_PID_DIAGNOSTIC_CODES.fieldsNotReady,
      pid: 42,
      checks: { exe: { result: 'not_ready', error: { code: 'ENOENT' } } },
    })
    .mockReturnValueOnce({ status: 'match', pid: 42, checks: {} });
  const result = await waitForStarted('task.service', '/result.json', 100, {
    showUnit: async () => ({
      found: true,
      MainPID: '42',
      ControlGroup: '/system.slice/task.service',
      ActiveState: 'active',
    }),
    inspectMainPid: inspect,
    exists: () => false,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    log: vi.fn(),
  });
  expect(result.mainPid).toBe(42);
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(clock).toBe(25);
});

it('retries an exact systemd exec-stub transient inside the original startup window', async () => {
  let clock = 0;
  const inspect = vi
    .fn()
    .mockReturnValueOnce({
      status: MAIN_PID_DIAGNOSTIC_CODES.startupTransient,
      pid: 42,
      checks: {
        exe: {
          result: 'startup_transient',
          observed: '/usr/lib/systemd/systemd',
          reason: 'systemd_exec_stub_before_target_exec',
        },
        cgroup: { result: 'match' },
      },
    })
    .mockReturnValueOnce({ status: 'match', pid: 42, checks: {} });
  const result = await waitForStarted('task.service', '/result.json', 100, {
    showUnit: async () => ({
      found: true,
      MainPID: '42',
      ControlGroup: '/system.slice/task.service',
      ActiveState: 'active',
    }),
    inspectMainPid: inspect,
    exists: () => false,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    log: vi.fn(),
  });
  expect(result.mainPid).toBe(42);
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(clock).toBe(25);
});

it('waits for a no-block unit to expose fields without extending the startup window', async () => {
  let clock = 0;
  const showUnit = vi
    .fn()
    .mockResolvedValueOnce({ found: false, LoadState: 'not-found', lookupError: 'not visible' })
    .mockResolvedValueOnce({
      found: true,
      MainPID: '42',
      ControlGroup: '/system.slice/task.service',
      ActiveState: 'active',
    });
  await expect(
    waitForStarted('task.service', '/result.json', 100, {
      showUnit,
      inspectMainPid: () => ({ status: 'match', pid: 42, checks: {} }),
      exists: () => false,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      log: vi.fn(),
    }),
  ).resolves.toMatchObject({ mainPid: 42 });
  expect(showUnit).toHaveBeenCalledTimes(2);
  expect(clock).toBe(25);
});

it.each([
  MAIN_PID_DIAGNOSTIC_CODES.processExited,
  MAIN_PID_DIAGNOSTIC_CODES.readError,
  MAIN_PID_DIAGNOSTIC_CODES.identityMismatch,
])('stops immediately for a determinate MainPID outcome: %s', async (status) => {
  let clock = 0;
  const logs: unknown[] = [];
  const failure = waitForStarted('task.service', '/result.json', 100, {
    showUnit: async () => ({
      found: true,
      MainPID: '42',
      ControlGroup: '/system.slice/task.service',
      ActiveState: 'active',
    }),
    inspectMainPid: () => ({
      status,
      pid: 42,
      checks: {
        cgroup: {
          result: status === MAIN_PID_DIAGNOSTIC_CODES.readError ? 'read_error' : 'mismatch',
          error: { code: 'EACCES', message: 'raw cgroup read failure' },
        },
      },
    }),
    exists: () => false,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    log: (_unit: string, diagnostic: unknown) => logs.push(diagnostic),
  });
  await expect(failure).rejects.toMatchObject({ safeDiagnosticCode: status });
  expect(clock).toBe(0);
  expect(JSON.stringify(logs)).toContain('raw cgroup read failure');
});

it('builds the bounded task unit before any Producer import', () => {
  const args = buildSystemdRunArguments(
    {
      owner: { cleanupTimeoutMs: 10_000, taskPidsMax: 256, taskSlice: 'system.slice' },
      task: { cpuMillis: 1000, memoryBytes: 805_306_368 },
    },
    'openmaic-render-abc.service',
    '/run/openmaic-resource/task-abc/request.json',
    45_001,
  );
  expect(args).toContain('--unit=openmaic-render-abc');
  expect(args).toContain('--slice=system.slice');
  expect(args).toContain('RuntimeMaxSec=46s');
  expect(args).toContain('TimeoutStopSec=25s');
  expect(args).toContain('CPUQuota=100%');
  expect(args).toContain('MemoryMax=805306368');
  expect(args).toContain('MemorySwapMax=0');
  expect(args).toContain('TasksMax=256');
  expect(args).toContain('KillMode=control-group');
  expect(args).toContain('PrivateMounts=yes');
  expect(args.at(-1)).toBe('/run/openmaic-resource/task-abc/request.json');
});

it('atomically replaces the formal artifact only at the publication commit point', () => {
  const root = mkdtempSync(join(tmpdir(), 'resource-publish-'));
  roots.push(root);
  const stage = join(root, 'stage.mp4');
  const output = join(root, 'output.mp4');
  writeFileSync(stage, 'NEW');
  writeFileSync(output, 'OLD');
  expect(publishStagedArtifact(stage, output)).toEqual({ directoryFsync: true });
  expect(readFileSync(output, 'utf8')).toBe('NEW');
});

it('preserves the old formal artifact when publication cannot reach rename', () => {
  const root = mkdtempSync(join(tmpdir(), 'resource-publish-'));
  roots.push(root);
  const output = join(root, 'output.mp4');
  writeFileSync(output, 'OLD');
  expect(() => publishStagedArtifact(join(root, 'missing-stage.mp4'), output)).toThrow();
  expect(readFileSync(output, 'utf8')).toBe('OLD');
});

it('preserves published=true and quarantines when post-publication task cleanup fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'resource-publish-cleanup-'));
  roots.push(root);
  const stage = join(root, 'stage.mp4');
  const output = join(root, 'output.mp4');
  const task = join(root, 'task');
  writeFileSync(stage, 'NEW');
  writeFileSync(output, 'OLD');
  writeFileSync(task, 'retained task evidence');
  const result = finalizePublication(stage, output, task, { task: { status: 'succeeded' } }, {
    remove(path: string, options: Parameters<typeof rmSync>[1]) {
      if (path === task) throw Object.assign(new Error('task cleanup denied'), { code: 'EACCES' });
      rmSync(path, options);
    },
  });
  expect(readFileSync(output, 'utf8')).toBe('NEW');
  expect(result).toMatchObject({
    status: 'succeeded',
    published: true,
    cleanupVerified: false,
    reservationReturned: false,
    admissionClosed: true,
    details: {
      taskDirectoryCleanup: {
        verified: false,
        remains: true,
        removalFailure: { code: 'EACCES', message: 'task cleanup denied' },
      },
    },
  });
});

it('removes and verifies staging before returning a reservation after publication fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'resource-publish-failure-'));
  roots.push(root);
  const stage = join(root, 'stage.mp4');
  const output = join(root, 'output.mp4');
  const task = join(root, 'task');
  writeFileSync(stage, 'NEW');
  writeFileSync(output, 'OLD');
  writeFileSync(task, 'task evidence');
  const result = finalizePublication(stage, output, task, {}, {
    publish() {
      throw new Error('rename failed');
    },
  });
  expect(readFileSync(output, 'utf8')).toBe('OLD');
  expect(result).toMatchObject({
    status: 'failed',
    published: false,
    cleanupVerified: true,
    reservationReturned: true,
    admissionClosed: false,
    details: {
      publishFailure: 'rename failed',
      stageCleanup: { verified: true, remains: false },
      taskDirectoryCleanup: { verified: true, remains: false },
    },
  });
});

it('quarantines a retained staging file after publication and staging cleanup both fail', () => {
  const root = mkdtempSync(join(tmpdir(), 'resource-publish-failure-'));
  roots.push(root);
  const stage = join(root, 'stage.mp4');
  const output = join(root, 'output.mp4');
  const task = join(root, 'task');
  writeFileSync(stage, 'NEW');
  writeFileSync(output, 'OLD');
  writeFileSync(task, 'task evidence');
  const result = finalizePublication(stage, output, task, {}, {
    publish() {
      throw new Error('rename failed');
    },
    remove(path: string, options: Parameters<typeof rmSync>[1]) {
      if (path === stage) throw Object.assign(new Error('stage cleanup denied'), { code: 'EACCES' });
      rmSync(path, options);
    },
  });
  expect(readFileSync(output, 'utf8')).toBe('OLD');
  expect(readFileSync(stage, 'utf8')).toBe('NEW');
  expect(result).toMatchObject({
    status: 'failed',
    published: false,
    cleanupVerified: false,
    reservationReturned: false,
    admissionClosed: true,
    details: {
      stageCleanup: {
        verified: false,
        remains: true,
        removalFailure: { code: 'EACCES', message: 'stage cleanup denied' },
      },
    },
  });
});

it('keeps task accounting separate and visible at the product settlement level', () => {
  const resourceAccounting = {
    status: 'CAPTURED',
    measurements: {
      memoryCurrent: '131072',
      memoryEvents: 'oom 0',
      memoryEventsLocal: 'oom 0',
      cpuStat: 'usage_usec 4321',
      pidsCurrent: '1',
      pidsEvents: 'max 0',
    },
    errors: {},
  };
  const task = {
    status: 'succeeded',
    cleanupVerified: true,
    details: { resourceAccounting, residual: resourceAccounting.measurements },
  };
  expect(taskSettlementDetails(task, { cgroupRemoved: true })).toMatchObject({
    task,
    resourceAccounting,
    residual: resourceAccounting.measurements,
    readback: { cgroupRemoved: true },
  });

  const accountingFailure = { cpuStat: { code: 'ENOENT', message: 'missing cpu.stat' } };
  const failedCollection = {
    status: 'failed',
    cleanupVerified: true,
    details: {
      resourceAccounting: {
        status: 'COLLECTION_FAILED',
        measurements: { memoryCurrent: '131072' },
        errors: accountingFailure,
      },
      accountingFailure,
    },
  };
  expect(taskSettlementDetails(failedCollection, { cgroupRemoved: true })).toMatchObject({
    accountingFailure,
    resourceAccounting: { status: 'COLLECTION_FAILED' },
  });
  expect(taskSettlementDetails(failedCollection, { cgroupRemoved: true })).not.toHaveProperty(
    'residual',
  );
});
