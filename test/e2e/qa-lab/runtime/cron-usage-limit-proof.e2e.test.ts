// Local proof for openclaw#206434; not part of the PR.
import { appendFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createQuotaResetFixture } from "./quota-reset.test-support.js";

type Entry = Record<string, unknown> & { runId?: string; status?: string };

describe("cron usage-limit cause proof", () => {
  it("records the cause of usage-limit cron failures", { timeout: 600_000 }, async (context) => {
    const fixture = await createQuotaResetFixture(context, {
      source:
        (process.env.QUOTA_PROOF_SOURCE as "wham" | "codex_rate_limits") ?? "codex_rate_limits",
      runtime: "codex",
    });
    const { client, provider, stats } = fixture;
    const call = <T>(method: string, params: unknown) =>
      client.request<T>(method, params, { timeoutMs: 120_000 });
    const job = await call<{ id: string }>("cron.add", {
      name: "Usage-limit proof",
      agentId: "main",
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Return QUOTA_TURN_OK." },
      delivery: { mode: "none" },
    });
    const run = async (label: string) => {
      const started = await call<{ runId: string }>("cron.run", { id: job.id, mode: "force" });
      const entry = await vi.waitFor(
        async () => {
          const history = await call<{ entries?: Entry[] }>("cron.runs", {
            id: job.id,
            runId: started.runId,
            limit: 1,
          });
          const found = history.entries?.find((e) => e.runId === started.runId);
          expect(found).toBeDefined();
          return found!;
        },
        { interval: 200, timeout: 180_000 },
      );
      const list = await call<{ jobs: Array<{ id: string; state?: Record<string, unknown> }> }>(
        "cron.list",
        { includeDisabled: true },
      );
      const state = list.jobs.find((j) => j.id === job.id)?.state;
      const out = {
        label,
        status: entry.status,
        error: entry.error,
        errorReason: entry.errorReason,
        jobState: {
          lastErrorReason: state?.lastErrorReason,
          consecutiveErrors: state?.consecutiveErrors,
          nextRunInMs:
            typeof state?.nextRunAtMs === "number" ? state.nextRunAtMs - Date.now() : undefined,
        },
        profile: { cooldownReason: stats()?.cooldownReason, blockedReason: stats()?.blockedReason },
      };
      appendFileSync(process.env.QUOTA_PROOF_OUT ?? "/dev/null", `${JSON.stringify(out)}\n`);
      return out;
    };
    expect((await run("healthy")).status).toBe("ok");
    if (process.env.QUOTA_PROOF_ONESHOT === "1") {
      provider.armToolThenLimit();
      const oneShot = await call<{ id: string }>("cron.add", {
        name: "Usage-limit one-shot proof",
        agentId: "main",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() + 3_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Return QUOTA_TURN_OK." },
        delivery: { mode: "none" },
      });
      const entry = await vi.waitFor(
        async () => {
          const history = await call<{ entries?: Entry[] }>("cron.runs", {
            id: oneShot.id,
            limit: 1,
          });
          const found = history.entries?.[0];
          expect(found?.status).toBe("error");
          return found!;
        },
        { interval: 250, timeout: 180_000 },
      );
      const list = await call<{
        jobs: Array<{ id: string; enabled?: boolean; state?: Record<string, unknown> }>;
      }>("cron.list", { includeDisabled: true });
      const job2 = list.jobs.find((j) => j.id === oneShot.id);
      appendFileSync(
        process.env.QUOTA_PROOF_OUT ?? "/dev/null",
        `${JSON.stringify({
          label: "scheduled-one-shot-after-tool",
          error: String(entry.error).slice(0, 60),
          errorReason: entry.errorReason,
          enabled: job2?.enabled,
          lastErrorReason: job2?.state?.lastErrorReason,
          nextRunInMs:
            typeof job2?.state?.nextRunAtMs === "number"
              ? job2.state.nextRunAtMs - Date.now()
              : undefined,
          providerTool: provider.proofToolState,
        })}\n`,
      );
      return;
    }
    if (process.env.QUOTA_PROOF_TOOL === "1") {
      provider.armToolThenLimit();
      await run("usage-limit-after-tool");
      appendFileSync(
        process.env.QUOTA_PROOF_OUT ?? "/dev/null",
        `${JSON.stringify({ providerTool: provider.proofToolState })}\n`,
      );
    } else {
      provider.setPhase("initial-exhaustion");
      await run("usage-limit");
    }
    await run("during-cooldown");
  });
});
