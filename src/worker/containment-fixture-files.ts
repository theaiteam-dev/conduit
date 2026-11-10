/**
 * What the containment fixture (./containment-fixture.sh) writes, and when a
 * host must prove its setsid grandchild dies. Shared by the conformance suite
 * (./harness-containment.conformance.ts) and the stand-in kernel
 * (./containment-signal-runner.ts). A leaf module with no side effects, so the
 * stand-in kernel does not import the conformance suite, which runs the
 * containment probe at load.
 */
import type { Containment } from './cgroup-containment';

/** Files the fixture writes into its working directory. */
export const PID_FILE = 'containment.pid';
export const SENTINEL_FILE = 'containment.sentinel';
export const SETSID_PID_FILE = 'containment.setsid.pid';
export const SETSID_SENTINEL_FILE = 'containment.setsid.sentinel';
/** The setsid grandchild's own session id, which equals its pid when it leads a new session. */
export const SETSID_SID_FILE = 'containment.setsid.sid';

/**
 * Whether the setsid grandchild must die under `containment`. False only on a
 * host without cgroup containment that CI has not told to insist on it.
 */
export function setsidContainmentRequired(containment: Containment): boolean {
  return containment.mechanism === 'cgroup' || process.env.CONDUIT_REQUIRE_CGROUP_CONTAINMENT === '1';
}

/**
 * Whether the suites must prove Landlock write confinement (issue #122) rather
 * than skip it on a host where the probe fails. CI sets
 * CONDUIT_REQUIRE_LANDLOCK=1 after building the helper, so a runner that lost
 * the mechanism fails instead of skipping.
 */
export function writeConfinementRequired(): boolean {
  return process.env.CONDUIT_REQUIRE_LANDLOCK === '1';
}
