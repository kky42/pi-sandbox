/**
 * Pievo Sandbox Extension
 *
 * Lightweight sandboxing for Pi Agent without replacing built-in tools.
 *
 * - bash is sandboxed by mutating the built-in bash tool input after the model
 *   requests the tool and before Pi executes it.
 * - write/edit are blocked when they target paths outside the workspace or the
 *   system temp directory.
 * - read/search/list tools are blocked for sensitive home-directory paths.
 * - /sandbox shows or toggles the runtime sandbox state in the Pi TUI.
 */

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
} from "@mariozechner/pi-coding-agent";

export interface SandboxState {
	enabled: boolean;
}

const DEFAULT_STATE: SandboxState = { enabled: true };
const DENY_READ_PATHS = ["~/.ssh", "~/.aws", "~/.gnupg"];
const DENY_WRITE_LABELS = [".env", ".env.*", "*.pem", "*.key"];
const DENY_WRITE_PATTERNS = [/^\.env(?:\..*)?$/i, /\.pem$/i, /\.key$/i];

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
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

function tempRootsText(): string {
	return allowedTempRoots().join(", ");
}

function filesystemConfig(cwd: string): Partial<SandboxRuntimeConfig>["filesystem"] {
	const workspace = path.resolve(cwd);
	const tempRoots = allowedTempRoots();
	const denyWrite = [
		"**/.env",
		"**/.env.*",
		"**/*.pem",
		"**/*.key",
	].flatMap((entry) => [absolutePath(workspace, entry), ...tempRoots.map((root) => absolutePath(root, entry))]);
	return {
		denyRead: DENY_READ_PATHS.map((entry) => absolutePath(cwd, entry)),
		allowWrite: [workspace, ...tempRoots],
		denyWrite,
	};
}

function runtimeConfig(cwd: string): Partial<SandboxRuntimeConfig> {
	return { filesystem: filesystemConfig(cwd) };
}

function denyReadReason(cwd: string, requestedPath: string): string | undefined {
	const target = absolutePath(cwd, requestedPath || ".");
	for (const denied of DENY_READ_PATHS) {
		const deniedPath = absolutePath(cwd, denied);
		if (isInside(deniedPath, target) || isInside(target, deniedPath)) {
			return `Sandbox blocked ${requestedPath}: reading ${denied} is not allowed.`;
		}
	}
	return undefined;
}

function denyWriteReason(cwd: string, requestedPath: string): string | undefined {
	const target = absolutePath(cwd, requestedPath);
	const workspace = path.resolve(cwd);
	const tempRoots = allowedTempRoots();
	const allowed = isInside(workspace, target) || tempRoots.some((root) => isInside(root, target));
	if (!allowed) {
		return [
			`Sandbox blocked ${requestedPath}: writing outside the workspace or temp directory is not allowed.`,
			`Workspace: ${workspace}`,
			`Temp: ${tempRootsText()}`,
		].join("\n");
	}
	const basename = path.basename(target);
	if (DENY_WRITE_PATTERNS.some((pattern) => pattern.test(basename))) {
		return `Sandbox blocked ${requestedPath}: writing ${basename} is not allowed by the sandbox policy.`;
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
	return [
		`sandbox: ${state.enabled ? "on" : "off"}`,
		"bash: OS sandboxed with filesystem policy; network is unrestricted",
		`write/edit allowed: ${workspace}, temp dirs (${tempRootsText()})`,
		`read denied: ${DENY_READ_PATHS.join(", ")}`,
		`write denied: ${DENY_WRITE_LABELS.join(", ")}`,
	].join("\n");
}

async function wrapBashCommand(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
	const wrappedCommand = await SandboxManager.wrapWithSandbox(command, undefined, runtimeConfig(cwd), signal);
	if (process.platform === "darwin" && wrappedCommand.startsWith("env ")) {
		return `/usr/bin/${wrappedCommand}`;
	}
	return wrappedCommand;
}

function createSandboxedBashOperations(): BashOperations {
	const local = createLocalBashOperations();
	return {
		async exec(command, cwd, options) {
			const wrappedCommand = await wrapBashCommand(command, cwd, options.signal);
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

function blockForFileTool(event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | undefined {
	if (event.toolName === "write" || event.toolName === "edit") {
		const targetPath = typeof event.input.path === "string" ? event.input.path : "";
		if (!targetPath) return undefined;
		const reason = denyWriteReason(ctx.cwd, targetPath);
		return reason ? { block: true, reason: respectfulBlock(reason) } : undefined;
	}

	if (event.toolName === "read" || event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
		const targetPath = typeof event.input.path === "string" ? event.input.path : ".";
		const reason = denyReadReason(ctx.cwd, targetPath);
		return reason ? { block: true, reason: respectfulBlock(reason) } : undefined;
	}

	return undefined;
}

function updateStatus(ctx: ExtensionContext, state: SandboxState): void {
	ctx.ui.setStatus("sandbox", `sandbox:${state.enabled ? "on" : "off"}`);
}

export function createSandboxState(enabled = true): SandboxState {
	return { enabled };
}

export function createSandboxExtension(state: SandboxState = DEFAULT_STATE) {
	return function sandboxExtension(pi: ExtensionAPI) {
		const sandboxedToolCalls = new Set<string>();

		pi.on("session_start", (_event, ctx) => {
			updateStatus(ctx, state);
		});

		pi.on("tool_call", async (event, ctx) => {
			if (!state.enabled) return undefined;

			const fileBlock = blockForFileTool(event, ctx);
			if (fileBlock) return fileBlock;

			if (event.toolName !== "bash") return undefined;
			if (typeof event.input.command !== "string") return undefined;

			try {
				event.input.command = await wrapBashCommand(event.input.command, ctx.cwd, ctx.signal);
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
			return { operations: createSandboxedBashOperations() };
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
