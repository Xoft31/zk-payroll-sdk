/**
 * Withholding Configuration Validator
 *
 * Validates the tax / statutory withholding configuration attached to a payroll
 * run before it is applied to a batch (the payroll validation workflow).
 *
 * ## Why This Matters
 * A misconfigured withholding rule — an out-of-range rate, a missing fixed
 * amount, or a per-run cap smaller than the configured amount — silently
 * produces wrong net pay or failed submissions. Validating configuration up
 * front keeps payroll safer to run without exposing sensitive employee or
 * salary information.
 *
 * ## Privacy & Security Guarantees
 * - Employee identifiers are always redacted via {@link redactEmployeeId} in
 *   surfaced messages, so raw identifiers never reach logs or UI feedback.
 * - Configured amounts (which are derived from salary) are never echoed unless
 *   explicitly requested for internal debugging.
 * - Validation returns an explicit discriminated result and never throws unless
 *   {@link assertWithholdingConfig} is called.
 */

import { redactEmployeeId } from "./minimumAmount";
import { DEFAULT_ASSET_DECIMALS } from "../assets/decimals";

/** Stable machine-readable codes emitted by the withholding configuration validator. */
export const WithholdingConfigErrorCode = {
  CONFIG_REQUIRED: "WITHHOLDING_CONFIG_REQUIRED",
  METHOD_REQUIRED: "WITHHOLDING_METHOD_REQUIRED",
  METHOD_UNSUPPORTED: "WITHHOLDING_METHOD_UNSUPPORTED",
  RATE_REQUIRED: "WITHHOLDING_RATE_REQUIRED",
  RATE_INVALID: "WITHHOLDING_RATE_INVALID",
  RATE_OUT_OF_RANGE: "WITHHOLDING_RATE_OUT_OF_RANGE",
  AMOUNT_REQUIRED: "WITHHOLDING_AMOUNT_REQUIRED",
  AMOUNT_INVALID: "WITHHOLDING_AMOUNT_INVALID",
  AMOUNT_NEGATIVE: "WITHHOLDING_AMOUNT_NEGATIVE",
  AMOUNT_ZERO: "WITHHOLDING_AMOUNT_ZERO",
  AMOUNT_UNEXPECTED: "WITHHOLDING_AMOUNT_UNEXPECTED",
  CAP_INVALID: "WITHHOLDING_CAP_INVALID",
  CAP_EXCEEDED: "WITHHOLDING_CAP_EXCEEDED",
  ROUNDING_UNSUPPORTED: "WITHHOLDING_ROUNDING_UNSUPPORTED",
  JURISDICTION_INVALID: "WITHHOLDING_JURISDICTION_INVALID",
  EMPLOYEE_REQUIRED: "WITHHOLDING_EMPLOYEE_REQUIRED",
  EMPLOYEE_MISMATCH: "WITHHOLDING_EMPLOYEE_MISMATCH",
} as const;

export type WithholdingConfigErrorCode =
  (typeof WithholdingConfigErrorCode)[keyof typeof WithholdingConfigErrorCode];

/** How the withheld amount is derived from gross pay. */
export type WithholdingMethod = "percentage" | "fixed";

/** Rounding applied when a computed withholding amount is not integral. */
export type WithholdingRounding = "floor" | "ceil" | "nearest";

/** Operational state of a withholding configuration. */
export type WithholdingConfigOperationalState = "validated" | "invalid" | "malformed";

/** Raw withholding configuration as supplied by the host application. */
export interface WithholdingConfig {
  /** Employee reference the rule applies to; omit for an employer-wide default rule. */
  employeeId?: string;
  /** Derivation method — `"percentage"` of gross pay or a `"fixed"` amount. */
  method?: WithholdingMethod;
  /** Percentage rate in percent (`0 < rate <= 100`) for `method: "percentage"`. */
  rate?: number;
  /** Fixed withholding amount in base units for `method: "fixed"`. */
  amount?: bigint | string | number;
  /** Never withhold more than this per payroll run, in base units. */
  maxPerRun?: bigint | string | number;
  /** Rounding mode for computed amounts (defaults to `"nearest"`). */
  rounding?: WithholdingRounding;
  /** Optional jurisdiction / tax form label (e.g. `"US-FED-2026"`). */
  jurisdiction?: string;
}

/** Validated configuration in a normalized, ready-to-apply shape. */
export interface NormalizedWithholdingConfig {
  employeeId?: string;
  method: WithholdingMethod;
  /** Percentage rate, present for `method: "percentage"`. */
  rate?: number;
  /** Fixed amount in base units, present for `method: "fixed"`. */
  amount?: bigint;
  /** Per-run cap in base units, present when configured. */
  maxPerRun?: bigint;
  rounding: WithholdingRounding;
  jurisdiction?: string;
}

/** Explicit validation result — never throws, never echoes rejected values. */
export type WithholdingConfigValidation =
  | {
      ok: true;
      state: "validated";
      /** Normalized configuration ready to apply to a payroll run. */
      config: NormalizedWithholdingConfig;
      /** Redacted employee identifier safe for logs and UI (e.g. `emp***345`). */
      displayEmployeeId: string;
    }
  | {
      ok: false;
      /** Stable machine-readable failure code. */
      code: WithholdingConfigErrorCode;
      /** Sanitized, actionable message — identifiers and amounts are never included. */
      message: string;
      state: WithholdingConfigOperationalState;
    };

/** Options for {@link validateWithholdingConfig}. */
export interface WithholdingConfigValidationOptions {
  /**
   * Expected employee reference. When provided, `config.employeeId` must match;
   * mismatches are reported without echoing either identifier.
   */
  expectedEmployeeId?: string;
  /** Require an `employeeId` on every rule (useful for per-employee runs). */
  requireEmployeeId?: boolean;
  /** Policy ceiling for `rate` (exclusive upper bound is `maxRate`). Defaults to 100. */
  maxRate?: number;
  /** Permit a `0%` rate (e.g. exempt employees). Defaults to `false`. */
  allowZeroRate?: boolean;
  /** Permit a zero fixed amount. Defaults to `false`. */
  allowZeroAmount?: boolean;
  /**
   * Decimal precision used to parse `amount` / `maxPerRun` decimal strings.
   * Defaults to 7 (the SDK default asset precision).
   */
  decimals?: number;
  /** Include configured amounts in failure messages. Defaults to `false`. */
  includeAmounts?: boolean;
  /** Include the raw (unredacted) employee identifier in messages. Defaults to `false`. */
  includeEmployeeId?: boolean;
}

/** Thrown by {@link assertWithholdingConfig}; carries the sanitized message only. */
export class WithholdingConfigError extends Error {
  readonly code: WithholdingConfigErrorCode;
  readonly state: WithholdingConfigOperationalState;

  constructor(failure: Extract<WithholdingConfigValidation, { ok: false }>) {
    super(failure.message);
    this.name = "WithholdingConfigError";
    this.code = failure.code;
    this.state = failure.state;
  }
}

/** Default policy ceiling for a withholding rate (percent). */
export const MAX_WITHHOLDING_RATE = 100;

/** Default rounding applied to computed withholding amounts. */
export const DEFAULT_WITHHOLDING_ROUNDING: WithholdingRounding = "nearest";

const SUPPORTED_METHODS: readonly WithholdingMethod[] = ["percentage", "fixed"];
const SUPPORTED_ROUNDING: readonly WithholdingRounding[] = ["floor", "ceil", "nearest"];

/** Rate precision: at most 4 decimal places (e.g. `7.375` is valid). */
const MAX_RATE_DECIMAL_PLACES = 4;

/**
 * Parse an amount expressed in base units into a bigint.
 * Accepts bigints, integer numbers, and integer/decimal strings whose
 * fractional precision does not exceed `decimals`.
 */
function parseBaseUnitAmount(
  raw: unknown,
  decimals: number
): { ok: true; value: bigint } | { ok: false; reason: "invalid" | "negative" | "zero" } {
  if (typeof raw === "bigint") {
    if (raw < 0n) return { ok: false, reason: "negative" };
    if (raw === 0n) return { ok: false, reason: "zero" };
    return { ok: true, value: raw };
  }

  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, reason: "invalid" };
    if (!Number.isInteger(raw)) return { ok: false, reason: "invalid" };
    if (raw < 0) return { ok: false, reason: "negative" };
    if (raw === 0) return { ok: false, reason: "zero" };
    return { ok: true, value: BigInt(raw) };
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return { ok: false, reason: "invalid" };
    if (trimmed.startsWith("-")) return { ok: false, reason: "negative" };

    const [whole, fraction = ""] = trimmed.split(".");
    if (fraction.length > decimals) return { ok: false, reason: "invalid" };

    const scale = 10n ** BigInt(decimals);
    const value = BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0"));
    if (value === 0n) return { ok: false, reason: "zero" };
    return { ok: true, value };
  }

  return { ok: false, reason: "invalid" };
}

/** Format a base-unit amount for messages, honouring the redaction policy. */
function displayAmount(raw: unknown, includeAmounts: boolean): string {
  return includeAmounts ? String(raw) : "[REDACTED]";
}

/** Format an employee identifier for messages, honouring the redaction policy. */
function displayEmployeeId(employeeId: unknown, includeEmployeeId: boolean): string {
  if (includeEmployeeId && typeof employeeId === "string") return employeeId;
  return redactEmployeeId(typeof employeeId === "string" ? employeeId : undefined);
}

function failure(
  code: WithholdingConfigErrorCode,
  state: "invalid" | "malformed",
  message: string
): Extract<WithholdingConfigValidation, { ok: false }> {
  return { ok: false, code, state, message };
}

/**
 * Validate a withholding configuration before it is applied to a payroll run.
 *
 * Privacy: rejected employee identifiers and configured amounts are never
 * reflected in messages — only stable codes, sanitized text, and redacted
 * identifiers (e.g. `emp***345`) are surfaced.
 *
 * @param config - Untrusted withholding configuration candidate.
 * @param options - Optional policy (expected employee, rate ceiling, precision).
 * @returns Explicit `WithholdingConfigValidation` result — never throws.
 *
 * @example
 * ```typescript
 * const result = validateWithholdingConfig({ method: "percentage", rate: 12.5 });
 * if (!result.ok) {
 *   console.error(result.code, result.message); // safe to log
 * }
 * ```
 */
export function validateWithholdingConfig(
  config: unknown,
  options: WithholdingConfigValidationOptions = {}
): WithholdingConfigValidation {
  const {
    expectedEmployeeId,
    requireEmployeeId = false,
    maxRate = MAX_WITHHOLDING_RATE,
    allowZeroRate = false,
    allowZeroAmount = false,
    decimals = DEFAULT_ASSET_DECIMALS,
    includeAmounts = false,
    includeEmployeeId = false,
  } = options;

  // 1. Structural gate — must be an object describing one rule.
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return failure(
      WithholdingConfigErrorCode.CONFIG_REQUIRED,
      "malformed",
      "Withholding configuration must be an object with a method and its rate or amount."
    );
  }

  const candidate = config as WithholdingConfig;

  // 2. Employee reference — required by policy and/or matched against the run.
  const rawEmployeeId = candidate.employeeId;
  if (rawEmployeeId !== undefined && typeof rawEmployeeId !== "string") {
    return failure(
      WithholdingConfigErrorCode.EMPLOYEE_REQUIRED,
      "invalid",
      "Withholding configuration employee reference must be a string identifier."
    );
  }
  const employeeId = typeof rawEmployeeId === "string" ? rawEmployeeId.trim() : "";
  if (requireEmployeeId && employeeId.length === 0) {
    return failure(
      WithholdingConfigErrorCode.EMPLOYEE_REQUIRED,
      "invalid",
      "Withholding configuration requires an employee reference for this payroll run."
    );
  }
  if (expectedEmployeeId && employeeId !== expectedEmployeeId.trim()) {
    return failure(
      WithholdingConfigErrorCode.EMPLOYEE_MISMATCH,
      "invalid",
      "Withholding configuration targets a different employee than the payroll run expects."
    );
  }

  // 3. Method — the discriminator for every remaining check.
  const method = typeof candidate.method === "string" ? candidate.method.trim() : "";
  if (method.length === 0) {
    return failure(
      WithholdingConfigErrorCode.METHOD_REQUIRED,
      "invalid",
      'Withholding configuration requires a method of "percentage" or "fixed".'
    );
  }
  if (!SUPPORTED_METHODS.includes(method as WithholdingMethod)) {
    return failure(
      WithholdingConfigErrorCode.METHOD_UNSUPPORTED,
      "invalid",
      'Withholding method is not supported; use "percentage" or "fixed".'
    );
  }
  const normalizedMethod = method as WithholdingMethod;

  // 4. Rounding — optional, but must be a known mode when present.
  let rounding: WithholdingRounding = DEFAULT_WITHHOLDING_ROUNDING;
  if (candidate.rounding !== undefined) {
    if (
      typeof candidate.rounding !== "string" ||
      !SUPPORTED_ROUNDING.includes(candidate.rounding as WithholdingRounding)
    ) {
      return failure(
        WithholdingConfigErrorCode.ROUNDING_UNSUPPORTED,
        "invalid",
        'Withholding rounding must be one of "floor", "ceil", or "nearest".'
      );
    }
    rounding = candidate.rounding as WithholdingRounding;
  }

  // 5. Jurisdiction — optional label, must be a non-empty string when present.
  if (candidate.jurisdiction !== undefined) {
    if (typeof candidate.jurisdiction !== "string" || candidate.jurisdiction.trim().length === 0) {
      return failure(
        WithholdingConfigErrorCode.JURISDICTION_INVALID,
        "invalid",
        "Withholding jurisdiction label must be a non-empty string."
      );
    }
  }
  const jurisdiction =
    typeof candidate.jurisdiction === "string" ? candidate.jurisdiction.trim() : undefined;

  const common = {
    employeeId: employeeId.length > 0 ? employeeId : undefined,
    rounding,
    jurisdiction,
  };
  const employeeDisplay = displayEmployeeId(rawEmployeeId, includeEmployeeId);

  /** Validate the optional per-run cap and build the normalized fixed result. */
  function finalizeFixed(value: bigint): WithholdingConfigValidation {
    let maxPerRun: bigint | undefined;
    if (candidate.maxPerRun !== undefined && candidate.maxPerRun !== null) {
      const cap = parseBaseUnitAmount(candidate.maxPerRun, decimals);
      if (!cap.ok) {
        return failure(
          WithholdingConfigErrorCode.CAP_INVALID,
          "invalid",
          "Per-run withholding cap must be a positive integer number of base units."
        );
      }
      if (cap.value < value) {
        return failure(
          WithholdingConfigErrorCode.CAP_EXCEEDED,
          "invalid",
          `Configured withholding amount (${displayAmount(
            candidate.amount,
            includeAmounts
          )}) exceeds the per-run cap (${displayAmount(
            candidate.maxPerRun,
            includeAmounts
          )}); raise the cap or lower the amount.`
        );
      }
      maxPerRun = cap.value;
    }

    return {
      ok: true,
      state: "validated",
      displayEmployeeId: redactEmployeeId(employeeId.length > 0 ? employeeId : undefined),
      config: { ...common, method: normalizedMethod, amount: value, maxPerRun },
    };
  }

  // 6. Method-specific value checks.
  if (normalizedMethod === "percentage") {
    if (candidate.amount !== undefined) {
      return failure(
        WithholdingConfigErrorCode.AMOUNT_UNEXPECTED,
        "invalid",
        "A fixed withholding amount was provided for a percentage configuration; remove one of them."
      );
    }

    const rate = candidate.rate;
    if (rate === undefined || rate === null) {
      return failure(
        WithholdingConfigErrorCode.RATE_REQUIRED,
        "invalid",
        "Percentage withholding configuration requires a rate between 0 and 100."
      );
    }
    if (typeof rate !== "number" || !Number.isFinite(rate)) {
      return failure(
        WithholdingConfigErrorCode.RATE_INVALID,
        "invalid",
        "Withholding rate must be a finite number."
      );
    }
    const scaled = rate * 10 ** MAX_RATE_DECIMAL_PLACES;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
      return failure(
        WithholdingConfigErrorCode.RATE_INVALID,
        "invalid",
        `Withholding rate supports at most ${MAX_RATE_DECIMAL_PLACES} decimal places.`
      );
    }
    if (rate < 0 || rate === 0 || rate > maxRate) {
      const zeroAllowed = allowZeroRate && rate === 0;
      if (!zeroAllowed) {
        return failure(
          WithholdingConfigErrorCode.RATE_OUT_OF_RANGE,
          "invalid",
          rate === 0
            ? "Withholding rate of 0% is not permitted for this payroll run; use allowZeroRate for exempt employees."
            : `Withholding rate must be greater than 0 and at most ${maxRate}.`
        );
      }
    }

    return {
      ok: true,
      state: "validated",
      displayEmployeeId: redactEmployeeId(employeeId.length > 0 ? employeeId : undefined),
      config: { ...common, method: normalizedMethod, rate },
    };
  }

  // method === "fixed"
  if (candidate.rate !== undefined) {
    return failure(
      WithholdingConfigErrorCode.RATE_INVALID,
      "invalid",
      'A rate was provided for a fixed withholding configuration; remove it or switch the method to "percentage".'
    );
  }

  if (candidate.amount === undefined || candidate.amount === null) {
    return failure(
      WithholdingConfigErrorCode.AMOUNT_REQUIRED,
      "invalid",
      "Fixed withholding configuration requires an amount in base units."
    );
  }

  const amount = parseBaseUnitAmount(candidate.amount, decimals);
  if (!amount.ok) {
    if (amount.reason === "negative") {
      return failure(
        WithholdingConfigErrorCode.AMOUNT_NEGATIVE,
        "invalid",
        `A negative withholding amount is not permitted for employee ${employeeDisplay}.`
      );
    }
    if (amount.reason === "zero" && allowZeroAmount) {
      // Explicitly permitted by policy (e.g. a placeholder rule under review).
      return finalizeFixed(0n);
    }
    if (amount.reason === "zero") {
      return failure(
        WithholdingConfigErrorCode.AMOUNT_ZERO,
        "invalid",
        `A zero withholding amount is not permitted for employee ${employeeDisplay}; configure no rule instead.`
      );
    }
    return failure(
      WithholdingConfigErrorCode.AMOUNT_INVALID,
      "invalid",
      `Withholding amount must be an integer number of base units (or a decimal string with at most ${decimals} decimal places); received ${displayAmount(
        candidate.amount,
        includeAmounts
      )}.`
    );
  }

  return finalizeFixed(amount.value);
}

/**
 * Assert that a withholding configuration is valid.
 * Throws {@link WithholdingConfigError} with a sanitized message otherwise.
 *
 * @param config - Withholding configuration to validate.
 * @param options - Optional policy options.
 * @returns The normalized configuration.
 */
export function assertWithholdingConfig(
  config: unknown,
  options: WithholdingConfigValidationOptions = {}
): NormalizedWithholdingConfig {
  const result = validateWithholdingConfig(config, options);
  if (!result.ok) {
    throw new WithholdingConfigError(result);
  }
  return result.config;
}

/** Per-entry failure reported by {@link validateBatchWithholdingConfigs}. */
export interface WithholdingBatchValidationIssue {
  /** Index of the offending entry in the input array. */
  index: number;
  /** Stable machine-readable failure code. */
  code: WithholdingConfigErrorCode;
  /** Sanitized, actionable message. */
  message: string;
  state: WithholdingConfigOperationalState;
  /** Redacted employee identifier safe for logs and UI. */
  displayEmployeeId: string;
}

/** Aggregated result of validating a batch of withholding configurations. */
export interface WithholdingBatchValidationResult {
  /** True when every entry passed validation. */
  isValid: boolean;
  /** Issues for the entries that failed. */
  issues: WithholdingBatchValidationIssue[];
  summary: {
    totalEntries: number;
    validCount: number;
    invalidCount: number;
    malformedCount: number;
  };
}

/**
 * Validate an array of withholding configurations (e.g. one rule per employee).
 *
 * @param configs - Configurations to validate.
 * @param options - Policy options applied to every entry.
 * @returns Aggregated batch result with sanitized per-entry issues.
 */
export function validateBatchWithholdingConfigs(
  configs: unknown[],
  options: WithholdingConfigValidationOptions = {}
): WithholdingBatchValidationResult {
  const issues: WithholdingBatchValidationIssue[] = [];
  let malformedCount = 0;

  if (!Array.isArray(configs)) {
    return {
      isValid: false,
      issues: [
        {
          index: 0,
          code: WithholdingConfigErrorCode.CONFIG_REQUIRED,
          message: "Withholding configuration batch must be an array of configurations.",
          state: "malformed",
          displayEmployeeId: redactEmployeeId(undefined),
        },
      ],
      summary: { totalEntries: 0, validCount: 0, invalidCount: 1, malformedCount: 1 },
    };
  }

  configs.forEach((entry, index) => {
    const result = validateWithholdingConfig(entry, options);
    if (result.ok) return;
    if (result.state === "malformed") malformedCount++;
    issues.push({
      index,
      code: result.code,
      message: result.message,
      state: result.state,
      displayEmployeeId:
        typeof (entry as WithholdingConfig | null)?.employeeId === "string"
          ? redactEmployeeId((entry as WithholdingConfig).employeeId)
          : redactEmployeeId(undefined),
    });
  });

  const invalidCount = issues.length;
  return {
    isValid: invalidCount === 0,
    issues,
    summary: {
      totalEntries: configs.length,
      validCount: configs.length - invalidCount,
      invalidCount,
      malformedCount,
    },
  };
}
