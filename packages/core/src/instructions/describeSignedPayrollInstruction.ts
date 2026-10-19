import type { SignedPayrollInstruction } from "./types";

/** Privacy-safe view of a signed payroll instruction for logs, UI, and audit trails. */
export interface SignedPayrollInstructionDescription {
  entryCount: number;
  network?: string;
  contractId?: string;
  /** Truncated `G...XXXX` form of the signer's public key. */
  signerPublicKey: string;
  payloadHash: string;
  signedAt: string;
}

function truncateAddress(address: string): string {
  if (!address || address.length <= 10) return address || "unknown";
  return `${address.slice(0, 5)}...${address.slice(-4)}`;
}

/**
 * Produces a redacted, display-safe summary of a signed payroll instruction —
 * no recipient addresses, amounts, assets, or employee identifiers, only
 * counts and non-sensitive metadata. Safe to log, render in dashboards, or
 * attach to notifications.
 */
export function describeSignedPayrollInstruction(
  instruction: SignedPayrollInstruction
): SignedPayrollInstructionDescription {
  return {
    entryCount: instruction.request.entries.length,
    network: instruction.request.context.network,
    contractId: instruction.request.context.contractId,
    signerPublicKey: truncateAddress(instruction.signerPublicKey),
    payloadHash: instruction.payloadHash,
    signedAt: instruction.signedAt,
  };
}
