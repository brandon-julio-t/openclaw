import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { startQaBusServer } from "./bus-server.ts";
import { createQaBusState } from "./bus-state.ts";
import { startAutomationProvider } from "./control-ui-automation-provider.test-support.ts";
import { createQaGatewayChild } from "./gateway-child.ts";
import { createQaChannelTransport } from "./qa-channel-transport.ts";
import { createQaTransportStateMethods, waitForQaTransportAccountReady } from "./qa-transport.ts";
import { startReportMcp } from "./whatsapp-automation-mcp.test-support.ts";

const channel = "fixture-transport";
const accountId = "fixture-account";
// Fictional North American test subscribers. No provider credentials or network account.
const fixturePhone = (suffix) => ["+", "1", "202", "555", "01", suffix].join("");
const alice = fixturePhone("01");
const bob = fixturePhone("02");
const providerA = "source-a/";
const providerB = "source-b/";
const owner = createQaGatewayChild();
const state = createQaBusState();
const transport = createQaChannelTransport(state);
const bus = await startQaBusServer({ state });
const model = await startAutomationProvider("whatsapp_automations");
const mcp = await startReportMcp(accountId);
const qa = path.resolve("extensions/qa-channel");
try {
  const gateway = await owner.start({
    repoRoot: process.cwd(),
    command: {
      executablePath: process.execPath,
      argsPrefix: [path.resolve("openclaw.mjs")],
      cwd: process.cwd(),
      usePackagedPlugins: false,
    },
    providerBaseUrl: model.baseUrl,
    providerMode: "mock-openai",
    primaryModel: "mock-openai/gpt-5.6-luna",
    alternateModel: "mock-openai/gpt-5.6-luna-alt",
    forcedRuntime: "openclaw",
    transport,
    transportBaseUrl: bus.baseUrl,
    controlUiEnabled: false,
  });
  await gateway.restartAfterStateMutation(async ({ configPath, stateDir }) => {
    const dir = path.join(stateDir, "extensions", channel);
    await mkdir(dir, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(qa, "openclaw.plugin.json"), "utf8"));
    await writeFile(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        ...manifest,
        id: channel,
        name: "Synthetic independent transport",
        channels: [channel],
      }),
    );
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "fixture-transport",
        version: "1.0.0",
        type: "module",
        openclaw: {
          extensions: ["./index.js"],
          channel: { id: channel, label: "Synthetic transport" },
        },
      }),
    );
    // Repackage the public QA transport with an independent ID. Its synthetic
    // bus supplies a provider-qualified target while ingress sees the private
    // peer. Registration uses the standard external package loader.
    await build({
      stdin: {
        contents: `
          import { qaChannelPlugin } from './src/channel.ts';
          import { setQaChannelRuntime } from './src/runtime.ts';
          export default {
            id: 'fixture-transport',
            name: 'Synthetic transport',
            register(api) {
              setQaChannelRuntime(api.runtime);
              api.registerChannel({ plugin: qaChannelPlugin });
            },
          };`,
        resolveDir: qa,
      },
      outfile: path.join(dir, "index.js"),
      format: "esm",
      bundle: true,
      platform: "node",
      external: ["openclaw/plugin-sdk/*"],
      plugins: [
        {
          name: "synthetic-identity",
          setup(b) {
            b.onLoad({ filter: /\/qa-channel\/src\/.*\.ts$/ }, async ({ path: file }) => ({
              loader: "ts",
              contents: (await readFile(file, "utf8"))
                .replaceAll(/qa-channel(?!-protocol)/g, channel)
                .replace('dmPolicy: "open"', 'dmPolicy: "allowlist"')
                .replace(
                  'key: "sender", entryIdPrefix: "qa-entry"',
                  'key: "phone", entryIdPrefix: "fixture-phone"',
                )
                .replaceAll(
                  /(kind: inbound\.conversation\.kind(?: === "direct" \? "direct" : "group")?,\s*id: )inbound\.conversation\.id/g,
                  "$1inbound.senderId",
                ),
            }));
          },
        },
      ],
    });
    const cfg = JSON.parse(await readFile(configPath, "utf8"));
    cfg.plugins.allow = [
      ...new Set([...cfg.plugins.allow.filter((x) => x !== "qa-channel"), channel]),
    ];
    cfg.plugins.entries = {
      ...cfg.plugins.entries,
      "qa-channel": { enabled: false },
      [channel]: { enabled: true },
    };
    const builtinChannel = cfg.channels["qa-channel"];
    delete cfg.channels["qa-channel"];
    cfg.channels[channel] = {
      enabled: true,
      defaultAccount: accountId,
      accounts: { [accountId]: { ...builtinChannel, allowFrom: [alice, bob] } },
    };
    cfg.bindings = [{ agentId: "qa", match: { channel, accountId } }];
    cfg.commands = { ...cfg.commands, ownerAllowFrom: ["fixture-transport:fixture-owner"] };
    cfg.session = { ...cfg.session, dmScope: "per-account-channel-peer" };
    cfg.plugins.slots = { ...cfg.plugins.slots, memory: "none" };
    cfg.mcp = {
      servers: {
        static: {
          url: mcp.origin + "/static",
          transport: "streamable-http",
          headers: { Authorization: "Bearer fixture-shared" },
          codex: { defaultToolsApprovalMode: "auto" },
        },
      },
    };
    const allow = ["whatsapp_automations", "automations", "static__report"];
    cfg.tools = {
      profile: "full",
      allow,
      codeMode: false,
      toolSearch: false,
      gatewayPolicy: {
        allow,
        actions: {
          automations: ["add", "list", "update", "remove"],
          whatsapp_automations: ["add", "list", "update", "remove"],
        },
        automations: { scope: "caller" },
      },
    };
    (cfg.agents.entries.qa ??= {}).tools = { profile: "full", allow };
    await writeFile(configPath, JSON.stringify(cfg));
  });
  await waitForQaTransportAccountReady({ gateway, accountId, channel });
  const info = await gateway.call("plugins.inspect", { pluginId: channel });
  const plugin = info.plugin;
  console.log(
    "INSPECT",
    JSON.stringify({ id: plugin.id, origin: plugin.origin, enabled: plugin.enabled }),
  );
  assert.equal(plugin.origin, "global");
  assert.equal(plugin.enabled, true);
  const jobs = async () => (await gateway.call("cron.list", { includeDisabled: true })).jobs;
  const jobIds = async () => (await jobs()).map((job) => job.id).toSorted();
  const before = await jobIds();
  async function ask(marker, tool, args, source, sender) {
    model.requestedTools.set(marker, tool);
    model.requests.set(marker, args);
    const conversation = { kind: "direct", id: source + sender };
    const sinceIndex = state
      .getSnapshot()
      .messages.filter((m) => m.direction === "outbound").length;
    await transport.sendInbound({
      accountId,
      conversation,
      senderId: sender,
      text: "Synthetic request [automation-proof:" + marker + "]",
    });
    const reply = await createQaTransportStateMethods({ state, accountId }).waitForOutbound({
      conversation,
      sinceIndex,
      textIncludes: marker + ":",
      timeoutMs: 60000,
    });
    assert.equal(reply.conversation.id, conversation.id);
    assert.equal(reply.accountId, accountId);
    console.log(
      "DM",
      marker,
      "tool",
      tool,
      "available",
      model.toolAvailability.get(marker),
      "result",
      JSON.stringify(model.results.get(marker)),
    );
    return reply.text;
  }
  assert.match(await ask("read", "static__report", {}, providerA, alice), /1 unit\./);
  const schedule = { kind: "every", everyMs: 3600000 };
  await ask(
    "create",
    "whatsapp_automations",
    { action: "add", mode: "task", text: "Send the report", schedule },
    providerA,
    alice,
  );
  assert.equal(model.toolAvailability.get("create"), false);
  await ask(
    "native",
    "automations",
    {
      action: "add",
      job: {
        name: "Fixture report",
        schedule,
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Send report" },
      },
    },
    providerA,
    alice,
  );
  assert.match(model.results.get("native") ?? "", /owner.s authority/i);
  assert.deepEqual(await jobIds(), before);
  await ask("other-source", "whatsapp_automations", { action: "list" }, providerB, alice);
  await ask("other-peer", "whatsapp_automations", { action: "list" }, providerA, bob);
  assert.equal(model.toolAvailability.get("other-source"), false);
  assert.equal(model.toolAvailability.get("other-peer"), false);
  assert.deepEqual(await jobIds(), before);
  const marker = "due-report";
  model.requestedTools.set(marker, "static__report");
  model.requests.set(marker, {});
  // Schedule through the operator RPC as an independent delivery control.
  const time = new Date(Date.now() + 40000);
  const job = await gateway.call("cron.add", {
    agentId: "qa",
    name: "Operator control",
    schedule: { kind: "at", at: time.toISOString() },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Report today [automation-proof:due-report]" },
    delivery: { mode: "announce", channel, accountId, to: "dm:" + providerA + alice },
  });
  assert.ok((await jobs()).some((j) => j.id === job.id));
  mcp.setUnits(17);
  await transport.waitForCondition(
    () =>
      state
        .getSnapshot()
        .messages.find((m) => m.direction === "outbound" && m.text.includes("17 units.")),
    120000,
  );
  const matches = state
    .getSnapshot()
    .messages.filter((m) => m.direction === "outbound" && m.text.includes("17 units."));
  assert.ok(
    matches.every((m) => m.accountId === accountId && m.conversation.id === providerA + alice),
  );
  assert.ok(mcp.calls.some((c) => c.units === 17));
  const config = await gateway.call("config.get", {});
  await gateway.call("config.patch", {
    baseHash: config.hash,
    replacePaths: [`channels.${channel}.accounts.${accountId}.allowFrom`],
    raw: JSON.stringify({
      channels: { [channel]: { accounts: { [accountId]: { allowFrom: [bob] } } } },
    }),
  });
  await gateway.restartAfterStateMutation(async () => {});
  await waitForQaTransportAccountReady({ gateway, accountId, channel });
  assert.match(await ask("retained", "static__report", {}, providerA, bob), /17 units/);
  const priorCalls = mcp.calls.length;
  const markerWithdrawn = "withdrawn";
  model.requests.set(markerWithdrawn, {});
  model.requestedTools.set(markerWithdrawn, "static__report");
  const withdrawal = await transport.sendInbound({
    accountId,
    senderId: alice,
    conversation: { kind: "direct", id: providerA + alice },
    text: "Read [automation-proof:withdrawn]",
  });
  const event = state
    .getSnapshot()
    .events.find(
      (entry) =>
        entry.kind === "inbound-message" &&
        entry.accountId === accountId &&
        entry.message.id === withdrawal.id,
    );
  assert.ok(event);
  await transport.waitForCondition(
    () => state.hasCompletedInboundEvent(accountId, event.cursor) || undefined,
    25000,
  );
  assert.equal(model.toolAvailability.has(markerWithdrawn), false);
  assert.equal(mcp.calls.length, priorCalls);
  console.log(
    "PASS: withdrawn interactive sender stopped at ingress; retained sender read 17 units.",
  );
  console.log(
    "PASS: zero caller jobs; naturally due operator control delivered 17 units only to source A in original account.",
  );
} finally {
  const stopped = await owner.stop();
  await bus.stop();
  await model.stop();
  await mcp.close();
  assert.deepEqual(stopped.errors, []);
}
