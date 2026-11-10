/**
 * The owner tag `<pid>-<start time>` that names a per-invocation resource
 * (cgroup, temp dir) after the kernel that created it, and the decision of
 * whether that kernel is gone. Shared by `cgroup-containment.ts` and
 * `stale-temp-dirs.ts`; kept free of other worker imports so the modules that
 * create temp dirs can use it without an import cycle.
 */
import { readFileSync } from 'node:fs';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as { code?: string }).code === 'EPERM';
  }
}

/**
 * The start time of process `pid`, in clock ticks since boot: field 22 of
 * /proc/<pid>/stat. Unlike a pid, the kernel does not hand the pair
 * (pid, start time) to another process. Undefined when the process is not
 * running or /proc cannot be read.
 */
export function processStartTime(pid: number): number | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
  } catch {
    return undefined;
  }
  return parseStatStartTime(stat);
}

/**
 * Field 22 (start time) of a /proc/<pid>/stat line, or undefined when the line
 * is truncated or the field is not an integer.
 */
export function parseStatStartTime(stat: string): number | undefined {
  // Field 2 is the command name in parentheses and may itself contain spaces
  // and parentheses, so count fields from the last `)`: field 3 follows it.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const field = fields[22 - 3];
  // Number('') and Number(' ') are 0, so require digits before converting.
  if (field === undefined || !/^\d+$/.test(field)) return undefined;
  const value = Number(field);
  return Number.isSafeInteger(value) ? value : undefined;
}

let ownerTagMemo: string | undefined;

/**
 * `<pid>-<start time>` of this kernel, or undefined when /proc/self/stat cannot
 * be read (non-Linux). The temp-dir callers (`taggedTempPrefix`) fall back to
 * an untagged name, which no sweep ever removes; cgroup containment
 * (`ownerTag` in cgroup-containment.ts) throws instead, so it never names a
 * cgroup without a tag.
 */
export function tryOwnerTag(): string | undefined {
  if (ownerTagMemo !== undefined) return ownerTagMemo;
  const startTime = processStartTime(process.pid);
  if (startTime === undefined) return undefined;
  ownerTagMemo = `${process.pid}-${startTime}`;
  return ownerTagMemo;
}

/** Resolved inputs of `isOwnerPairGone`. */
export interface OwnerPairDeps {
  selfPid: number;
  /** This kernel's own start time; undefined when unreadable, which is ambiguous and keeps the resource. */
  selfStartTime: number | undefined;
  isPidAlive: (pid: number) => boolean;
  processStartTime: (pid: number) => number | undefined;
}

/**
 * Whether the owner `pid` (with the recorded `startTime`, undefined for a legacy
 * name that carried none) is gone. A pid that another process has since been
 * given does not keep the resource alive, and that includes this kernel's own
 * pid. A legacy name with this kernel's pid is kept, as is one whose own start
 * time is unreadable. A legacy name, or an owner whose start time cannot be
 * read, falls back to whether the pid is running.
 */
export function isOwnerPairGone(pid: number, startTime: number | undefined, deps: OwnerPairDeps): boolean {
  if (pid === deps.selfPid) {
    if (startTime === undefined) return false;
    if (deps.selfStartTime === undefined) return false;
    return startTime !== deps.selfStartTime;
  }
  if (startTime === undefined) return !deps.isPidAlive(pid);
  const live = deps.processStartTime(pid);
  // An unreadable stat for a pid that still answers kill(0) is another user's
  // process under a `hidepid` /proc mount. Keep its resource: removing a live
  // kernel's is worse than leaving an orphan for a later sweep.
  if (live === undefined) return !deps.isPidAlive(pid);
  return live !== startTime;
}
