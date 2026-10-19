import { Keypair } from "@stellar/stellar-sdk";
import { encodePayrollRequest } from "../serialization/payrollCommandSerialization";
import { SerializationError } from "../serialization/errors";
import { sha256Digest } from "../crypto/hashUtils";
import type { PayrollInstructionVerificationResult, SignedPayrollInstruction } from "./types";

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    return new Uint8Array(0);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Verifies a {@link SignedPayrollInstruction} produced by
 * {@link SignedPayrollInstructionBuilder.sign}.
 *
 * Two independent checks are performed:
 * 1. **Integrity** — `payloadHash` must match the SHA-256 digest of
 *    `encodePayrollRequest(instruction.request)`, detecting any tampering
 *    with the request after signing.
 * 2. **Authenticity** — `signature` must be a valid Ed25519 signature over
 *    the re-encoded bytes, produced by `signerPublicKey`.
 *
 * Never throws for malformed instructions or invalid signatures — always
 * returns a result with a stable code so callers can branch without a
 * try/catch, and the result never echoes recipient, amount, or asset values.
 */
export async function verifySignedPayrollInstruction(
  instruction: SignedPayrollInstruction
): Promise<PayrollInstructionVerificationResult> {
  let payload: Uint8Array;
  try {
    payload = encodePayrollRequest(instruction.request);
  } catch (err) {
    const code = err instanceof SerializationError ? err.code : "SERIALIZATION_FAILED";
    return {
      ok: false,
      code: "PAYLOAD_HASH_MISMATCH",
      message: `Payroll instruction request could not be re-encoded for verification (${code}).`,
    };
  }

  const recomputedHash = await sha256Digest(payload);
  if (recomputedHash !== instruction.payloadHash) {
    return {
      ok: false,
      code: "PAYLOAD_HASH_MISMATCH",
      message: "Payroll instruction payload hash does not match the request contents.",
    };
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(instruction.signerPublicKey);
  } catch {
    return {
      ok: false,
      code: "SIGNER_PUBLIC_KEY_INVALID",
      message: "Payroll instruction signer public key is not a valid Stellar address.",
    };
  }

  const signatureBytes = hexToBytes(instruction.signature);
  if (signatureBytes.length === 0) {
    return {
      ok: false,
      code: "SIGNATURE_INVALID",
      message: "Payroll instruction signature is malformed.",
    };
  }

  const isValid = keypair.verify(Buffer.from(payload), Buffer.from(signatureBytes));
  if (!isValid) {
    return {
      ok: false,
      code: "SIGNATURE_INVALID",
      message: "Payroll instruction signature does not match the signed payload and signer.",
    };
  }

  return { ok: true };
}
