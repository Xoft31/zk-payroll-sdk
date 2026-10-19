/**
 * Transaction Fee Ceiling Validator
 *
 * Gates an estimated transaction fee against a configured ceiling before a
 * payroll transaction is signed or submitted — the fee-estimation workflow
 * that already runs pre-flight via `PayrollContractWrapper.estimatePrivatePayFee`.
 *
 * ## Why This Matters
 * A runaway Soroban resource fee (large batch, cold footprint, congestion)
 * silently drains the employer's balance. Checking the estimate against an
 * explicit ceiling turns that into a typed, actionable failure *before* any
 * signature or broadcast.
 *
 * ## Privacy & Security Guarantees
 * Results and messages contain fee figures (stroops) and operation labels only
 * — never recipient addresses, payroll amounts, proofs, or other sensitive
 * payroll values — so they are safe to log, persist, and render in dashboards.
 * Validation returns an explicit discriminated result and never throws unless
 * {@link assertFeeWithinCeiling} is called.
 */

/** Stable machine-readable codes emitted by the fee ceiling validator. */
export const FeeCeilingErrorCode = {
  FEE_REQUIRED: "TRANSACTION_FEE_REQUIRED",
  FEE_INVALID: "TRANSACTION_FEE_INVALID",
  FEE_NEGATIVE: "TRANSACTION_FEE_NEGATIVE",
  CEILING_REQUIRED: "FEE_CEILING_REQUIRED",
  CEILING_INVALID: "FEE_CEILING_INVALID",
  WARN_BAND_INVALID: "FEE_CEILING_WARN_BAND_INVALID",
  FEE_EXCEEDS_CEILING: "TRANSACTION_FEE_EXCEEDS_CEILING",
} as const;

export type FeeCeilingErrorCode = (typeof FeeCeilingErrorCode)[keyof typeof FeeCeilingErrorCode];

/** Operational state of a fee relative to its ceiling. */
export type FeeCeilingOperationalState =
  "within_ceiling" | "approaching_ceiling" | "exceeds_ceiling" | "invalid";

/** Explicit validation result — never throws, never echoes payroll values. */
export type FeeCeilingValidation =
  | {
      ok: true;
      state: "within_ceiling" | "approaching_ceiling";
      /** Validated fee in stroops. */
      fee: bigint;
      /** Validated ceiling in stroops. */
      ceiling: bigint;
      /** Remaining headroom before the ceiling, in stroops (`ceiling - fee`). */
      headroom: bigint;
      /** Fee as a basis-point fraction of the ceiling (10000 = at the ceiling). */
      utilizationBps: number;
      /** Sanitized warning present when `state` is `"approaching_ceiling"`. */
      warning?: string;
    }
  | {
      ok: false;
      state: "exceeds_ceiling" | "invalid";
      /** Stable machine-readable failure code. */
      code: FeeCeilingErrorCode;
      /** Sanitized, actionable message — fee figures only, no payroll values. */
      message: string;
    };

/** Options for {@link validateFeeCeiling}. */
export interface FeeCeilingValidationOptions {
  /**
   * Fraction of the ceiling at which a passing fee is reported as
   * `"approaching_ceiling"`, in basis points (default 8000 = 80%).
   * Use `0` to disable the approaching state.
   */
  warnBps?: number;
  /** Operation label used in messages (e.g. `"private_pay"`). Never payroll data. */
  label?: string;
}

/** Default share of the ceiling that triggers the approaching warning (80%). */
export const DEFAULT_FEE_CEILING_WARN_BPS = 8_000;

/** Basis points in a whole (10000 bps = 100%). */
const BPS_DENOMINATOR = 10_000;

/** Thrown by {@link assertFeeWithinCeiling}; carries fee figures only. */
export class TransactionFeeCeilingError extends Error {
  readonly code: FeeCeilingErrorCode;
  readonly state: FeeCeilingOperationalState;
  /** Fee that breached the ceiling, in stroops (undefined when invalid input). */
  readonly fee?: bigint;
  /** Configured ceiling in stroops (undefined when invalid input). */
  readonly ceiling?: bigint;

  constructor(
    failure: Extract<FeeCeilingValidation, { ok: false }>,
    fee?: bigint,
    ceiling?: bigint
  ) {
    super(failure.message);
    this.name = "TransactionFeeCeilingError";
    this.code = failure.code;
    this.state = failure.state;
    this.fee = fee;
    this.ceiling = ceiling;
  }
}

type StroopParse = { ok: true; value: bigint } | { ok: false; reason: "missing" | "invalid" };

/**
 * Parse a fee or ceiling expressed in stroops.
 * Accepts bigints, integer numbers, and integer strings (e.g. `"1467"`).
 * Fractional values are rejected: stroops are indivisible.
 */
function parseStroops(raw: unknown): StroopParse {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: "missing" };
  }
  if (typeof raw === "bigint") {
    return { ok: true, value: raw };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, value: BigInt(raw) };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, value: BigInt(trimmed) };
  }
  return { ok: false, reason: "invalid" };
}

function failure(
  code: FeeCeilingErrorCode,
  state: "invalid" | "exceeds_ceiling",
  message: string
): Extract<FeeCeilingValidation, { ok: false }> {
  return { ok: false, code, state, message };
}

function scope(label?: string): string {
  return label && label.trim().length > 0 ? ` for ${label.trim()}` : "";
}

/**
 * Validate an estimated transaction fee against a configured ceiling.
 *
 * Privacy: results carry fee figures in stroops and an optional operation
 * label only — never recipients, payroll amounts, or proofs.
 *
 * @param fee - Estimated total fee (bigint, integer number, or integer string).
 * @param ceiling - Maximum permitted total fee in stroops.
 * @param options - Optional warning band and operation label.
 * @returns Explicit `FeeCeilingValidation` result — never throws.
 *
 * @example
 * ```typescript
 * const check = validateFeeCeiling(estimate.totalFee, 5_000n, { warnBps: 8_000 });
 * if (!check.ok) {
 *   console.error(check.code, check.message); // safe to log
 * }
 * ```
 */
export function validateFeeCeiling(
  fee: unknown,
  ceiling: unknown,
  options: FeeCeilingValidationOptions = {}
): FeeCeilingValidation {
  const { warnBps = DEFAULT_FEE_CEILING_WARN_BPS, label } = options;

  if (!Number.isInteger(warnBps) || warnBps < 0 || warnBps > BPS_DENOMINATOR) {
    return failure(
      FeeCeilingErrorCode.WARN_BAND_INVALID,
      "invalid",
      `warnBps must be an integer between 0 and ${BPS_DENOMINATOR}.`
    );
  }

  const parsedCeiling = parseStroops(ceiling);
  if (!parsedCeiling.ok) {
    return parsedCeiling.reason === "missing"
      ? failure(
          FeeCeilingErrorCode.CEILING_REQUIRED,
          "invalid",
          "A fee ceiling is required: configure the maximum total fee in stroops."
        )
      : failure(
          FeeCeilingErrorCode.CEILING_INVALID,
          "invalid",
          "Fee ceiling must be an integer number of stroops."
        );
  }
  if (parsedCeiling.value <= 0n) {
    return failure(
      FeeCeilingErrorCode.CEILING_INVALID,
      "invalid",
      "Fee ceiling must be a positive integer number of stroops."
    );
  }

  const parsedFee = parseStroops(fee);
  if (!parsedFee.ok) {
    return parsedFee.reason === "missing"
      ? failure(
          FeeCeilingErrorCode.FEE_REQUIRED,
          "invalid",
          "A transaction fee estimate is required for ceiling validation."
        )
      : failure(
          FeeCeilingErrorCode.FEE_INVALID,
          "invalid",
          "Transaction fee must be an integer number of stroops."
        );
  }
  if (parsedFee.value < 0n) {
    return failure(
      FeeCeilingErrorCode.FEE_NEGATIVE,
      "invalid",
      "Transaction fee must not be negative."
    );
  }

  const feeValue = parsedFee.value;
  const ceilingValue = parsedCeiling.value;
  const utilizationBps = Number((feeValue * BigInt(BPS_DENOMINATOR)) / ceilingValue);
  const headroom = ceilingValue - feeValue;

  if (feeValue > ceilingValue) {
    return failure(
      FeeCeilingErrorCode.FEE_EXCEEDS_CEILING,
      "exceeds_ceiling",
      `Estimated transaction fee of ${feeValue} stroops exceeds the configured ceiling of ${ceilingValue} stroops by ${
        feeValue - ceilingValue
      } stroops${scope(label)}. Raise the ceiling or reduce the transaction's resource usage before signing.`
    );
  }

  const approaching = warnBps > 0 && utilizationBps >= warnBps;
  const percent = Math.round((utilizationBps / 100) * 100) / 100;

  return {
    ok: true,
    state: approaching ? "approaching_ceiling" : "within_ceiling",
    fee: feeValue,
    ceiling: ceilingValue,
    headroom,
    utilizationBps,
    warning: approaching
      ? `Estimated transaction fee is at ${percent}% of the configured ceiling${scope(
          label
        )} (${feeValue} of ${ceilingValue} stroops).`
      : undefined,
  };
}

/**
 * Assert that an estimated transaction fee fits within its ceiling.
 * Throws {@link TransactionFeeCeilingError} (sanitized message) otherwise.
 *
 * A `undefined` ceiling is treated as "no ceiling configured" and passes, so
 * callers can forward an optional option straight through.
 *
 * @param fee - Estimated total fee in stroops.
 * @param ceiling - Maximum permitted total fee in stroops, or `undefined`.
 * @param options - Optional warning band and operation label.
 */
export function assertFeeWithinCeiling(
  fee: unknown,
  ceiling: unknown,
  options: FeeCeilingValidationOptions = {}
): void {
  if (ceiling === undefined || ceiling === null) {
    return;
  }
  const result = validateFeeCeiling(fee, ceiling, options);
  if (!result.ok) {
    throw new TransactionFeeCeilingError(
      result,
      typeof fee === "bigint" ? fee : undefined,
      typeof ceiling === "bigint" ? ceiling : undefined
    );
  }
}

/**
 * Validate a fee estimate object (e.g. {@link TransactionFeeEstimate}) against
 * a ceiling. Malformed estimates are reported instead of throwing.
 *
 * @param estimate - Candidate estimate; must expose a numeric `totalFee`.
 * @param ceiling - Maximum permitted total fee in stroops.
 * @param options - Optional warning band and operation label.
 */
export function validateTransactionFeeCeiling(
  estimate: unknown,
  ceiling: unknown,
  options: FeeCeilingValidationOptions = {}
): FeeCeilingValidation {
  if (typeof estimate !== "object" || estimate === null || Array.isArray(estimate)) {
    return failure(
      FeeCeilingErrorCode.FEE_REQUIRED,
      "invalid",
      "Fee estimate must be an object exposing a totalFee in stroops."
    );
  }
  const totalFee = (estimate as { totalFee?: unknown }).totalFee;
  if (totalFee === undefined || totalFee === null) {
    return failure(
      FeeCeilingErrorCode.FEE_REQUIRED,
      "invalid",
      "Fee estimate must expose a totalFee in stroops."
    );
  }
  return validateFeeCeiling(totalFee, ceiling, options);
}

/**
 * Quick boolean check: does the fee fit within the ceiling?
 * Invalid inputs (including a missing ceiling) report `false`.
 *
 * @param fee - Estimated total fee in stroops.
 * @param ceiling - Maximum permitted total fee in stroops.
 */
export function isFeeWithinCeiling(fee: unknown, ceiling: unknown): boolean {
  const result = validateFeeCeiling(fee, ceiling);
  return result.ok;
}
