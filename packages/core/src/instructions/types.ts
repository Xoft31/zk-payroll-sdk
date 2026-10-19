import type { PayrollRequest } from "../request/types";

/**
 * Minimal signing contract required by {@link SignedPayrollInstructionBuilder}.
 *
 * Decoupled from `ISigner` (which signs a Stellar `Transaction`) so that a
 * signed instruction can be produced *before* a transaction is assembled —
 * e.g. for off-chain approval records, audit trails, or multi-step review
 * flows. Any signer capable of producing a raw Ed25519 signature over an
 * opaque byte payload can be adapted to this interface.
 */
export interface PayrollInstructionSigner {
  /** Returns the Stellar public key (G...) identifying the signer. */
  getPublicKey(): Promise<string>;

  /**
   * Signs the exact bytes handed to it and returns the raw signature bytes.
   * Implementations must not mutate or reinterpret `payload`.
   */
  signPayload(payload: Uint8Array): Promise<Uint8Array>;
}

/** Stable state values for a payroll instruction across its lifecycle. */
export type PayrollInstructionState = "unsigned" | "signed";

/**
 * A payroll instruction that has been deterministically serialized, hashed,
 * and signed by a single authorizing key.
 *
 * `payloadHash` is a SHA-256 digest over the exact bytes produced by
 * `encodePayrollRequest(request)`; `signature` is computed over those same
 * bytes. Both are safe to log and persist — neither reveals recipient
 * addresses or amounts, and recomputing `payloadHash` from `request` detects
 * any post-signature tampering.
 */
export interface SignedPayrollInstruction {
  /** The payroll request that was signed. */
  request: PayrollRequest;
  /** Hex-encoded SHA-256 digest of the canonical encoded request bytes. */
  payloadHash: string;
  /** Stellar public key (G...) of the signer. */
  signerPublicKey: string;
  /** Hex-encoded raw Ed25519 signature over the encoded request bytes. */
  signature: string;
  /** ISO-8601 timestamp recorded when the signature was produced. */
  signedAt: string;
  state: "signed";
}

/** Result of {@link verifySignedPayrollInstruction}. */
export interface PayrollInstructionVerificationResult {
  ok: boolean;
  /** Stable, non-sensitive reason code when `ok` is `false`. */
  code?: PayrollInstructionVerificationCode;
  /** Sanitized, actionable message — never echoes payroll values. */
  message?: string;
}

export type PayrollInstructionVerificationCode =
  "PAYLOAD_HASH_MISMATCH" | "SIGNATURE_INVALID" | "SIGNER_PUBLIC_KEY_INVALID";
