import { ZkPayrollError, ErrorContext } from "../core/errors";

/** Stable error codes raised while building or signing a payroll instruction. */
export const PayrollInstructionErrorCode = {
  EMPTY_INSTRUCTION: "PAYROLL_INSTRUCTION_EMPTY",
  VALIDATION_FAILED: "PAYROLL_INSTRUCTION_VALIDATION_FAILED",
  SIGNER_UNAVAILABLE: "PAYROLL_INSTRUCTION_SIGNER_UNAVAILABLE",
  SIGNING_FAILED: "PAYROLL_INSTRUCTION_SIGNING_FAILED",
} as const;

export type PayrollInstructionErrorCodeType =
  (typeof PayrollInstructionErrorCode)[keyof typeof PayrollInstructionErrorCode];

/**
 * Thrown when a payroll instruction cannot be built or signed.
 *
 * Messages never interpolate recipient addresses, amounts, or other payroll
 * values — only stable codes, entry indices, and field names.
 */
export class PayrollInstructionError extends ZkPayrollError {
  constructor(
    message: string,
    code: PayrollInstructionErrorCodeType = PayrollInstructionErrorCode.VALIDATION_FAILED,
    context: ErrorContext = {},
    cause?: unknown
  ) {
    super(message, code, context, cause);
    this.name = "PayrollInstructionError";
  }
}
