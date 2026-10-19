import { ValidationError } from "../core/errors";
import type { ContractCompatibilityWarning, SupportedContractRevisionRange } from "./types";

/**
 * The contract revision range this SDK version has been built and tested
 * against. Update `min`/`max` when the SDK adds or drops support for a
 * deployed payroll contract revision.
 */
export const SDK_SUPPORTED_CONTRACT_REVISION_RANGE: SupportedContractRevisionRange = {
  min: 1,
  max: 1,
};

function assertValidRange(range: SupportedContractRevisionRange): void {
  if (
    typeof range.min !== "number" ||
    typeof range.max !== "number" ||
    !Number.isInteger(range.min) ||
    !Number.isInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw new ValidationError(
      "supportedRange must have integer min/max with 0 <= min <= max.",
      "supportedRange",
      "CONTRACT_COMPATIBILITY_INVALID_RANGE"
    );
  }
}

/**
 * Compares a connected payroll contract's revision against the range this
 * SDK version supports and returns a structured, non-throwing warning.
 *
 * Never throws for a malformed or missing `connectedRevision` — an
 * unparseable revision resolves to `status: "unknown"` so callers can warn
 * without crashing a payroll workflow. `supportedRange` is validated eagerly
 * since a misconfigured range is a programming error, not user input.
 *
 * @throws {ValidationError} when `supportedRange` is malformed
 *   (non-integer, negative, or `min > max`).
 *
 * @example
 * ```ts
 * const warning = checkContractRevisionCompatibility(2);
 * if (!warning.compatible) {
 *   console.warn(warning.code, warning.message); // safe to log
 * }
 * ```
 */
export function checkContractRevisionCompatibility(
  connectedRevision: unknown,
  supportedRange: SupportedContractRevisionRange = SDK_SUPPORTED_CONTRACT_REVISION_RANGE
): ContractCompatibilityWarning {
  assertValidRange(supportedRange);

  const revision =
    typeof connectedRevision === "number"
      ? connectedRevision
      : typeof connectedRevision === "bigint"
        ? Number(connectedRevision)
        : typeof connectedRevision === "string" && connectedRevision.trim() !== ""
          ? Number(connectedRevision)
          : NaN;

  if (!Number.isFinite(revision) || !Number.isInteger(revision) || revision < 0) {
    return {
      status: "unknown",
      compatible: false,
      code: "CONTRACT_REVISION_UNREADABLE",
      message:
        "The connected contract's revision could not be determined, so compatibility could not be verified. Proceed with caution or confirm the deployed contract revision manually.",
      supportedRange,
    };
  }

  if (revision < supportedRange.min) {
    return {
      status: "outdated",
      compatible: false,
      code: "CONTRACT_REVISION_OUTDATED",
      message: `The connected contract revision (${revision}) is older than this SDK version supports (revisions ${supportedRange.min}-${supportedRange.max}). Upgrade the deployed contract, or use an SDK version that supports revision ${revision}.`,
      connectedRevision: revision,
      supportedRange,
    };
  }

  if (revision > supportedRange.max) {
    return {
      status: "ahead",
      compatible: false,
      code: "CONTRACT_REVISION_AHEAD",
      message: `The connected contract revision (${revision}) is newer than this SDK version supports (revisions ${supportedRange.min}-${supportedRange.max}). Upgrade the SDK, or connect to a contract deployment within the supported range.`,
      connectedRevision: revision,
      supportedRange,
    };
  }

  return {
    status: "compatible",
    compatible: true,
    code: "CONTRACT_REVISION_COMPATIBLE",
    message: `The connected contract revision (${revision}) is within this SDK version's supported range (${supportedRange.min}-${supportedRange.max}).`,
    connectedRevision: revision,
    supportedRange,
  };
}
