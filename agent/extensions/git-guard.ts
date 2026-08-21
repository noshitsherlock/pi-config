/**
 * Git Guard Extension
 *
 * Intercepts tool calls to guard against unintended modifications.
 *
 * File guarding (write/edit):
 *  - Prompts when target file is in a different git repository than cwd.
 *  - Prompts when target file is not tracked by git (staged or committed).
 *  - In non-interactive mode, blocks by default. Does nothing outside git repos.
 *
 * Bash guarding:
 *  - Blocks interactive git commands that would hang waiting for an editor.
 *  - Blocks destructive git commands (reset --hard, clean -f, checkout ., etc.).
 */

import type { ExtensionAPI, ExtensionContext, BashToolCallEvent } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { resolve, dirname, join } from "node:path";
import { existsSync, realpathSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const COMMIT_PATTERN = /git\s+commit/;

const INTERACTIVE_GIT_PATTERNS: RegExp[] = [
  /git\s+merge(?!.*(--no-edit|-m|-F|--file))/,
  /git\s+rebase\s+--continue(?!.*(GIT_EDITOR|core\.editor))/,
  /git\s+tag\s+(-a|--annotate|-s|--sign)(?!.*(-m|--message|-F|--file))/,
];

const DESTRUCTIVE_GIT_PATTERNS: RegExp[] = [
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-[a-zA-Z]*f/,
  /git\s+checkout\s+\.(?=\s|$)/,
  // Allows: list, show, create (read-only)
  /git\s+stash(?!\s+(list|show|create))(?:\s|$)/,
  /git\s+add\s+(-A|--all|\.)(?=\s|$)/,
  /git\s+rm\s+(?:-[a-zA-Z]*f[a-zA-Z]*|--force)/,
];

const GIT_TIMEOUT = 5000;

function nearestExistingDir(dir: string): string {
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

function parseCommitMessage(command: string): string | null {
  // Bail out for -F/--file, -C/--reuse-message
  if (/(?:^|\s)(-F|--file|-C|--reuse-message)(?:\s|=|$)/.test(command)) return null;

  const messages: string[] = [];
  // Match -m or --message variants
  const pattern = /(?:^|\s)(?:-m\s*|--message(?:=|\s+))("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    let msg = match[1];
    if ((msg.startsWith('"') && msg.endsWith('"')) || (msg.startsWith("'") && msg.endsWith("'"))) {
      msg = msg.slice(1, -1);
    }
    // Unescape basic sequences
    msg = msg.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    messages.push(msg);
  }

  if (messages.length === 0) return null;
  return messages.join("\n\n");
}

function replaceCommitMessage(command: string, newMessage: string): string {
  // Remove all existing -m/--message arguments
  let cleaned = command;
  // Remove --message="..." / --message='...' / --message=unquoted
  cleaned = cleaned.replace(/\s+--message=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g, "");
  // Remove --message "..." / --message '...' / --message unquoted
  cleaned = cleaned.replace(/\s+--message\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g, "");
  // Remove -m"..." / -m'...' / -m unquoted
  cleaned = cleaned.replace(/\s+-m\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g, "");

  // Escape the new message for shell double quotes
  const escaped = newMessage.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  // Insert -m after "git commit"
  cleaned = cleaned.replace(/(git\s+commit)/, `$1 -m "${escaped}"`);
  return cleaned;
}

function resolveEditor(): string {
  // 1. GIT_EDITOR
  if (process.env.GIT_EDITOR) return process.env.GIT_EDITOR;
  // 2. git config core.editor
  const result = spawnSync("git", ["config", "core.editor"], { encoding: "utf-8", timeout: 5000 });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  // 3. VISUAL
  if (process.env.VISUAL) return process.env.VISUAL;
  // 4. EDITOR
  if (process.env.EDITOR) return process.env.EDITOR;
  // 5. Fallback
  return "vi";
}

async function openEditorForMessage(
  message: string,
  ctx: ExtensionContext,
): Promise<string | null> {
  if (!ctx.hasUI) return null;

  const editorCmd = resolveEditor();
  const tmpFile = join(tmpdir(), `pi-commit-msg-${Date.now()}.txt`);
  const shell = process.env.SHELL || "/bin/sh";
  // Shell-escape the temp file path and build full command
  const escapedPath = tmpFile.replace(/'/g, "'\\''");
  const fullCommand = `${editorCmd} '${escapedPath}'`;

  try {
    writeFileSync(tmpFile, message);

    const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
      tui.stop();
      process.stdout.write("\x1b[2J\x1b[H");

      const result = spawnSync(shell, ["-c", fullCommand], {
        stdio: "inherit",
        env: process.env,
      });

      tui.start();
      tui.requestRender(true);
      done(result.status);
      return { render: () => [], invalidate: () => {} };
    });

    if (exitCode !== 0) return null;

    const edited = readFileSync(tmpFile, "utf-8");
    if (edited === message) return null;
    return edited;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

const sessionTouchedFiles = new Set<string>();

export default function(pi: ExtensionAPI) {
  async function getGitRoot(dir: string): Promise<string | null> {
    const realDir = existsSync(dir) ? realpathSync(dir) : dir;
    const { code, stdout } = await pi.exec("git", ["-C", realDir, "rev-parse", "--show-toplevel"], { timeout: GIT_TIMEOUT });
    if (code !== 0) return null;
    const root = stdout.trim();
    return existsSync(root) ? realpathSync(root) : null;
  }

  async function isGitTracked(filePath: string, gitDir: string): Promise<boolean> {
    const { code } = await pi.exec("git", ["-C", gitDir, "ls-files", "--error-unmatch", filePath], { timeout: GIT_TIMEOUT });
    return code === 0;
  }

  async function promptOrBlock(
    message: string,
    toolName: string,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    const reason = `Blocked ${toolName}: ${message}`;
    if (!ctx.hasUI) return { block: true, reason };

    const choice = await ctx.ui.select(
      `⚠️ ${message}\n\nAllow ${toolName}?`,
      ["Yes, allow this once", "No, block it"],
    );
    return choice === "Yes, allow this once" ? undefined : { block: true, reason };
  }

  async function gatePath(
    filePath: string,
    toolName: string,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    const abs = resolve(ctx.cwd, filePath);
    const fileDir = nearestExistingDir(dirname(abs));

    const cwdRoot = await getGitRoot(ctx.cwd);
    if (!cwdRoot) return undefined;

    const fileRoot = await getGitRoot(fileDir);
    if (!fileRoot || fileRoot !== cwdRoot) {
      return promptOrBlock(`"${filePath}" is outside the current git repository`, toolName, ctx);
    }

    const realAbs = existsSync(abs) ? realpathSync(abs) : abs;
    if (await isGitTracked(realAbs, cwdRoot)) return undefined;

    // New files (don't exist yet) are always allowed
    if (!existsSync(abs)) return undefined;

    return promptOrBlock(`"${filePath}" is not tracked by git`, toolName, ctx);
  }

  async function promptCommitOrBlock(
    event: BashToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    const command = event.input.command ?? "";
    const reason = `Blocked bash: git commit requires approval`;
    if (!ctx.hasUI) return { block: true, reason };

    const parsed = parseCommitMessage(command);
    if (!parsed) {
      // No parseable message: check if any message source flag is present.
      // If not, this is an interactive commit that would hang waiting for an editor.
      const hasMessageSource = /(?:^|\s)(-m|--message|-F|--file|-C|--reuse-message|--no-edit)(?:\s|=|$)/.test(command);
      if (!hasMessageSource) {
        return { block: true, reason: "Blocked: interactive git commit (would open editor)" };
      }
      // Has a message source we can't parse (e.g. -F, -C): fall back to two-option dialog
      return promptOrBlock(`git commit requires approval:\n${command}`, "bash", ctx);
    }

    let currentMessage = parsed;
    let currentCommand = command;

    while (true) {
      const theme = ctx.ui.theme;
      const title = [
        "git commit requires approval",
        "",
        theme.fg("accent", "Message:"),
        ...currentMessage.split("\n").map((l) => theme.fg("accent", `  ${l}`)),
        "",
        theme.fg("dim", "Command:"),
        theme.fg("dim", `  ${currentCommand}`),
      ].join("\n");

      const choice = await ctx.ui.select(title, [
        "Yes, allow this once",
        "Edit message",
        "No, block it",
      ]);

      if (choice === "Yes, allow this once") {
        if (currentCommand !== command) {
          event.input.command = currentCommand;
        }
        return undefined;
      }

      if (choice === "Edit message") {
        const edited = await openEditorForMessage(currentMessage, ctx);
        if (edited !== null) {
          currentMessage = edited;
          currentCommand = replaceCommitMessage(currentCommand, edited);
        }
        continue;
      }

      // "No, block it" or dismissed
      return { block: true, reason };
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("write", event)) {
      const abs = resolve(ctx.cwd, event.input.path);
      if (sessionTouchedFiles.has(abs)) return undefined;
      const result = await gatePath(event.input.path, "write", ctx);
      if (!result) sessionTouchedFiles.add(abs);
      return result;
    }
    if (isToolCallEventType("edit", event)) {
      const abs = resolve(ctx.cwd, event.input.path);
      if (sessionTouchedFiles.has(abs)) return undefined;
      const result = await gatePath(event.input.path, "edit", ctx);
      if (!result) sessionTouchedFiles.add(abs);
      return result;
    }
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? "";
      if (INTERACTIVE_GIT_PATTERNS.some((p) => p.test(command))) {
        return { block: true, reason: "Blocked: interactive git command" };
      }
      if (DESTRUCTIVE_GIT_PATTERNS.some((p) => p.test(command))) {
        return { block: true, reason: "Blocked: destructive git command" };
      }
      if (COMMIT_PATTERN.test(command)) {
        return promptCommitOrBlock(event as BashToolCallEvent, ctx);
      }
    }
    return undefined;
  });
}
