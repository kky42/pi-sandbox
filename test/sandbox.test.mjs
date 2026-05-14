import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	createSandboxExtension,
	createSandboxState,
	denyWriteReason,
	effectiveFilesystemConfig,
	parseConfig,
	sandboxChoice,
	sandboxChoiceFromValue,
	statusText,
} from "../index.ts";

const customConfig = {
	filesystem: {
		denyRead: ["secret"],
		allowWrite: ["custom-write"],
		denyWrite: ["blocked.txt"],
	},
};

function makeHarness(flags = {}, cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"))) {
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const statuses = [];
	const state = createSandboxState(true);
	const pi = {
		registerFlag() {},
		getFlag(name) {
			return flags[name];
		},
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
	};
	const ctx = {
		cwd,
		signal: undefined,
		isIdle: () => true,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus(name, value) {
				statuses.push({ name, value });
			},
			theme: {
				fg(_style, text) {
					return text;
				},
			},
		},
	};

	createSandboxExtension(state)(pi);

	return {
		state,
		ctx,
		notifications,
		statuses,
		start() {
			handlers.get("session_start")?.({}, ctx);
		},
		runSandboxCommand(args) {
			return commands.get("sandbox").handler(args, ctx);
		},
	};
}

function writeJson(dir, name, value) {
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
	return filePath;
}

test("startup defaults to workspace-write built-in policy", () => {
	const harness = makeHarness();

	harness.start();

	assert.equal(sandboxChoice(harness.state), "workspace-write");
	assert.equal(harness.state.enabled, true);
	assert.equal(harness.state.configSource, "built-in: workspace-write");
	assert.deepEqual(harness.state.config.filesystem.allowWrite, [".", "/tmp", "/private/tmp"]);
});

test("--sandbox accepts only built-in choices", () => {
	for (const choice of ["read-only", "workspace-write", "danger-full-access"]) {
		const harness = makeHarness({ sandbox: choice });

		harness.start();

		assert.equal(sandboxChoice(harness.state), choice);
		assert.equal(harness.state.enabled, choice !== "danger-full-access");
		assert.equal(harness.state.configSource, `built-in: ${choice}`);
	}
});

test("--sandbox rejects old values and falls back to workspace-write", () => {
	for (const oldValue of ["readonly", "on", "off"]) {
		const harness = makeHarness({ sandbox: oldValue });

		harness.start();

		assert.equal(sandboxChoice(harness.state), "workspace-write");
		assert.match(harness.notifications.at(-1).message, new RegExp(`Invalid --sandbox value "${oldValue}"`));
		assert.match(harness.notifications.at(-1).message, /read-only\|workspace-write\|danger-full-access/);
	}
});

test("--sandbox-config activates complete custom config", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
	const configPath = writeJson(cwd, "sandbox.json", customConfig);
	const harness = makeHarness({ "sandbox-config": configPath }, cwd);

	harness.start();

	assert.equal(sandboxChoice(harness.state), "config");
	assert.equal(harness.state.configSource, `--sandbox-config: ${configPath}`);
	assert.deepEqual(harness.state.config.filesystem.allowWrite, ["custom-write"]);
	assert.deepEqual(harness.state.config.filesystem.denyRead, ["secret"]);
	assert.deepEqual(harness.state.config.filesystem.denyWrite, ["blocked.txt"]);
});

test("--sandbox-config ignores --sandbox and warns", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
	const configPath = writeJson(cwd, "sandbox.json", customConfig);
	const harness = makeHarness({ sandbox: "danger-full-access", "sandbox-config": configPath }, cwd);

	harness.start();

	assert.equal(sandboxChoice(harness.state), "config");
	assert.equal(harness.state.enabled, true);
	assert.match(harness.notifications[0].message, /Ignoring --sandbox danger-full-access/);
});

test("invalid explicit config falls back to workspace-write", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
	const configPath = writeJson(cwd, "sandbox.json", { filesystem: { allowWrite: ["."] } });
	const harness = makeHarness({ "sandbox-config": configPath }, cwd);

	harness.start();

	assert.equal(sandboxChoice(harness.state), "workspace-write");
	assert.equal(harness.state.configSource, "built-in: workspace-write");
	assert.match(harness.notifications[0].message, /Invalid sandbox config/);
	assert.match(harness.notifications[0].message, /Falling back to --sandbox workspace-write/);
});

test("project and global config files are not auto-discovered", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
	fs.mkdirSync(path.join(cwd, ".pi"));
	writeJson(path.join(cwd, ".pi"), "sandbox.json", customConfig);
	const harness = makeHarness({}, cwd);

	harness.start();

	assert.equal(sandboxChoice(harness.state), "workspace-write");
	assert.deepEqual(harness.state.config.filesystem.allowWrite, [".", "/tmp", "/private/tmp"]);
});

test("/sandbox switches built-in choices and ignores custom config until restored", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
	const configPath = writeJson(cwd, "sandbox.json", customConfig);
	const harness = makeHarness({ "sandbox-config": configPath }, cwd);

	harness.start();
	await harness.runSandboxCommand("read-only");

	assert.equal(sandboxChoice(harness.state), "read-only");
	assert.equal(harness.state.configSource, "built-in: read-only");
	assert.deepEqual(harness.state.config.filesystem.allowWrite, [".", "/tmp", "/private/tmp"]);
	assert.match(statusText(harness.state, cwd), /restore custom config: \/sandbox config/);

	await harness.runSandboxCommand("config");

	assert.equal(sandboxChoice(harness.state), "config");
	assert.equal(harness.state.configSource, `--sandbox-config: ${configPath}`);
	assert.deepEqual(harness.state.config.filesystem.allowWrite, ["custom-write"]);
});

test("/sandbox config without startup config warns and leaves state unchanged", async () => {
	const harness = makeHarness({ sandbox: "read-only" });

	harness.start();
	await harness.runSandboxCommand("config");

	assert.equal(sandboxChoice(harness.state), "read-only");
	assert.match(harness.notifications.at(-1).message, /No startup --sandbox-config is available/);
});

test("/sandbox rejects old values with new usage text", async () => {
	const harness = makeHarness();

	harness.start();
	await harness.runSandboxCommand("on");

	assert.equal(sandboxChoice(harness.state), "workspace-write");
	assert.match(harness.notifications.at(-1).message, /Usage: \/sandbox \[read-only\|workspace-write\|danger-full-access\|config\]/);
});

test("custom config validation requires explicit filesystem arrays", () => {
	assert.deepEqual(parseConfig(customConfig), customConfig);
	assert.throws(() => parseConfig({ filesystem: { denyRead: [], allowWrite: [] } }), /filesystem.denyWrite/);
	assert.throws(() => parseConfig({ filesystem: { denyRead: [], allowWrite: ".", denyWrite: [] } }), /filesystem.allowWrite/);
});

test("read-only has no effective write roots", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
	const state = createSandboxState(true);
	state.choice = "read-only";

	assert.deepEqual(effectiveFilesystemConfig(cwd, state).allowWrite, []);
	assert.match(denyWriteReason(cwd, state, "file.txt"), /read-only sandbox does not allow writes/);
});

test("danger-full-access disables extension enforcement", () => {
	const harness = makeHarness({ sandbox: "danger-full-access" });

	harness.start();

	assert.equal(harness.state.enabled, false);
	assert.equal(sandboxChoice(harness.state), "danger-full-access");
	assert.match(statusText(harness.state, harness.ctx.cwd), /bash: unsandboxed/);
});

test("sandboxChoiceFromValue does not keep old aliases", () => {
	assert.equal(sandboxChoiceFromValue("read-only"), "read-only");
	assert.equal(sandboxChoiceFromValue("workspace-write"), "workspace-write");
	assert.equal(sandboxChoiceFromValue("danger-full-access"), "danger-full-access");
	assert.equal(sandboxChoiceFromValue("readonly"), undefined);
	assert.equal(sandboxChoiceFromValue("on"), undefined);
	assert.equal(sandboxChoiceFromValue("off"), undefined);
});
