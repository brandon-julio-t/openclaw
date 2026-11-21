import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runQaGatewayFixture, stopQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import { startAutomationProvider } from "./control-ui-automation-provider.test-support.ts";
import { createQaCrablineTransportAdapter } from "./crabline-transport.ts";
import { createQaGatewayChild } from "./gateway-child.ts";

async function run() {
  // All transport traffic uses the bundled loopback driver and a scripted provider.
  const outputDir = await mkdtemp(path.join(tmpdir(), "qa-personal-"));
  const provider = await startAutomationProvider();
  const owner = createQaGatewayChild();
  let transport: Awaited<ReturnType<typeof createQaCrablineTransportAdapter>> | undefined;
  await runQaGatewayFixture(
    async () => {
      transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: {
          channel: "whatsapp",
          channelDriver: "crabline",
          capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
          providerReadinessArtifactPath: "crabline-provider-readiness.json",
        },
      });
      const adapter = transport;
      const runtimeEnvPatch = adapter.createRuntimeEnvPatch();
      assert.equal(new URL(runtimeEnvPatch.OPENCLAW_WHATSAPP_WEB_SOCKET_URL).hostname, "127.0.0.1");
      const gateway = await owner.start({
        runtimeEnvPatch,
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.resolve("openclaw.mjs")],
          cwd: process.cwd(),
          usePackagedPlugins: false,
        },
        providerMode: "mock-openai",
        providerBaseUrl: provider.baseUrl,
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        forcedRuntime: "openclaw",
        transport: adapter,
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        mutateConfig(cfg) {
          cfg.commands = { ...cfg.commands, ownerAllowFrom: ["whatsapp:+15550000002"] };
          cfg.session = { ...cfg.session, dmScope: "per-account-channel-peer" };
          cfg.gateway!.roles = {
            default: "member",
            definitions: {
              member: {
                scopes: ["operator.sessions.read", "operator.sessions.write", "operator.cron"],
                sessions: { others: "none" },
                agents: "*",
              },
            },
          };
          const wa = cfg.channels!.whatsapp!;
          wa.accounts![adapter.accountId] = {
            ...wa.accounts![adapter.accountId],
            dmPolicy: "pairing",
            allowFrom: ["+15550000002"],
          };
          cfg.plugins = { ...cfg.plugins, slots: { ...cfg.plugins?.slots, memory: "none" } };
          const tools = { profile: "full" as const, allow: ["automations", "session_status"] };
          cfg.tools = {
            ...tools,
            codeMode: false,
            toolSearch: false,
            gatewayPolicy: {
              allow: ["automations"],
              actions: { automations: ["add", "list", "update", "remove"] },
              automations: { scope: "caller" },
            },
          };
          const agents = ((cfg.agents ??= {}).entries ??= {});
          (agents.qa ??= {}).tools = tools;
          return cfg;
        },
      });
      // Seed only the person offline, then establish and inspect the link
      // with the native admin RPCs while the Gateway is running.
      let profileId = "";
      await gateway.restartAfterStateMutation(async ({ stateDir }) => {
        const { ensureProfileForEmail } = await import("../../../src/state/user-profiles.ts");
        profileId = ensureProfileForEmail("member@example.invalid", {
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }).id;
      });
      await adapter.waitReady({ gateway });
      const senderId = "15550000001@s.whatsapp.net";
      const account = { channel: "whatsapp", accountId: adapter.accountId };
      await adapter.sendInbound({
        accountId: adapter.accountId,
        conversation: { kind: "direct", id: senderId },
        senderId,
        text: "Pair my test chat",
      });
      const req = await adapter.waitForCondition(async () => {
        const page = (await gateway.call("channels.pairing.list", account)) as {
          requests: { requestId: string; senderId: string }[];
        };
        return page.requests.find((r) => r.senderId === "+15550000001") || null;
      }, 45000);
      await gateway.call("channels.pairing.approve", {
        ...account,
        requestId: req.requestId,
        bootstrapCommandOwner: false,
        notify: false,
      });
      console.log("approved private DM with separate control owner");
      const job = {
        name: "Synthetic scheduled reminder",
        enabled: false,
        schedule: { kind: "every", everyMs: 3600000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Read a book." },
        delivery: { mode: "none" },
      };
      const saved = (await gateway.call("cron.add", {
        ...job,
        agentId: "qa",
        name: "Operator test job",
      })) as { id: string };
      assert.ok(saved.id);
      const readJobs = async () =>
        (
          (await gateway.call("cron.list", { includeDisabled: true })) as {
            jobs: { id: string; name: string }[];
          }
        ).jobs
          .map(({ id, name }) => ({ id, name }))
          .toSorted((a, b) => a.id.localeCompare(b.id));
      const before = await readJobs();
      assert.ok(before.some((j) => j.id === saved.id && j.name === "Operator test job"));
      // The caller never obtains a job ID. Update and remove use a known
      // operator-owned ID to distinguish rejection from an invented ID.
      const requests = [
        ["create", "Remind me to read", { action: "add", job }],
        ["list", "List my reminders", { action: "list", includeDisabled: true }],
        [
          "update",
          "Change my reminder",
          { action: "update", jobId: saved.id, job: { name: "Changed" } },
        ],
        ["remove", "Remove my reminder", { action: "remove", jobId: saved.id }],
      ] as const;
      for (const phase of ["paired", "linked"] as const) {
        if (phase === "linked") {
          const identity = {
            channelId: "whatsapp",
            accountId: adapter.accountId,
            senderId: req.senderId,
          };
          await gateway.call("users.linkChannelIdentity", { profileId, identity });
          const result = (await gateway.call("users.listChannelIdentities", { profileId })) as {
            links: { identity: typeof identity }[];
          };
          assert.deepEqual(result.links[0]?.identity, identity);
          const users = (await gateway.call("users.list", {})) as {
            profiles: { id: string; role?: string; effectiveRole?: string; roleSource?: string }[];
          };
          const member = users.profiles.find((p) => p.id === profileId);
          assert.ok(member);
          assert.equal(member.effectiveRole, "member");
          assert.equal(member.roleSource, "default");
          assert.equal(member.role, undefined);
          console.log("verified profile link and nonadmin default role including operator.cron");
        }
        for (const [action, prompt, args] of requests) {
          const marker = phase + "-" + action;
          provider.requests.set(marker, args);
          await adapter.sendInbound({
            accountId: adapter.accountId,
            conversation: { id: senderId, kind: "direct" },
            senderId,
            text: `${prompt} [automation-proof:${marker}]`,
          });
          await adapter.waitForOutbound({ textIncludes: `${marker}:`, timeoutMs: 45000 });
          const output = provider.results.get(marker);
          assert.ok(
            output?.includes("needs the owner's authority"),
            JSON.stringify(provider.diagnostics(marker)),
          );
          assert.deepEqual(await readJobs(), before);
          console.log(marker, "denied, scheduler inventory unchanged");
        }
      }
    },
    () => stopQaGatewayFixture(owner),
    () => transport?.cleanupAfterGatewayStop(),
    () => provider.stop(),
    () => rm(outputDir, { recursive: true, force: true }),
  );
}
await run();
