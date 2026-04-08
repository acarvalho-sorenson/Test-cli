import * as p from "@clack/prompts";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { PrPayload } from "../types/index.js";

export interface ConfirmResult {
  action: "submit" | "cancel";
  title: string;
  body: string;
}

const openInEditor = async (content: string): Promise<string> => {
  const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "nano";
  const tmpPath = join(tmpdir(), `ghprai-body-${Date.now()}.md`);

  await writeFile(tmpPath, content, "utf-8");

  const result = await execa(editor, [tmpPath], { stdio: "inherit", reject: false });
  if (result.exitCode !== 0) {
    // Editor exited non-zero (user may have quit without saving) — return original
    await unlink(tmpPath).catch(() => undefined);
    return content;
  }

  const edited = await readFile(tmpPath, "utf-8");
  await unlink(tmpPath).catch(() => undefined);
  return edited;
};

const printPreview = (title: string, body: string): void => {
  const divider = "─".repeat(60);
  process.stdout.write(`\n${divider}\n`);
  process.stdout.write(`Title: ${title}\n`);
  process.stdout.write(`${divider}\n\n`);
  process.stdout.write(`${body}\n`);
  process.stdout.write(`${divider}\n\n`);
};

export const confirmAndEditPayload = async (
  title: string,
  body: string
): Promise<ConfirmResult> => {
  printPreview(title, body);

  const action = await p.select({
    message: "Review the generated PR — what would you like to do?",
    options: [
      { value: "submit", label: "Submit PR as-is" },
      { value: "edit-title", label: "Edit title" },
      { value: "edit-body", label: `Edit body (opens ${process.env["EDITOR"] ?? "nano"})` },
      { value: "cancel", label: "Cancel" },
    ],
  });

  if (p.isCancel(action) || action === "cancel") {
    p.cancel("PR creation cancelled.");
    return { action: "cancel", title, body };
  }

  if (action === "edit-title") {
    const newTitle = await p.text({
      message: "Enter new PR title:",
      initialValue: title,
      validate: (v) => (v.trim().length === 0 ? "Title cannot be empty." : undefined),
    });

    if (p.isCancel(newTitle)) {
      p.cancel("PR creation cancelled.");
      return { action: "cancel", title, body };
    }

    return confirmAndEditPayload(newTitle, body);
  }

  if (action === "edit-body") {
    p.note("Opening editor... save and close to continue.", "Editor");
    const editedBody = await openInEditor(body);
    return confirmAndEditPayload(title, editedBody);
  }

  return { action: "submit", title, body };
};
