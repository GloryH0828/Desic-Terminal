import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import readline from "node:readline";
import { codexIsolationOverrides, codexProviderOverrides, codexReasoningOverrides } from "./codex-cli-adapter.mjs";

// Explicit native CLI path; no credential files, model turn, or tool execution.
const cli = process.argv[2];
assert.ok(cli && isAbsolute(cli), "Pass the absolute path to the installed Codex CLI");
const child = spawn(cli, ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true
});
const pending = new Map();
let sequence = 0;
// Drain diagnostics without exposing user configuration or authentication data.
child.stderr.resume();
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let response;
  try { response = JSON.parse(line); } catch { return; }
  const waiter = pending.get(response.id);
  if (waiter) {
    pending.delete(response.id);
    clearTimeout(waiter.timer);
    waiter.resolve(response);
  }
});
function failPending(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}
child.on("error", failPending);
child.on("exit", () => failPending(new Error("Codex exited before returning the configuration result")));
function request(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
try {
  const initialization = await request("initialize", {
    clientInfo: { name: "desic_configuration_smoke", version: "0.4.0" },
    capabilities: { experimentalApi: true }
  });
  assert.equal(initialization.error, undefined, "Codex initialization failed");
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  const params = {
    cwd: process.cwd(), approvalPolicy: "never", sandbox: "read-only",
    ephemeral: true, persistExtendedHistory: false,
    config: { ...codexIsolationOverrides(), ...codexReasoningOverrides("medium") }
  };
  const legacy = await request("thread/start", {
    ...params,
    config: { ...params.config, "model_providers.openai.request_max_retries": 0 }
  });
  assert.equal(legacy.error?.code, -32600, "Installed CLI must reproduce the reserved-provider error");
  assert.match(String(legacy.error?.message), /reserved.*provider|built-in.*overrid/i);
  const fixed = await request("thread/start", {
    ...params, config: { ...params.config, ...codexProviderOverrides(undefined) }
  });
  assert.equal(fixed.error, undefined, "Fixed default-provider configuration was rejected");
  assert.ok(fixed.result?.thread?.id, "Codex did not return a thread");
  console.log("[smoke] real Codex CLI reproduced the legacy error and accepted the fixed configuration; no model turn started");
} finally {
  lines.close();
  // App-server helpers can inherit its pipes. Stop only this probe's process
  // tree before closing the streams so the smoke cannot leave helpers behind.
  if (process.platform === "win32" && child.pid && child.exitCode === null) {
    await new Promise((resolve) => {
      const cleanup = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true
      });
      cleanup.once("error", resolve);
      cleanup.once("exit", resolve);
    });
  } else {
    child.kill();
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}
