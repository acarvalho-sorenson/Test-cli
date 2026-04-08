import * as p from "@clack/prompts";
import { buildGitContext } from "../services/git.js";
import { verifyGhAuth, createPr } from "../services/github.js";
import { detectAiBackend, generatePrPayload } from "../services/ai.js";
import { loadTemplate } from "../services/template.js";
import { confirmAndEditPayload } from "../prompts/confirm.js";
import type { GenerateOptions } from "../types/index.js";

export const runPrCommand = async (options: GenerateOptions): Promise<void> => {
  const { targetBranch, dryRun } = options;

  p.intro(`ghprai — generating PR into \`${targetBranch}\`${dryRun ? " (dry run)" : ""}`);

  // Step 1: Verify gh CLI auth
  const authSpinner = p.spinner();
  authSpinner.start("Verifying GitHub CLI authentication...");
  await verifyGhAuth();
  authSpinner.stop("GitHub CLI authenticated.");

  // Step 2: Detect AI backend
  const aiSpinner = p.spinner();
  aiSpinner.start("Detecting AI backend...");
  const backend = await detectAiBackend();
  aiSpinner.stop(`Using: ${backend.label}`);

  // Step 3: Collect git context
  const gitSpinner = p.spinner();
  gitSpinner.start("Collecting git context...");
  const context = await buildGitContext(targetBranch);
  const commitCount = context.commitLog.split("\n").filter(Boolean).length;
  gitSpinner.stop(
    `\`${context.currentBranch}\` → \`${targetBranch}\` · ${commitCount} commit${commitCount !== 1 ? "s" : ""}`
  );

  // Step 4: Load PR template
  const templateResult = await loadTemplate(context.repoRoot);
  if (templateResult.source === "repo") {
    p.log.info(`PR template found: ${templateResult.foundAt}`);
  } else {
    p.log.info("No PR template found — using default template.");
  }

  // Step 5: Generate with AI
  const generateSpinner = p.spinner();
  generateSpinner.start("Generating PR description...");
  const payload = await generatePrPayload(context, templateResult.content);
  generateSpinner.stop("PR description generated.");

  if (dryRun) {
    p.note(
      `Title: ${payload.title}\n\n${payload.body}`,
      "Dry run — PR not created"
    );
    p.outro("Done (dry run).");
    return;
  }

  // Step 6: Interactive confirmation
  const result = await confirmAndEditPayload(payload.title, payload.body);
  if (result.action === "cancel") return;

  // Step 7: Create the PR
  const prSpinner = p.spinner();
  prSpinner.start("Creating pull request...");
  const prUrl = await createPr(targetBranch, { title: result.title, body: result.body });
  prSpinner.stop("Pull request created.");

  p.outro(`PR ready: ${prUrl}`);
};
