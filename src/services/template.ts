import { readFile } from "node:fs/promises";
import { join } from "node:path";

const TEMPLATE_SEARCH_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "pull_request_template.md",
];

const DEFAULT_TEMPLATE = `### Jira Activity 📚

[Jira-card](link-to-card)

<!-- Add the link to the Jira ticket here. E.g., [PROJ-123](link-to-ticket) -->

### What was done? 🗒️

<!-- Clearly and concisely describe the changes made in this Pull Request, focusing on the purpose of the change. -->

### How to Test? ✅

<!-- Provide a clear step-by-step guide for the reviewer to validate your changes. Be specific. -->

### Expected Result:

<!-- Describe what the reviewer should see or what should happen at the end of the tests. -->

### Risks and Impacts 🚨

<!-- List any risks or impacts that this change may cause (e.g., in other parts of the system, performance, etc.). If none, write "None". -->

### Screenshots / GIFs (if applicable) 📸

<!-- Add images or GIFs here that help visualize the change, especially for interface changes. -->

### Author Checklist ❗️

<!-- This checklist is the "mini DoD" of the PR. The **Acceptance Criteria (ACs)** are in the corresponding **User Story**. -->

- [ ] My branch is up to date with \`beta\`.
- [ ] I have added tests that cover my changes.
- [ ] Relevant documentation has been updated.`;

export interface TemplateResult {
  content: string;
  source: "repo" | "default";
  foundAt?: string;
}

export const loadTemplate = async (repoRoot: string): Promise<TemplateResult> => {
  for (const relPath of TEMPLATE_SEARCH_PATHS) {
    try {
      const fullPath = join(repoRoot, relPath);
      const content = await readFile(fullPath, "utf-8");
      return { content, source: "repo", foundAt: relPath };
    } catch {
      // not found, try next
    }
  }
  return { content: DEFAULT_TEMPLATE, source: "default" };
};
