import { validatePayoutDestination, type PayoutDestinationValidation } from "./payoutDestination";

export type PayoutDestinationChangeReviewErrorCode =
  "CURRENT_DESTINATION_INVALID" | "PROPOSED_DESTINATION_INVALID" | "DESTINATION_UNCHANGED";

export type PayoutDestinationChangeWarning = "DESTINATION_TYPE_CHANGED";

export interface PayoutDestinationChangeReviewInput {
  currentDestination: unknown;
  proposedDestination: unknown;
}

export interface ReviewedPayoutDestination {
  /** Display-safe preview; the complete destination is deliberately omitted. */
  preview: string;
  kind: "account" | "muxed_account";
}

export type PayoutDestinationChangeReviewResult =
  | {
      ok: true;
      review: {
        current: ReviewedPayoutDestination;
        proposed: ReviewedPayoutDestination;
        risk: "standard" | "elevated";
        warnings: readonly PayoutDestinationChangeWarning[];
      };
    }
  | {
      ok: false;
      code: PayoutDestinationChangeReviewErrorCode;
      message: string;
      /** Underlying validation code, useful for choosing a form field hint. */
      validationCode?: string;
    };

function maskDestination(destination: string): string {
  return `${destination.slice(0, 6)}…${destination.slice(-4)}`;
}

function invalidResult(
  which: "current" | "proposed",
  validation: Extract<PayoutDestinationValidation, { ok: false }>
): PayoutDestinationChangeReviewResult {
  return {
    ok: false,
    code: which === "current" ? "CURRENT_DESTINATION_INVALID" : "PROPOSED_DESTINATION_INVALID",
    message:
      which === "current"
        ? "The current payout destination is invalid; refresh the employee record before review."
        : "The proposed payout destination is invalid; correct it before requesting review.",
    validationCode: validation.code,
  };
}

/**
 * Builds a privacy-safe review of an employee payout destination change.
 *
 * Both sides are validated before comparison, preventing malformed legacy data
 * from being silently replaced and ensuring an unchanged destination cannot be
 * submitted as an update. The result only contains masked previews, making it
 * suitable for approval screens and operational logs.
 */
export function reviewPayoutDestinationChange(
  input: PayoutDestinationChangeReviewInput
): PayoutDestinationChangeReviewResult {
  const current = validatePayoutDestination(input?.currentDestination);
  if (!current.ok) return invalidResult("current", current);

  const proposed = validatePayoutDestination(input?.proposedDestination);
  if (!proposed.ok) return invalidResult("proposed", proposed);

  if (current.destination === proposed.destination) {
    return {
      ok: false,
      code: "DESTINATION_UNCHANGED",
      message: "The proposed payout destination is already active; no change is required.",
    };
  }

  const typeChanged = current.kind !== proposed.kind;
  return {
    ok: true,
    review: {
      current: { preview: maskDestination(current.destination), kind: current.kind },
      proposed: { preview: maskDestination(proposed.destination), kind: proposed.kind },
      risk: typeChanged ? "elevated" : "standard",
      warnings: typeChanged ? ["DESTINATION_TYPE_CHANGED"] : [],
    },
  };
}
