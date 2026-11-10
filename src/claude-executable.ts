// Match the Claude Agent SDK's executable selection for login and status.
import { existsSync } from "fs";
import { createRequire } from "node:module";

const SCRIPT_EXTENSIONS = [".js", ".mjs", ".tsx", ".ts", ".jsx"];
const require = createRequire(import.meta.url);

function isDirectlyExecutable(path: string): boolean {
	return !SCRIPT_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function scriptRunner(): string {
	return (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun !== undefined ? "bun" : "node";
}

function prefersMusl(): boolean {
	const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
	return report != null && report.header?.glibcVersionRuntime === undefined;
}

function nativePackageCandidates(): string[] {
	const scope = "@anthropic-ai/claude-agent-sdk";
	const arch = process.arch;
	if (process.platform === "android") return [`${scope}-linux-${arch}-android`];
	if (process.platform !== "linux") return [`${scope}-${process.platform}-${arch}`];
	const glibcPkg = `${scope}-linux-${arch}`;
	const muslPkg = `${scope}-linux-${arch}-musl`;
	return prefersMusl() ? [muslPkg, glibcPkg] : [glibcPkg, muslPkg];
}

function resolveBundledClaudeExecutable(): string | undefined {
	const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
	for (const pkg of nativePackageCandidates()) {
		try {
			const resolved = require.resolve(`${pkg}/${binaryName}`);
			if (existsSync(resolved)) return resolved;
		} catch {
			// Try the next platform package.
		}
	}
	return undefined;
}

/** The argv prefix that launches the same binary `query()` would: `provider.pathToClaudeCodeExecutable`
 *  if set, else the bundled native binary for this host, wrapped in `bun`/`node` first if that path is a
 *  script rather than something a shell can exec directly. Append subcommand args to the result.
 *  Returns undefined only if neither resolves, which also means `query()` itself would fail to start. */
export function resolveClaudeExecutableCommand(pathToClaudeCodeExecutable: string | undefined): string[] | undefined {
	const path = pathToClaudeCodeExecutable ?? resolveBundledClaudeExecutable();
	if (!path) return undefined;
	return isDirectlyExecutable(path) ? [path] : [scriptRunner(), path];
}
