/** Compatibility of a connected contract's revision against this SDK's supported range. */
export type ContractCompatibilityStatus = "compatible" | "outdated" | "ahead" | "unknown";

/** Stable, machine-readable reason codes for a compatibility warning. */
export type ContractCompatibilityCode =
  | "CONTRACT_REVISION_COMPATIBLE"
  | "CONTRACT_REVISION_OUTDATED"
  | "CONTRACT_REVISION_AHEAD"
  | "CONTRACT_REVISION_UNREADABLE"
  | "CONTRACT_REVISION_UNSUPPORTED_METHOD";

/**
 * Inclusive range of contract revisions this SDK version has been built and
 * tested against. Bump `min`/`max` when the SDK adds or drops support for a
 * deployed contract revision.
 */
export interface SupportedContractRevisionRange {
  /** Lowest contract revision this SDK version supports (inclusive). */
  min: number;
  /** Highest contract revision this SDK version supports (inclusive). */
  max: number;
}

/**
 * Result of comparing a connected contract's revision against this SDK's
 * supported range. Never contains recipient, amount, or other payroll
 * values — only revision numbers, which are not sensitive.
 */
export interface ContractCompatibilityWarning {
  status: ContractCompatibilityStatus;
  /** `true` only when `status` is `"compatible"`. */
  compatible: boolean;
  code: ContractCompatibilityCode;
  /** Actionable, human-readable guidance. Safe to log or display. */
  message: string;
  /** The connected contract's revision, when it could be determined. */
  connectedRevision?: number;
  /** The range this SDK version was checked against. */
  supportedRange: SupportedContractRevisionRange;
}
