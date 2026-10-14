/**
 * Issue #47: a storage error in the ingress re-drive sweep must not end
 * `conduit listen`.
 *
 * The journey seeds a failed ingress event, then makes every UPDATE of
 * `ingress_events` fail with SQLite's disk-full message (a trigger added from
 * outside the listener). The periodic sweep finds the row and its attempt
 * increment throws. The shipped listener must keep serving, print one alert
 * for the run of failed sweeps, record the failure in `ingress_log`, and
 * re-drive the row on a later tick once the fault clears.
 *
 * BLACK-BOX: imports only the journey harness and bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startJourneyHarness } from "./harness/journey-harness";

const FAULT_TIMEOUT_MS = 90_000;
const REDRIVE_INTERVAL_MS = 250;
const EVENT_ID = "evt-sweep-disk-full";
const ALERT_MARKER = "event=redrive-sweep";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("issue #47: a storage error in the re-drive sweep does not kill the listener", () => {
  let h: Awaited<ReturnType<typeof startJourneyHarness>>;

  beforeAll(async () => {
    h = await startJourneyHarness({ redriveIntervalMs: REDRIVE_INTERVAL_MS });
  }, FAULT_TIMEOUT_MS);

  afterAll(async () => {
    await h?.cleanup();
  });

  test(
    "the listener stays up, alerts once, logs sweep_error, and re-drives after the fault clears",
    async () => {
      h.faults.setIngressStorageFault(true);
      h.faults.seedFailedIngressEvent(EVENT_ID);

      // The sweep reaches the row and its attempt increment fails. Before
      // issue #47 that was an unhandled rejection: nothing reached ingress_log
      // or the alert seam, and the issue saw it end the listener.
      await h.waitFor(
        () =>
          h.listenerExitCode() !== null ||
          h.ingressLog().some((e) => e.outcome === "sweep_error" && e.event_id === EVENT_ID),
        { timeoutMs: 20_000 },
      );
      expect(h.listenerExitCode()).toBeNull();
      await h.waitFor(() => h.listenerStderr().includes(ALERT_MARKER), { timeoutMs: 10_000 });

      // Several more ticks fail the same way. The listener keeps serving and
      // does not alert again for the same run of failures.
      await sleep(REDRIVE_INTERVAL_MS * 8);
      expect(h.listenerExitCode()).toBeNull();
      const health = await fetch(`${h.listenerBaseUrl}/slack/events`, { method: "GET" });
      expect(health.status).toBeLessThan(500);
      expect(h.listenerStderr().split(ALERT_MARKER).length - 1).toBe(1);
      expect(h.listenerStderr()).toContain("database or disk is full");
      expect(h.ingressLog().filter((e) => e.outcome === "sweep_error").length).toBeGreaterThan(1);
      // No attempt was counted and nothing was re-driven while the fault held.
      expect(h.ingressEvent(EVENT_ID)).toMatchObject({ spawn_attempts: 1 });
      expect(h.ingressLog().some((e) => e.outcome === "redriven")).toBe(false);

      // The disk is freed: a later tick re-drives the row.
      h.faults.setIngressStorageFault(false);
      await h.waitFor(
        () => h.ingressLog().some((e) => e.outcome === "redriven" && e.event_id === EVENT_ID),
        { timeoutMs: 20_000 },
      );
      expect(h.ingressEvent(EVENT_ID)!.spawn_attempts).toBe(2);
      expect(h.listenerExitCode()).toBeNull();
    },
    FAULT_TIMEOUT_MS,
  );
});
