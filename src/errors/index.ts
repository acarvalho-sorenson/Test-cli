export class GhAuthError extends Error {
  readonly kind = "GH_AUTH_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "GhAuthError";
  }
}

export class GitError extends Error {
  readonly kind = "GIT_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export class AiError extends Error {
  readonly kind = "AI_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}

export class TemplateError extends Error {
  readonly kind = "TEMPLATE_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export class ReleaseError extends Error {
  readonly kind = "RELEASE_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "ReleaseError";
  }
}

export class ReviewError extends Error {
  readonly kind = "REVIEW_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

export class SecurityError extends Error {
  readonly kind = "SECURITY_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

export type AppError =
  | GhAuthError
  | GitError
  | AiError
  | TemplateError
  | ReleaseError
  | ReviewError
  | SecurityError;

export const isAppError = (err: unknown): err is AppError =>
  err instanceof GhAuthError ||
  err instanceof GitError ||
  err instanceof AiError ||
  err instanceof TemplateError ||
  err instanceof ReleaseError ||
  err instanceof ReviewError ||
  err instanceof SecurityError;
