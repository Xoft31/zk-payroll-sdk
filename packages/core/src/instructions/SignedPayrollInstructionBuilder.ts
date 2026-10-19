import { PayrollRequestBuilder } from "../request/PayrollRequestBuilder";
import type {
  PayrollRequest,
  PayrollRequestEntry,
  PayrollRequestValidationReport,
  SubmissionContext,
} from "../request/types";
import { encodePayrollRequest } from "../serialization/payrollCommandSerialization";
import { SerializationError } from "../serialization/errors";
import { sha256Digest } from "../crypto/hashUtils";
import { PayrollInstructionError, PayrollInstructionErrorCode } from "./errors";
import type { PayrollInstructionSigner, SignedPayrollInstruction } from "./types";

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/** An encoded, hashed — but not yet signed — payroll instruction. */
export interface UnsignedPayrollInstruction {
  request: PayrollRequest;
  /** Canonical encoded bytes (`encodePayrollRequest(request)`); sign over these. */
  payload: Uint8Array;
  /** Hex-encoded SHA-256 digest of `payload`. */
  payloadHash: string;
}

/**
 * Builds and signs a payroll instruction — a deterministically-serialized,
 * hashed, and (once `sign()` is called) cryptographically-signed record of a
 * payroll request — before it is submitted for execution.
 *
 * A signed instruction is a portable authorization artifact: it can be
 * persisted, transmitted to an approver, or attached to an audit trail
 * independently of transaction assembly and submission. Composes
 * {@link PayrollRequestBuilder} for entry validation and
 * `encodePayrollRequest` for canonical, version-tagged serialization, so a
 * signed instruction always signs over the exact bytes the contract-facing
 * encoder would produce.
 *
 * Validation and hashing never throw on missing signer material — only
 * `sign()` requires a {@link PayrollInstructionSigner}. `buildUnsigned()` can
 * be used standalone to preview the payload before a signer is available.
 *
 * @example
 * ```ts
 * const builder = new SignedPayrollInstructionBuilder()
 *   .add({ recipient: "GABC...", amount: 1000n, asset: "native" })
 *   .withContext({ network: "testnet", contractId: "CABC..." });
 *
 * const instruction = await builder.sign(signer);
 * // instruction.signature, instruction.payloadHash are safe to log
 *
 * const check = await verifySignedPayrollInstruction(instruction);
 * if (!check.ok) throw new Error(check.message);
 * ```
 */
export class SignedPayrollInstructionBuilder {
  private readonly requestBuilder = new PayrollRequestBuilder();

  /** Appends a single payment entry. */
  add(entry: PayrollRequestEntry): this {
    this.requestBuilder.add(entry);
    return this;
  }

  /** Appends multiple payment entries. */
  addMany(entries: PayrollRequestEntry[]): this {
    this.requestBuilder.addMany(entries);
    return this;
  }

  /** Sets or replaces the submission context (network, contractId, nonce). */
  withContext(context: SubmissionContext): this {
    this.requestBuilder.withContext(context);
    return this;
  }

  /** Validates the current entries without building or signing. */
  validate(): PayrollRequestValidationReport {
    return this.requestBuilder.validate();
  }

  /** Number of entries currently in the builder. */
  get size(): number {
    return this.requestBuilder.size;
  }

  /**
   * Builds the underlying request, encodes it, and computes its digest —
   * without signing. Useful for previewing the exact bytes/hash a signer
   * will be asked to sign.
   *
   * @throws {PayrollInstructionError} when validation fails or the request
   *   cannot be encoded. Never echoes recipient, amount, or asset values.
   */
  async buildUnsigned(): Promise<UnsignedPayrollInstruction> {
    if (this.requestBuilder.size === 0) {
      throw new PayrollInstructionError(
        "Cannot build a payroll instruction with no entries.",
        PayrollInstructionErrorCode.EMPTY_INSTRUCTION
      );
    }

    const { errors, isValid } = this.requestBuilder.validate();
    if (!isValid) {
      throw new PayrollInstructionError(
        `Payroll instruction validation failed: ${errors.map((e) => `${e.field}(${e.code})@${e.index}`).join(", ")}`,
        PayrollInstructionErrorCode.VALIDATION_FAILED
      );
    }

    const request = this.requestBuilder.build();

    let payload: Uint8Array;
    try {
      payload = encodePayrollRequest(request);
    } catch (err) {
      const code =
        err instanceof SerializationError
          ? err.code
          : PayrollInstructionErrorCode.VALIDATION_FAILED;
      throw new PayrollInstructionError(
        "Payroll instruction could not be encoded for signing.",
        PayrollInstructionErrorCode.VALIDATION_FAILED,
        { encodeErrorCode: code },
        err
      );
    }

    const payloadHash = await sha256Digest(payload);
    return { request, payload, payloadHash };
  }

  /**
   * Builds, encodes, and signs the payroll instruction with `signer`.
   *
   * The signature covers the exact canonical bytes returned by
   * `encodePayrollRequest(request)`; verify with
   * {@link verifySignedPayrollInstruction}.
   *
   * @throws {PayrollInstructionError} when validation/encoding fails, no
   *   signer is provided, or the signer rejects/fails to sign. The signer's
   *   underlying error is preserved as `cause` but never interpolated into
   *   the message.
   */
  async sign(signer: PayrollInstructionSigner): Promise<SignedPayrollInstruction> {
    if (
      !signer ||
      typeof signer.signPayload !== "function" ||
      typeof signer.getPublicKey !== "function"
    ) {
      throw new PayrollInstructionError(
        "A PayrollInstructionSigner with getPublicKey() and signPayload() is required.",
        PayrollInstructionErrorCode.SIGNER_UNAVAILABLE
      );
    }

    const { request, payload, payloadHash } = await this.buildUnsigned();

    let signature: Uint8Array;
    let signerPublicKey: string;
    try {
      signerPublicKey = await signer.getPublicKey();
      signature = await signer.signPayload(payload);
    } catch (err) {
      throw new PayrollInstructionError(
        "Signer failed to produce a signature for the payroll instruction.",
        PayrollInstructionErrorCode.SIGNING_FAILED,
        {},
        err
      );
    }

    if (!signerPublicKey || typeof signerPublicKey !== "string") {
      throw new PayrollInstructionError(
        "Signer returned an invalid public key.",
        PayrollInstructionErrorCode.SIGNING_FAILED
      );
    }
    if (!(signature instanceof Uint8Array) || signature.length === 0) {
      throw new PayrollInstructionError(
        "Signer returned an empty or invalid signature.",
        PayrollInstructionErrorCode.SIGNING_FAILED
      );
    }

    return {
      request,
      payloadHash,
      signerPublicKey,
      signature: bytesToHex(signature),
      signedAt: new Date().toISOString(),
      state: "signed",
    };
  }
}

export { bytesToHex };
