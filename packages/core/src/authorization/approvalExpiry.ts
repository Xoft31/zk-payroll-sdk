/**
 * Approval expiry formatting helpers.
 *
 * Provides a single, consistent classification of an AuthorizationRequest's
 * expiry state — active, expiring soon, expired, or missing — so dashboard
 * screens don't each reimplement their own expiry-threshold logic and risk
 * showing inconsistent messages for the same request.
 */
import type { AuthorizationRequest } from "./types";

/** Classification of an authorization request's expiry state. */
export type ApprovalExpiryState = "active" | "expiring_soon" | "expired" | "missing";

/** UI-safe metadata for one expiry state. */
export interface ApprovalExpiryStatus {
  state: ApprovalExpiryState;
  /** Short label for badges and compact displays. */
  label: string;
  /** Longer, human-readable description. */
  description: string;
  /** Suggested badge variant for UI components, matching status.ts's convention. */
  variant: "default" | "success" | "warning" | "danger" | "info";
  /** Milliseconds remaining until expiry; negative if already expired; undefined if missing. */
  remainingMs?: number;
}

/**
 * Default "expiring soon" threshold: within 1 hour of expiry.
 */
export const DEFAULT_EXPIRING_SOON_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Default grace period after expiry during which an expired approval may
 * still be surfaced as actionable (e.g. for late-arriving signatures).
 */
export const DEFAULT_EXPIRY_GRACE_PERIOD_MS = 0;

/**
 * Classifies an authorization request's expiry state as of `now`.
 *
 * - "missing": the request has no `expiresAt` set at all (some policies —
 *   see AuthorizationPolicy.expiryMs being unset — never expire).
 * - "expired": `expiresAt` has already passed.
 * - "expiring_soon": `expiresAt` is within `expiringSoonThresholdMs` of `now`.
 * - "active": `expiresAt` is set and comfortably in the future.
 *
 * @param request - The authorization request to classify.
 * @param now - Current time in epoch ms (defaults to `Date.now()`; pass an
 *   explicit value in tests for determinism).
 * @param expiringSoonThresholdMs - Window before expiry considered "soon"
 *   (default: 1 hour).
 */
export function getApprovalExpiryState(
  request: Pick<AuthorizationRequest, "expiresAt">,
  now: number = Date.now(),
  expiringSoonThresholdMs: number = DEFAULT_EXPIRING_SOON_THRESHOLD_MS
): ApprovalExpiryState {
  if (request.expiresAt === undefined) {
    return "missing";
  }

  if (!Number.isFinite(request.expiresAt)) {
    throw new Error(
      `Invalid expiresAt on authorization request: expected a finite epoch ms value, received ${String(
        request.expiresAt
      )}`
    );
  }

  if (!Number.isFinite(now)) {
    throw new Error(
      `Invalid "now" value passed to getApprovalExpiryState: expected a finite epoch ms value, received ${String(
        now
      )}`
    );
  }

  if (!Number.isFinite(expiringSoonThresholdMs) || expiringSoonThresholdMs < 0) {
    throw new Error(
      `Invalid expiringSoonThresholdMs: expected a non-negative finite number, received ${String(
        expiringSoonThresholdMs
      )}`
    );
  }

  const remainingMs = request.expiresAt - now;

  if (remainingMs <= 0) {
    return "expired";
  }
  if (remainingMs <= expiringSoonThresholdMs) {
    return "expiring_soon";
  }
  return "active";
}

const EXPIRY_STATUS_LABELS: Record<
  ApprovalExpiryState,
  Omit<ApprovalExpiryStatus, "remainingMs" | "state">
> = {
  active: {
    label: "Active",
    description: "Approval window is open and not close to expiring",
    variant: "success",
  },
  expiring_soon: {
    label: "Expiring Soon",
    description: "Approval window will close soon — outstanding signers should act now",
    variant: "warning",
  },
  expired: {
    label: "Expired",
    description: "Approval window has closed; this request can no longer be signed",
    variant: "danger",
  },
  missing: {
    label: "No Expiry",
    description: "This request has no expiry configured and remains open indefinitely",
    variant: "default",
  },
};

/**
 * Formats an authorization request's expiry into a UI-safe status object —
 * stable label, description, badge variant, and remaining time.
 *
 * @param request - The authorization request to format.
 * @param now - Current time in epoch ms (defaults to `Date.now()`).
 * @param expiringSoonThresholdMs - Window before expiry considered "soon".
 *
 * @example
 * ```ts
 * const status = formatApprovalExpiry(request);
 * // { state: "expiring_soon", label: "Expiring Soon", variant: "warning", remainingMs: 1800000, ... }
 * ```
 */
export function formatApprovalExpiry(
  request: Pick<AuthorizationRequest, "expiresAt">,
  now: number = Date.now(),
  expiringSoonThresholdMs: number = DEFAULT_EXPIRING_SOON_THRESHOLD_MS
): ApprovalExpiryStatus {
  const state = getApprovalExpiryState(request, now, expiringSoonThresholdMs);
  const meta = EXPIRY_STATUS_LABELS[state];

  return {
    state,
    ...meta,
    remainingMs: request.expiresAt !== undefined ? request.expiresAt - now : undefined,
  };
}

/**
 * Returns true when an authorization request's approval window has expired
 * (i.e. it can no longer be signed). Requests without an `expiresAt` never
 * expire and therefore return false.
 *
 * @param request - The authorization request to check.
 * @param now - Current time in epoch ms (defaults to `Date.now()`).
 */
export function isApprovalExpired(
  request: Pick<AuthorizationRequest, "expiresAt">,
  now: number = Date.now()
): boolean {
  return getApprovalExpiryState(request, now) === "expired";
}

/**
 * Asserts that an authorization request's approval window is still open,
 * throwing an actionable error when it has expired. Intended to guard
 * signing/approval entry points so callers fail fast with a clear message.
 *
 * @param request - The authorization request to validate.
 * @param now - Current time in epoch ms (defaults to `Date.now()`).
 */
export function assertApprovalNotExpired(
  request: Pick<AuthorizationRequest, "expiresAt">,
  now: number = Date.now()
): void {
  if (request.expiresAt === undefined) {
    return;
  }

  const state = getApprovalExpiryState(request, now);
  if (state === "expired") {
    const elapsedMs = now - request.expiresAt;
    throw new Error(
      `Approval window has expired: request expired ${formatDuration(elapsedMs)} ago (expiresAt=${request.expiresAt}, now=${now})`
    );
  }
}

/**
 * Formats a non-negative duration in ms into a short human-readable string,
 * e.g. "2h", "45m", "30s".
 */
function formatDuration(ms: number): string {
  const absMs = Math.max(0, Math.floor(ms));
  const seconds = Math.floor(absMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  if (seconds > 0) {
    return `${seconds}s`;
  }
  return "<1s";
}

/**
 * Formats remaining (or elapsed) time into a short human-readable string,
 * e.g. "23m left", "expired 2h ago", "no expiry".
 *
 * @param request - The authorization request to format.
 * @param now - Current time in epoch ms (defaults to `Date.now()`).
 */
export function formatApprovalExpiryCountdown(
  request: Pick<AuthorizationRequest, "expiresAt">,
  now: number = Date.now()
): string {
  if (request.expiresAt === undefined) {
    return "no expiry";
  }

  const diffMs = request.expiresAt - now;
  const absMs = Math.abs(diffMs);

  const minutes = Math.floor(absMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let magnitude: string;
  if (days > 0) {
    magnitude = `${days}d`;
  } else if (hours > 0) {
    magnitude = `${hours}h`;
  } else if (minutes > 0) {
    magnitude = `${minutes}m`;
  } else {
    magnitude = "<1m";
  }

  return diffMs >= 0 ? `${magnitude} left` : `expired ${magnitude} ago`;
}
