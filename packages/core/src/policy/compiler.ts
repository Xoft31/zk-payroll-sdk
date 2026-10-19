/**
 * Payroll Policy Compiler
 *
 * Converts human-readable payroll policy configuration into a validated,
 * deterministic contract-call payload (see `types.ts` for the compiled
 * shape). Validation failures are collected and reported together so admins
 * see every problem in one pass, rather than fixing one field at a time.
 *
 * @module
 */

import { normalizeAssetIdentity, AssetIdentityError } from "../assets/assetIdentity";
import {
  PolicyCompileError,
  PolicyCompileErrorCode,
  type CompiledPayrollPolicy,
  type CompilePolicyResult,
  type PayrollPolicyInput,
} from "./types";

// ── Internal validation helpers ──────────────────────────────────────────────

function err(
  code: PolicyCompileErrorCode,
  field: string,
  message: string,
  context: Record<string, unknown> = {}
): PolicyCompileError {
  return new PolicyCompileError(message, code, field, context);
}

function validateSettlementWindow(
  input: PayrollPolicyInput["settlementWindow"] | undefined,
  errors: PolicyCompileError[]
): void {
  if (!input) {
    errors.push(
      err(PolicyCompileErrorCode.MISSING_FIELD, "settlementWindow", "settlementWindow is required.")
    );
    return;
  }

  const { minDelaySeconds, maxOpenSeconds } = input;

  if (!Number.isFinite(minDelaySeconds) || minDelaySeconds < 0) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_SETTLEMENT_WINDOW,
        "settlementWindow.minDelaySeconds",
        "minDelaySeconds must be a finite number >= 0.",
        { minDelaySeconds }
      )
    );
  }

  if (!Number.isFinite(maxOpenSeconds) || maxOpenSeconds <= 0) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_SETTLEMENT_WINDOW,
        "settlementWindow.maxOpenSeconds",
        "maxOpenSeconds must be a finite number > 0.",
        { maxOpenSeconds }
      )
    );
  }

  if (
    Number.isFinite(minDelaySeconds) &&
    Number.isFinite(maxOpenSeconds) &&
    minDelaySeconds >= 0 &&
    maxOpenSeconds > 0 &&
    minDelaySeconds >= maxOpenSeconds
  ) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_SETTLEMENT_WINDOW,
        "settlementWindow",
        `minDelaySeconds (${minDelaySeconds}) must be less than maxOpenSeconds (${maxOpenSeconds}).`,
        { minDelaySeconds, maxOpenSeconds }
      )
    );
  }
}

function validateCapacityLimits(
  input: PayrollPolicyInput["capacityLimits"] | undefined,
  errors: PolicyCompileError[]
): void {
  if (!input) {
    errors.push(
      err(PolicyCompileErrorCode.MISSING_FIELD, "capacityLimits", "capacityLimits is required.")
    );
    return;
  }

  const { maxBatchSize, maxTotalPayout, maxPerRecipientPayout } = input;

  if (!Number.isInteger(maxBatchSize) || maxBatchSize <= 0) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_CAPACITY_LIMIT,
        "capacityLimits.maxBatchSize",
        "maxBatchSize must be a positive integer.",
        { maxBatchSize }
      )
    );
  }

  if (typeof maxTotalPayout !== "bigint" || maxTotalPayout <= 0n) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_CAPACITY_LIMIT,
        "capacityLimits.maxTotalPayout",
        "maxTotalPayout must be a positive bigint.",
        { maxTotalPayout: String(maxTotalPayout) }
      )
    );
  }

  if (typeof maxPerRecipientPayout !== "bigint" || maxPerRecipientPayout <= 0n) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_CAPACITY_LIMIT,
        "capacityLimits.maxPerRecipientPayout",
        "maxPerRecipientPayout must be a positive bigint.",
        { maxPerRecipientPayout: String(maxPerRecipientPayout) }
      )
    );
  }

  if (
    typeof maxTotalPayout === "bigint" &&
    typeof maxPerRecipientPayout === "bigint" &&
    maxTotalPayout > 0n &&
    maxPerRecipientPayout > 0n &&
    maxPerRecipientPayout > maxTotalPayout
  ) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_CAPACITY_LIMIT,
        "capacityLimits.maxPerRecipientPayout",
        "maxPerRecipientPayout cannot exceed maxTotalPayout.",
        {
          maxPerRecipientPayout: String(maxPerRecipientPayout),
          maxTotalPayout: String(maxTotalPayout),
        }
      )
    );
  }
}

function validateReserveRequirements(
  input: PayrollPolicyInput["reserveRequirements"] | undefined,
  capacity: PayrollPolicyInput["capacityLimits"] | undefined,
  errors: PolicyCompileError[]
): void {
  if (!input) {
    errors.push(
      err(
        PolicyCompileErrorCode.MISSING_FIELD,
        "reserveRequirements",
        "reserveRequirements is required."
      )
    );
    return;
  }

  const { minReserveBalance } = input;

  if (typeof minReserveBalance !== "bigint" || minReserveBalance < 0n) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_RESERVE,
        "reserveRequirements.minReserveBalance",
        "minReserveBalance must be a non-negative bigint.",
        { minReserveBalance: String(minReserveBalance) }
      )
    );
  }
}

function validateAuditSettings(
  input: PayrollPolicyInput["auditSettings"] | undefined,
  errors: PolicyCompileError[]
): void {
  if (!input) {
    errors.push(
      err(PolicyCompileErrorCode.MISSING_FIELD, "auditSettings", "auditSettings is required.")
    );
    return;
  }

  const { auditRequired, retentionDays, allowedViewerRoles } = input;

  if (typeof auditRequired !== "boolean") {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_AUDIT_SETTINGS,
        "auditSettings.auditRequired",
        "auditRequired must be a boolean.",
        { auditRequired }
      )
    );
  }

  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_AUDIT_SETTINGS,
        "auditSettings.retentionDays",
        "retentionDays must be a non-negative integer.",
        { retentionDays }
      )
    );
  }

  if (auditRequired === true && Number.isInteger(retentionDays) && retentionDays < 1) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_AUDIT_SETTINGS,
        "auditSettings.retentionDays",
        "retentionDays must be at least 1 when auditRequired is true.",
        { retentionDays }
      )
    );
  }

  if (allowedViewerRoles !== undefined) {
    if (
      !Array.isArray(allowedViewerRoles) ||
      allowedViewerRoles.some((r) => typeof r !== "string")
    ) {
      errors.push(
        err(
          PolicyCompileErrorCode.INVALID_AUDIT_SETTINGS,
          "auditSettings.allowedViewerRoles",
          "allowedViewerRoles must be an array of strings.",
          { allowedViewerRoles }
        )
      );
    }
  }
}

// ── Effective-date validation ────────────────────────────────────────────────

/**
 * Normalizes an effective/expiration date input to epoch milliseconds.
 *
 * Accepts ISO 8601 strings (e.g. `"2026-10-01T00:00:00Z"`, `"2026-10-01"`) or
 * epoch milliseconds.
 *
 * @returns `NaN` when the input is missing or unparseable.
 */
function parseDateInput(value: string | number | undefined): number {
  if (value === undefined) return NaN;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Formats an epoch-ms value as a UTC ISO-8601 date string for error messages.
 */
function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function validateEffectiveDates(
  input: Pick<PayrollPolicyInput, "effectiveDate" | "endDate">,
  nowMs: number,
  errors: PolicyCompileError[]
): { effectiveDateMs?: number; endDateMs?: number } {
  const { effectiveDate, endDate } = input;
  const hasEffective = effectiveDate !== undefined;
  const hasEnd = endDate !== undefined;

  // endDate without effectiveDate is incoherent — require the pair.
  if (hasEnd && !hasEffective) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_EFFECTIVE_DATE,
        "endDate",
        "endDate requires effectiveDate to be set as well.",
        { endDate }
      )
    );
    return {};
  }

  if (!hasEffective) return {};

  const effectiveMs = parseDateInput(effectiveDate);
  if (Number.isNaN(effectiveMs)) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_EFFECTIVE_DATE,
        "effectiveDate",
        "effectiveDate must be a valid date (ISO 8601 date/datetime string or epoch milliseconds).",
        { effectiveDate }
      )
    );
    return {};
  }

  if (effectiveMs < nowMs) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_EFFECTIVE_DATE,
        "effectiveDate",
        `effectiveDate (${formatUtcDate(effectiveMs)}) must not be in the past (today is ${formatUtcDate(nowMs)}).`,
        { effectiveDate, effectiveDateMs: effectiveMs, nowMs }
      )
    );
    return {};
  }

  if (!hasEnd) return { effectiveDateMs: effectiveMs };

  const endMs = parseDateInput(endDate);
  if (Number.isNaN(endMs)) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_EFFECTIVE_DATE,
        "endDate",
        "endDate must be a valid date (ISO 8601 date/datetime string or epoch milliseconds).",
        { endDate }
      )
    );
    return {};
  }

  if (endMs <= effectiveMs) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_EFFECTIVE_DATE,
        "endDate",
        `endDate (${formatUtcDate(endMs)}) must be after effectiveDate (${formatUtcDate(effectiveMs)}).`,
        { endDate, endDateMs: endMs, effectiveDateMs: effectiveMs }
      )
    );
    return {};
  }

  return { effectiveDateMs: effectiveMs, endDateMs: endMs };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Options for {@link compilePayrollPolicy}. */
export interface CompilePolicyOptions {
  /**
   * Reference time (epoch ms) used for the effective-date "not in the past"
   * check. Defaults to the current wall-clock time. Pass a fixed value in
   * tests or replay/backfill flows to keep compilation deterministic.
   */
  now?: number;
}

/**
 * Compiles a human-readable {@link PayrollPolicyInput} into a validated,
 * deterministic {@link CompiledPayrollPolicy} contract-call payload.
 *
 * Every validation problem is collected and returned together (rather than
 * throwing on the first one) so callers — typically an admin-facing form or
 * CLI — can surface all issues at once.
 *
 * Bigint fields are compiled to decimal strings so the result is safe to
 * `JSON.stringify` for logging, snapshotting, or transport, while remaining
 * round-trippable via `BigInt(value)`.
 *
 * When `effectiveDate` is provided it must parse to a real date and must not
 * be in the past (relative to `options.now ?? Date.now()`); an `endDate` must
 * also parse and be strictly after `effectiveDate`.
 *
 * @example
 * ```typescript
 * import { compilePayrollPolicy } from "@zk-payroll/core";
 *
 * const result = compilePayrollPolicy({
 *   policyId: "default",
 *   asset: "native",
 *   effectiveDate: "2026-10-01T00:00:00Z",
 *   endDate: "2027-10-01T00:00:00Z",
 *   settlementWindow: { minDelaySeconds: 60, maxOpenSeconds: 3600 },
 *   capacityLimits: {
 *     maxBatchSize: 500,
 *     maxTotalPayout: 1_000_000_0000000n,
 *     maxPerRecipientPayout: 50_000_0000000n,
 *   },
 *   reserveRequirements: { minReserveBalance: 100_000_0000000n },
 *   auditSettings: { auditRequired: true, retentionDays: 365 },
 * });
 *
 * if (result.ok) {
 *   await contract.setPolicy(result.value);
 * } else {
 *   result.errors.forEach((e) => console.error(e.field, e.message));
 * }
 * ```
 */
export function compilePayrollPolicy(
  input: PayrollPolicyInput,
  options: CompilePolicyOptions = {}
): CompilePolicyResult {
  const errors: PolicyCompileError[] = [];

  if (!input.policyId || input.policyId.trim() === "") {
    errors.push(
      err(
        PolicyCompileErrorCode.MISSING_FIELD,
        "policyId",
        "policyId is required and cannot be empty."
      )
    );
  }

  let assetId: string | undefined;
  try {
    assetId = normalizeAssetIdentity(input.asset).id;
  } catch (assetErr) {
    if (assetErr instanceof AssetIdentityError) {
      errors.push(
        err(PolicyCompileErrorCode.INVALID_ASSET, "asset", assetErr.message, {
          assetIdentityErrorCode: assetErr.code,
          ...assetErr.context,
        })
      );
    } else {
      throw assetErr;
    }
  }

  validateSettlementWindow(input.settlementWindow, errors);
  validateCapacityLimits(input.capacityLimits, errors);
  validateReserveRequirements(input.reserveRequirements, input.capacityLimits, errors);
  validateAuditSettings(input.auditSettings, errors);

  const dates = validateEffectiveDates(
    { effectiveDate: input.effectiveDate, endDate: input.endDate },
    options.now ?? Date.now(),
    errors
  );

  // Cross-field check: reserve must not exceed the total payout capacity,
  // since a policy that reserves more than it can ever pay out is incoherent.
  if (
    input.reserveRequirements &&
    input.capacityLimits &&
    typeof input.reserveRequirements.minReserveBalance === "bigint" &&
    typeof input.capacityLimits.maxTotalPayout === "bigint" &&
    input.reserveRequirements.minReserveBalance > 0n &&
    input.capacityLimits.maxTotalPayout > 0n &&
    input.reserveRequirements.minReserveBalance > input.capacityLimits.maxTotalPayout
  ) {
    errors.push(
      err(
        PolicyCompileErrorCode.INVALID_RESERVE,
        "reserveRequirements.minReserveBalance",
        "minReserveBalance cannot exceed capacityLimits.maxTotalPayout.",
        {
          minReserveBalance: String(input.reserveRequirements.minReserveBalance),
          maxTotalPayout: String(input.capacityLimits.maxTotalPayout),
        }
      )
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // At this point all required sub-objects are validated and present.
  const compiled: CompiledPayrollPolicy = {
    policyId: input.policyId.trim(),
    assetId: assetId as string,
    ...(dates.effectiveDateMs !== undefined ? { effectiveDateMs: dates.effectiveDateMs } : {}),
    ...(dates.endDateMs !== undefined ? { endDateMs: dates.endDateMs } : {}),
    settlement: {
      minDelaySeconds: input.settlementWindow.minDelaySeconds,
      maxOpenSeconds: input.settlementWindow.maxOpenSeconds,
    },
    capacity: {
      maxBatchSize: input.capacityLimits.maxBatchSize,
      maxTotalPayout: input.capacityLimits.maxTotalPayout.toString(),
      maxPerRecipientPayout: input.capacityLimits.maxPerRecipientPayout.toString(),
    },
    reserve: {
      minReserveBalance: input.reserveRequirements.minReserveBalance.toString(),
      strict: input.reserveRequirements.strict ?? true,
    },
    audit: {
      auditRequired: input.auditSettings.auditRequired,
      retentionDays: input.auditSettings.retentionDays,
      allowedViewerRoles: input.auditSettings.allowedViewerRoles ?? [],
    },
    schemaVersion: 1,
  };

  return { ok: true, value: compiled };
}

/**
 * Throwing variant of {@link compilePayrollPolicy}.
 *
 * Throws the first collected {@link PolicyCompileError} when validation
 * fails; inspect `error.context.allErrors` for the full list if needed via
 * {@link compilePayrollPolicy} directly.
 *
 * @throws {PolicyCompileError} on any validation failure.
 */
export function compilePayrollPolicyOrThrow(
  input: PayrollPolicyInput,
  options: CompilePolicyOptions = {}
): CompiledPayrollPolicy {
  const result = compilePayrollPolicy(input, options);
  if (!result.ok) {
    const [first, ...rest] = result.errors;
    first.context.allErrors = result.errors.map((e) => ({
      code: e.code,
      field: e.field,
      message: e.message,
    }));
    if (rest.length > 0) {
      first.message = `${first.message} (and ${rest.length} more validation error(s); see error.context.allErrors)`;
    }
    throw first;
  }
  return result.value;
}
