import * as p from "@clack/prompts";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { PrReviewAction } from "../types/index.js";

export interface ConfirmReviewResult {
  action: "submit" | "ignore";
  mode: PrReviewAction;
  body: string;
}

const MODE_LABELS: Record<PrReviewAction, string> = {
  comment: "Comment",
  approve: "Approve",
  "request-changes": "Request changes",
};

const PREVIEW_DIVIDER = "-".repeat(70);

const openEditor = async (content: string): Promise<string> => {
  const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "nano";
  const tempPath = join(tmpdir(), `ghprai-review-${Date.now()}.md`);

  await writeFile(tempPath, content, "utf-8");

  const result = await execa(editor, [tempPath], { stdio: "inherit", reject: false });
  if (result.exitCode !== 0) {
    await unlink(tempPath).catch(() => undefined);
    return content;
  }

  const edited = await readFile(tempPath, "utf-8");
  await unlink(tempPath).catch(() => undefined);
  return edited;
};

const printPreview = (mode: PrReviewAction, body: string): void => {
  process.stdout.write(`\n${PREVIEW_DIVIDER}\n`);
  process.stdout.write(`Suggested action: ${MODE_LABELS[mode]}\n`);
  process.stdout.write(`${PREVIEW_DIVIDER}\n\n`);
  process.stdout.write(`${body}\n`);
  process.stdout.write(`${PREVIEW_DIVIDER}\n\n`);
};

const chooseMode = async (mode: PrReviewAction): Promise<PrReviewAction | undefined> => {
  const selected = await p.select({
    message: "Choose review mode",
    options: [
      { value: "comment", label: "Comment" },
      { value: "approve", label: "Approve" },
      { value: "request-changes", label: "Request changes" },
    ],
    initialValue: mode,
  });

  if (p.isCancel(selected)) {
    return undefined;
  }

  return selected;
};

export const confirmReviewSuggestion = async (
  mode: PrReviewAction,
  body: string
): Promise<ConfirmReviewResult> => {
  printPreview(mode, body);

  const action = await p.select({
    message: "Review suggestion ready - what would you like to do?",
    options: [
      { value: "submit", label: "Submit review" },
      { value: "change-mode", label: "Change mode" },
      { value: "edit", label: `Edit message (opens ${process.env["EDITOR"] ?? "nano"})` },
      { value: "ignore", label: "Ignore suggestion" },
    ],
  });

  if (p.isCancel(action) || action === "ignore") {
    p.cancel("Suggestion ignored. No review posted.");
    return { action: "ignore", mode, body };
  }

  if (action === "change-mode") {
    const selectedMode = await chooseMode(mode);
    if (!selectedMode) {
      p.cancel("Suggestion ignored. No review posted.");
      return { action: "ignore", mode, body };
    }
    return confirmReviewSuggestion(selectedMode, body);
  }

  if (action === "edit") {
    p.note("Opening editor... save and close to continue.", "Editor");
    const editedBody = await openEditor(body);
    return confirmReviewSuggestion(mode, editedBody);
  }

  return { action: "submit", mode, body };
};
