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
	type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

export interface SandboxState {
	choice: SandboxChoice;
	enabled: boolean;
	config: SandboxExtensionConfig;
	configSource: string;
	startupConfig?: SandboxStartupConfig;
}

export type BuiltinSandboxChoice = "read-only" | "workspace-write" | "danger-full-access";
export type SandboxChoice = BuiltinSandboxChoice | "config";

export interface SandboxStartupConfig {
	config: SandboxExtensionConfig;
	path: string;
	source: string;
}

export interface SandboxExtensionConfig {
	filesystem: {
		denyRead: string[];
		allowWrite: string[];
		denyWrite: string[];
		allowGitConfig?: boolean;
	};
}

interface SandboxToolResultEventResult {
	content?: ToolResultEvent["content"];
	details?: unknown;
	isError?: boolean;
}

const DEFAULT_CONFIG: SandboxExtensionConfig = {
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp", "/private/tmp"],
		denyWrite: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key"],
	},
};

const BUILTIN_SANDBOX_CHOICES: BuiltinSandboxChoice[] = ["read-only", "workspace-write", "danger-full-access"];
const SANDBOX_USAGE = "read-only|workspace-write|danger-full-access|config";

function cloneConfig(config: SandboxExtensionConfig): SandboxExtensionConfig {
	const filesystem: SandboxExtensionConfig["filesystem"] = {
		denyRead: [...config.filesystem.denyRead],
		allowWrite: [...config.filesystem.allowWrite],
		denyWrite: [...config.filesystem.denyWrite],
	};
	if (typeof config.filesystem.allowGitConfig === "boolean") {
		filesystem.allowGitConfig = config.filesystem.allowGitConfig;
	}
	return { filesystem };
}

function setBuiltinSandboxChoice(state: SandboxState, choice: BuiltinSandboxChoice): void {
	state.choice = choice;
	state.enabled = choice !== "danger-full-access";
	state.config = cloneConfig(DEFAULT_CONFIG);
	state.configSource = `built-in: ${choice}`;
}

function setConfigSandboxChoice(state: SandboxState, startupConfig: SandboxStartupConfig): void {
	state.choice = "config";
	state.enabled = true;
	state.config = cloneConfig(startupConfig.config);
	state.configSource = startupConfig.source;
	state.startupConfig = {
		config: cloneConfig(startupConfig.config),
		path: startupConfig.path,
		source: startupConfig.source,
	};
}

export function sandboxChoice(state: SandboxState): SandboxChoice {
	return state.choice ?? (state.enabled ? "workspace-write" : "danger-full-access");
}

export function sandboxChoiceFromValue(value: string): BuiltinSandboxChoice | undefined {
	if (BUILTIN_SANDBOX_CHOICES.includes(value as BuiltinSandboxChoice)) return value as BuiltinSandboxChoice;
	return undefined;
}

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

function requireStringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value)) {
		throw new Error(`${name} must be an array of strings`);
	}
	const invalid = value.find((entry) => typeof entry !== "string" || entry.length === 0);
	if (invalid !== undefined) {
		throw new Error(`${name} must contain only non-empty strings`);
	}
	return [...value];
}

export function parseConfig(value: unknown): SandboxExtensionConfig {
	if (!value || typeof value !== "object") {
		throw new Error("config must be an object");
	}
	const filesystem = (value as Partial<SandboxExtensionConfig>).filesystem;
	if (!filesystem || typeof filesystem !== "object") {
		throw new Error("filesystem must be an object");
	}

	const parsedFilesystem: SandboxExtensionConfig["filesystem"] = {
		denyRead: requireStringArray(filesystem.denyRead, "filesystem.denyRead"),
		allowWrite: requireStringArray(filesystem.allowWrite, "filesystem.allowWrite"),
		denyWrite: requireStringArray(filesystem.denyWrite, "filesystem.denyWrite"),
	};
	if (filesystem.allowGitConfig !== undefined) {
		if (typeof filesystem.allowGitConfig !== "boolean") {
			throw new Error("filesystem.allowGitConfig must be a boolean when provided");
		}
		parsedFilesystem.allowGitConfig = filesystem.allowGitConfig;
	}
	return { filesystem: parsedFilesystem };
}

function readConfigFile(filePath: string): SandboxExtensionConfig {
	return parseConfig(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function loadExplicitConfig(cwd: string, configPath: string): { startupConfig?: SandboxStartupConfig; warning?: string } {
	const resolvedPath = resolveConfigPath(cwd, configPath);
	try {
		if (!fs.existsSync(resolvedPath)) {
			throw new Error("file does not exist");
		}
		const config = readConfigFile(resolvedPath);
		return {
			startupConfig: {
				config,
				path: resolvedPath,
				source: `--sandbox-config: ${resolvedPath}`,
			},
		};
	} catch (error) {
		return {
			warning: `Invalid sandbox config ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function resolvedFilesystemConfig(cwd: string, config: SandboxExtensionConfig): Required<SandboxExtensionConfig>["filesystem"] {
	const tempRoots = allowedTempRoots();
	const filesystem: Required<SandboxExtensionConfig>["filesystem"] = {
		denyRead: config.filesystem.denyRead.map((entry) => absolutePath(cwd, entry)),
		allowWrite: [...new Set(config.filesystem.allowWrite.map((entry) => absolutePath(cwd, entry)))],
		denyWrite: config.filesystem.denyWrite.flatMap((entry) => {
			if (path.isAbsolute(expandHome(entry))) return [absolutePath(cwd, entry)];
			return [absolutePath(cwd, entry), ...tempRoots.map((root) => absolutePath(root, entry))];
		}),
	};
	if (typeof config.filesystem.allowGitConfig === "boolean") {
		filesystem.allowGitConfig = config.filesystem.allowGitConfig;
	}
	return filesystem;
}

export function effectiveFilesystemConfig(cwd: string, state: SandboxState): Required<SandboxExtensionConfig>["filesystem"] {
	const filesystem = resolvedFilesystemConfig(cwd, state.config);
	if (sandboxChoice(state) !== "read-only") return filesystem;
	return { ...filesystem, allowWrite: [] };
}

function runtimeConfig(cwd: string, state: SandboxState): Partial<SandboxRuntimeConfig> {
	return { filesystem: effectiveFilesystemConfig(cwd, state) };
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

export function denyWriteReason(cwd: string, state: SandboxState, requestedPath: string): string | undefined {
	if (sandboxChoice(state) === "read-only") {
		return `Sandbox blocked ${requestedPath}: read-only sandbox does not allow writes.`;
	}

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
		"Ask the user to run /sandbox danger-full-access if this operation should be allowed.",
	].join("\n");
}

export function statusText(state: SandboxState, cwd?: string): string {
	const choice = sandboxChoice(state);
	const workspace = cwd ? path.resolve(cwd) : "(current workspace)";
	const fsConfig = cwd && state.enabled ? effectiveFilesystemConfig(cwd, state) : null;
	const writeAllowed = state.enabled
		? choice === "read-only"
			? "(none; read-only sandbox)"
			: state.config.filesystem.allowWrite.join(", ")
		: "(unrestricted; sandbox disabled)";
	const readDenied = state.enabled ? state.config.filesystem.denyRead.join(", ") : "(none; sandbox disabled)";
	const writeDenied = state.enabled ? state.config.filesystem.denyWrite.join(", ") : "(none; sandbox disabled)";
	const restoreHint =
		state.startupConfig && choice !== "config"
			? [`restore custom config: /sandbox config (${state.startupConfig.path})`]
			: [];
	return [
		`sandbox: ${choice}`,
		`policy source: ${state.configSource}`,
		`bash: ${state.enabled ? "OS sandboxed with filesystem policy; network is unrestricted" : "unsandboxed"}`,
		`workspace: ${workspace}`,
		`write/edit allowed: ${writeAllowed}`,
		`read denied: ${readDenied}`,
		`write denied: ${writeDenied}`,
		...(fsConfig ? [`resolved write roots: ${fsConfig.allowWrite.join(", ")}`] : []),
		...restoreHint,
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
	ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("dim", `sandbox ${sandboxChoice(state)}`));
}

export function createSandboxState(enabled = true): SandboxState {
	const choice: BuiltinSandboxChoice = enabled ? "workspace-write" : "danger-full-access";
	return {
		choice,
		enabled,
		config: cloneConfig(DEFAULT_CONFIG),
		configSource: `built-in: ${choice}`,
	};
}

function applyStartupFlags(pi: ExtensionAPI, ctx: ExtensionContext, state: SandboxState): void {
	const configFlag = pi.getFlag("sandbox-config");
	const configPath = typeof configFlag === "string" ? configFlag : undefined;
	const sandboxFlag = pi.getFlag("sandbox");
	const sandboxValue = typeof sandboxFlag === "string" ? sandboxFlag.trim().toLowerCase() : undefined;

	if (configPath) {
		if (sandboxValue) {
			ctx.ui.notify(`Ignoring --sandbox ${sandboxValue} because --sandbox-config was provided.`, "warning");
		}
		const loaded = loadExplicitConfig(ctx.cwd, configPath);
		if (loaded.startupConfig) {
			setConfigSandboxChoice(state, loaded.startupConfig);
			return;
		}
		if (loaded.warning) {
			ctx.ui.notify(`${loaded.warning}. Falling back to --sandbox workspace-write.`, "warning");
		}
		setBuiltinSandboxChoice(state, "workspace-write");
		return;
	}

	if (!sandboxValue) {
		setBuiltinSandboxChoice(state, "workspace-write");
		return;
	}

	const choice = sandboxChoiceFromValue(sandboxValue);
	if (choice) {
		setBuiltinSandboxChoice(state, choice);
		return;
	}

	ctx.ui.notify(`Invalid --sandbox value "${sandboxValue}". Usage: --sandbox ${BUILTIN_SANDBOX_CHOICES.join("|")}.`, "warning");
	setBuiltinSandboxChoice(state, "workspace-write");
}

export function createSandboxExtension(state: SandboxState = createSandboxState(true)) {
	return function sandboxExtension(pi: ExtensionAPI) {
		const sandboxedToolCalls = new Set<string>();

		pi.registerFlag("sandbox", {
			description: "Set sandbox choice: read-only, workspace-write, or danger-full-access",
			type: "string",
		});

		pi.registerFlag("sandbox-config", {
			description: "Path to complete sandbox config JSON",
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

		pi.on("tool_result", (event): SandboxToolResultEventResult | undefined => {
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
				const builtinChoice = sandboxChoiceFromValue(value);
				if (!builtinChoice && value !== "config") {
					ctx.ui.notify(`Usage: /sandbox [${SANDBOX_USAGE}]`, "warning");
					return;
				}
				if (!ctx.isIdle()) {
					ctx.ui.notify("Cannot change sandbox while a Pi turn is running. Run /sandbox again after the turn finishes.", "warning");
					return;
				}
				if (builtinChoice) {
					setBuiltinSandboxChoice(state, builtinChoice);
				} else {
					if (!state.startupConfig) {
						ctx.ui.notify("No startup --sandbox-config is available. Sandbox unchanged.", "warning");
						updateStatus(ctx, state);
						return;
					}
					setConfigSandboxChoice(state, state.startupConfig);
				}
				updateStatus(ctx, state);
				ctx.ui.notify(statusText(state, ctx.cwd), "info");
			},
		});
	};
}

export default function sandboxExtension(pi: ExtensionAPI) {
	return createSandboxExtension(createSandboxState(true))(pi);
}
