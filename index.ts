/**
 * Pi Sandbox Extension
 *
 * Lightweight sandboxing for Pi Agent without replacing built-in tools.
 *
 * - bash is sandboxed by mutating the built-in bash tool input after the model
 *   requests the tool and before Pi executes it.
 * - write/edit are blocked when they target paths outside configured write roots.
 * - read/search/list tools are blocked for configured sensitive paths.
 * - /sandbox shows or toggles runtime sandbox state in the Pi TUI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
	type BashOperations,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolResultEvent,
	type ToolResultEventResult,
	type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

export interface SandboxState {
	enabled: boolean;
	config: SandboxExtensionConfig;
	configSource: string;
}

export interface SandboxExtensionConfig {
	filesystem: {
		denyRead: string[];
		allowWrite: string[];
		denyWrite: string[];
	};
}

const DEFAULT_CONFIG: SandboxExtensionConfig = {
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp", "/private/tmp"],
		denyWrite: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key"],
	},
};

const DEFAULT_STATE: SandboxState = {
	enabled: true,
	config: DEFAULT_CONFIG,
	configSource: "default",
};

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function resolveConfigPath(cwd: string, value: string): string {
	return path.resolve(cwd, expandHome(value));
}

function absolutePath(cwd: string, value: string): string {
	const expanded = expandHome(value);
	return path.resolve(cwd, expanded);
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function allowedTempRoots(): string[] {
	const roots = [os.tmpdir()];
	if (process.platform !== "win32") roots.push("/tmp");
	if (process.platform === "darwin") roots.push("/private/tmp");
	return [...new Set(roots.map((root) => path.resolve(root)))];
}

function normalizeConfig(value: unknown): SandboxExtensionConfig {
	const raw = value && typeof value === "object" ? value as Partial<SandboxExtensionConfig> : {};
	const filesystem = raw.filesystem && typeof raw.filesystem === "object" ? raw.filesystem : {};
	return {
		filesystem: {
			denyRead: Array.isArray(filesystem.denyRead) ? filesystem.denyRead.map(String) : [...DEFAULT_CONFIG.filesystem.denyRead],
			allowWrite: Array.isArray(filesystem.allowWrite) ? filesystem.allowWrite.map(String) : [...DEFAULT_CONFIG.filesystem.allowWrite],
			denyWrite: Array.isArray(filesystem.denyWrite) ? filesystem.denyWrite.map(String) : [...DEFAULT_CONFIG.filesystem.denyWrite],
		},
	};
}

function readConfigFile(filePath: string): SandboxExtensionConfig {
	return normalizeConfig(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function findConfig(cwd: string, specificPath?: string): { config: SandboxExtensionConfig; source: string; warning?: string } {
	const candidates = [
		specificPath ? { label: "specific", path: resolveConfigPath(cwd, specificPath) } : null,
		{ label: "project", path: path.join(cwd, ".pi", "sandbox.json") },
		{ label: "global", path: path.join(os.homedir(), ".pi", "sandbox.json") },
	].filter((entry): entry is { label: string; path: string } => Boolean(entry));

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate.path)) continue;
		try {
			return { config: readConfigFile(candidate.path), source: `${candidate.label}: ${candidate.path}` };
		} catch (error) {
			return {
				config: DEFAULT_CONFIG,
				source: "default",
				warning: `Could not parse sandbox config ${candidate.path}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	return { config: DEFAULT_CONFIG, source: "default" };
}

function resolvedFilesystemConfig(cwd: string, config: SandboxExtensionConfig): Required<SandboxExtensionConfig>["filesystem"] {
	const tempRoots = allowedTempRoots();
	return {
		denyRead: config.filesystem.denyRead.map((entry) => absolutePath(cwd, entry)),
		allowWrite: [...new Set(config.filesystem.allowWrite.map((entry) => absolutePath(cwd, entry)))],
		denyWrite: config.filesystem.denyWrite.flatMap((entry) => {
			if (path.isAbsolute(expandHome(entry))) return [absolutePath(cwd, entry)];
			return [absolutePath(cwd, entry), ...tempRoots.map((root) => absolutePath(root, entry))];
		}),
	};
}

function runtimeConfig(cwd: string, state: SandboxState): Partial<SandboxRuntimeConfig> {
	return { filesystem: resolvedFilesystemConfig(cwd, state.config) };
}

function denyReadReason(cwd: string, state: SandboxState, requestedPath: string): string | undefined {
	const target = absolutePath(cwd, requestedPath || ".");
	for (const denied of state.config.filesystem.denyRead) {
		const deniedPath = absolutePath(cwd, denied);
		if (isInside(deniedPath, target) || isInside(target, deniedPath)) {
			return `Sandbox blocked ${requestedPath}: reading ${denied} is not allowed.`;
		}
	}
	return undefined;
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
	return new RegExp(`^${escaped}$`, "i");
}

function denyWriteReason(cwd: string, state: SandboxState, requestedPath: string): string | undefined {
	const target = absolutePath(cwd, requestedPath);
	const allowed = state.config.filesystem.allowWrite.some((root) => isInside(absolutePath(cwd, root), target));
	if (!allowed) {
		return [
			`Sandbox blocked ${requestedPath}: writing outside allowed directories is not allowed.`,
			`Allowed write roots: ${state.config.filesystem.allowWrite.join(", ")}`,
		].join("\n");
	}

	const relative = path.relative(path.resolve(cwd), target) || path.basename(target);
	const basename = path.basename(target);
	for (const denied of state.config.filesystem.denyWrite) {
		const normalized = denied.replace(/^\*\*\//, "");
		if (globToRegExp(denied).test(relative) || globToRegExp(normalized).test(basename)) {
			return `Sandbox blocked ${requestedPath}: writing ${basename} is not allowed by sandbox policy (${denied}).`;
		}
	}
	return undefined;
}

function respectfulBlock(reason: string): string {
	return [
		reason,
		"",
		"Respect the sandbox. Do not try alternate tools, shell tricks, or path changes to bypass it.",
		"Ask the user to run /sandbox off if this operation should be allowed.",
	].join("\n");
}

function statusText(state: SandboxState, cwd?: string): string {
	const workspace = cwd ? path.resolve(cwd) : "(current workspace)";
	const fsConfig = cwd ? resolvedFilesystemConfig(cwd, state.config) : null;
	return [
		`sandbox: ${state.enabled ? "on" : "off"}`,
		`config: ${state.configSource}`,
		"bash: OS sandboxed with filesystem policy; network is unrestricted",
		`workspace: ${workspace}`,
		`write/edit allowed: ${state.config.filesystem.allowWrite.join(", ")}`,
		`read denied: ${state.config.filesystem.denyRead.join(", ")}`,
		`write denied: ${state.config.filesystem.denyWrite.join(", ")}`,
		...(fsConfig ? [`resolved write roots: ${fsConfig.allowWrite.join(", ")}`] : []),
	].join("\n");
}

async function wrapBashCommand(command: string, cwd: string, state: SandboxState, signal?: AbortSignal): Promise<string> {
	const wrappedCommand = await SandboxManager.wrapWithSandbox(command, undefined, runtimeConfig(cwd, state), signal);
	if (process.platform === "darwin" && wrappedCommand.startsWith("env ")) {
		return `/usr/bin/${wrappedCommand}`;
	}
	return wrappedCommand;
}

function createSandboxedBashOperations(state: SandboxState): BashOperations {
	const local = createLocalBashOperations();
	return {
		async exec(command, cwd, options) {
			const wrappedCommand = await wrapBashCommand(command, cwd, state, options.signal);
			return local.exec(wrappedCommand, cwd, options);
		},
	};
}

function textFromToolResult(event: ToolResultEvent): string {
	return event.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function looksLikeSandboxFailure(text: string): boolean {
	return /operation not permitted|permission denied|sandbox|not allowed|blocked/i.test(text);
}

function blockForFileTool(event: ToolCallEvent, ctx: ExtensionContext, state: SandboxState): ToolCallEventResult | undefined {
	if (event.toolName === "write" || event.toolName === "edit") {
		const targetPath = typeof event.input.path === "string" ? event.input.path : "";
		if (!targetPath) return undefined;
		const reason = denyWriteReason(ctx.cwd, state, targetPath);
		return reason ? { block: true, reason: respectfulBlock(reason) } : undefined;
	}

	if (event.toolName === "read" || event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
		const targetPath = typeof event.input.path === "string" ? event.input.path : ".";
		const reason = denyReadReason(ctx.cwd, state, targetPath);
		return reason ? { block: true, reason: respectfulBlock(reason) } : undefined;
	}

	return undefined;
}

function updateStatus(ctx: ExtensionContext, state: SandboxState): void {
	ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("dim", `sandbox ${state.enabled ? "on" : "off"}`));
}

export function createSandboxState(enabled = true): SandboxState {
	return { enabled, config: DEFAULT_CONFIG, configSource: "default" };
}

function applyStartupFlags(pi: ExtensionAPI, ctx: ExtensionContext, state: SandboxState): void {
	const sandboxFlag = String(pi.getFlag("sandbox") ?? "on").trim().toLowerCase();
	if (sandboxFlag === "on" || sandboxFlag === "off") {
		state.enabled = sandboxFlag === "on";
	} else {
		ctx.ui.notify(`Invalid --sandbox value "${sandboxFlag}". Use --sandbox on or --sandbox off.`, "warning");
		state.enabled = true;
	}

	const configFlag = pi.getFlag("sandbox-config");
	const configPath = typeof configFlag === "string" ? configFlag : undefined;
	const loaded = findConfig(ctx.cwd, configPath);
	state.config = loaded.config;
	state.configSource = loaded.source;
	if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
}

export function createSandboxExtension(state: SandboxState = DEFAULT_STATE) {
	return function sandboxExtension(pi: ExtensionAPI) {
		const sandboxedToolCalls = new Set<string>();

		pi.registerFlag("sandbox", {
			description: "Set sandbox state: on or off",
			type: "string",
			default: "on",
		});

		pi.registerFlag("sandbox-config", {
			description: "Path to sandbox config JSON",
			type: "string",
		});

		pi.on("session_start", (_event, ctx) => {
			applyStartupFlags(pi, ctx, state);
			updateStatus(ctx, state);
		});

		pi.on("tool_call", async (event, ctx) => {
			if (!state.enabled) return undefined;

			const fileBlock = blockForFileTool(event, ctx, state);
			if (fileBlock) return fileBlock;

			if (event.toolName !== "bash") return undefined;
			if (typeof event.input.command !== "string") return undefined;

			try {
				event.input.command = await wrapBashCommand(event.input.command, ctx.cwd, state, ctx.signal);
				sandboxedToolCalls.add(event.toolCallId);
				return undefined;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { block: true, reason: respectfulBlock(`Sandbox could not run bash safely: ${message}`) };
			}
		});

		pi.on("tool_result", (event): ToolResultEventResult | undefined => {
			if (!state.enabled || event.toolName !== "bash" || !sandboxedToolCalls.has(event.toolCallId)) {
				return undefined;
			}
			sandboxedToolCalls.delete(event.toolCallId);
			const text = textFromToolResult(event);
			if (!event.isError || !looksLikeSandboxFailure(text)) return undefined;
			return {
				isError: true,
				content: [{ type: "text", text: respectfulBlock(`Sandbox blocked this bash command.\n\nOriginal error:\n${text}`) }],
				details: event.details,
			};
		});

		pi.on("user_bash", (): UserBashEventResult | undefined => {
			if (!state.enabled) return undefined;
			return { operations: createSandboxedBashOperations(state) };
		});

		pi.registerCommand("sandbox", {
			description: "Show or toggle the sandbox",
			handler: async (args, ctx) => {
				const value = args.trim().toLowerCase();
				if (!value) {
					ctx.ui.notify(statusText(state, ctx.cwd), "info");
					updateStatus(ctx, state);
					return;
				}
				if (value !== "on" && value !== "off") {
					ctx.ui.notify("Usage: /sandbox [on|off]", "warning");
					return;
				}
				if (!ctx.isIdle()) {
					ctx.ui.notify("Cannot change sandbox while a Pi turn is running. Run /sandbox again after the turn finishes.", "warning");
					return;
				}
				state.enabled = value === "on";
				updateStatus(ctx, state);
				ctx.ui.notify(statusText(state, ctx.cwd), "info");
			},
		});
	};
}

export default function sandboxExtension(pi: ExtensionAPI) {
	return createSandboxExtension(createSandboxState(true))(pi);
}
