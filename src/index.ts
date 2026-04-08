import { Command } from "commander";
import { runPrCommand } from "./commands/pr.js";
import { runPrReviewCommand } from "./commands/pr-review.js";
import { runReleaseCreateCommand } from "./commands/release.js";
import { runVersionCommand } from "./commands/version.js";
import { isAppError } from "./errors/index.js";

const program = new Command();

program
  .name("ghprai")
  .description("AI-powered GitHub Pull Request generator")
  .version("1.0.0");

program
  .command("version")
  .description("Verify CLI version and GitHub CLI availability")
  .action(async () => {
    await runVersionCommand().catch(handleError);
  });

program
  .command("pr <target-branch>")
  .description("Generate and create a PR from current branch into <target-branch>")
  .option("--dry-run", "Generate PR content but do not create it", false)
  .action(async (targetBranch: string, opts: { dryRun: boolean }) => {
    await runPrCommand({ targetBranch, dryRun: opts.dryRun }).catch(handleError);
  });

program
  .command("review <pr>")
  .description("Review a PR with AI suggestions and optional submit")
  .option("--dry-run", "Generate review suggestion but do not submit it", false)
  .option("--inline", "Post review comments on code lines when possible", false)
  .option(
    "--instruction <text>",
    "Customize reviewer focus and tone (example: focus on tests and performance)"
  )
  .option(
    "--mode <mode>",
    "Force review mode (comment | approve | request-changes)"
  )
  .action(
    async (
      pr: string,
      opts: {
        dryRun: boolean;
        inline: boolean;
        instruction?: string;
        mode?: "comment" | "approve" | "request-changes";
      }
    ) => {
      await runPrReviewCommand({
        pr,
        dryRun: opts.dryRun,
        inline: opts.inline,
        instruction: opts.instruction,
        mode: opts.mode,
      }).catch(handleError);
    }
  );

const releaseCommand = program.command("release").description("Release management commands");

releaseCommand
  .command("create")
  .description("Create a release tag and GitHub release with release-please style notes")
  .option("--base <branch>", "Base branch to release from (default: origin HEAD branch)")
  .option("--from <ref>", "Start reference for commit analysis (default: latest semver tag)")
  .option("--tag <tag>", "Release tag to create (format: vX.Y.Z)")
  .option("--yes", "Skip confirmation prompt", false)
  .option("--lang <code>", "Force notes language (e.g. en, pt-BR)")
  .option("--dry-run", "Generate suggestion and notes without creating a release", false)
  .action(
    async (opts: {
      base?: string;
      from?: string;
      tag?: string;
      yes: boolean;
      lang?: string;
      dryRun: boolean;
    }) => {
      await runReleaseCreateCommand({
        base: opts.base,
        from: opts.from,
        tag: opts.tag,
        yes: opts.yes,
        lang: opts.lang,
        dryRun: opts.dryRun,
      }).catch(handleError);
    }
  );

program.parseAsync(process.argv).catch(handleError);

function handleError(err: unknown): void {
  if (isAppError(err)) {
    process.stderr.write(`\nError [${err.kind}]: ${err.message}\n`);
  } else if (err instanceof Error) {
    process.stderr.write(`\nUnexpected error: ${err.message}\n`);
    if (process.env["DEBUG"]) {
      process.stderr.write(`${err.stack ?? ""}\n`);
    }
  } else {
    process.stderr.write(`\nUnexpected error: ${String(err)}\n`);
  }
  process.exit(1);
}
