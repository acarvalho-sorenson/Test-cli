import { SecurityError } from "../errors/index.js";

const MAX_REVIEW_DIFF_CHARS = 60_000;

const SECRET_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: "OpenAI key", regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  {
    name: "generic secret assignment",
    regex: /(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}["']/gi,
  },
];

const HIGH_RISK_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "eval", regex: /\beval\s*\(/g },
  { name: "shell execution", regex: /\b(child_process|exec|spawn)\b/g },
  { name: "SQL string interpolation", regex: /SELECT\s+.+\$\{.+\}/gi },
];

export interface SecurityScanResult {
  sanitizedDiff: string;
  redactionCount: number;
  warnings: string[];
  wasTruncated: boolean;
}

const buildWarning = (name: string, matches: number): string =>
  `Potential ${name} pattern detected (${matches} match${matches === 1 ? "" : "es"}).`;

const countMatches = (input: string, regex: RegExp): number => {
  const matches = input.match(regex);
  return matches?.length ?? 0;
};

const redactSecrets = (input: string): { output: string; count: number } => {
  let output = input;
  let count = 0;

  for (const pattern of SECRET_PATTERNS) {
    const matches = countMatches(output, pattern.regex);
    if (matches === 0) continue;
    count += matches;
    output = output.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
  }

  return { output, count };
};

const truncateDiff = (input: string): { output: string; wasTruncated: boolean } => {
  if (input.length <= MAX_REVIEW_DIFF_CHARS) {
    return { output: input, wasTruncated: false };
  }

  const output = `${input.slice(0, MAX_REVIEW_DIFF_CHARS)}\n\n[Diff truncated for safety: ${input.length} chars total]`;
  return { output, wasTruncated: true };
};

export const scanDiffForSecurity = (diff: string): SecurityScanResult => {
  if (!diff.trim()) {
    throw new SecurityError("PR diff is empty. Nothing to review.");
  }

  const warnings: string[] = [];

  for (const pattern of HIGH_RISK_PATTERNS) {
    const matches = countMatches(diff, pattern.regex);
    if (matches > 0) {
      warnings.push(buildWarning(pattern.name, matches));
    }
  }

  const redacted = redactSecrets(diff);
  const truncated = truncateDiff(redacted.output);

  return {
    sanitizedDiff: truncated.output,
    redactionCount: redacted.count,
    warnings,
    wasTruncated: truncated.wasTruncated,
  };
};
