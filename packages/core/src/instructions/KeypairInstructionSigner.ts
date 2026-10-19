import { Keypair } from "@stellar/stellar-sdk";
import type { PayrollInstructionSigner } from "./types";

/**
 * {@link PayrollInstructionSigner} backed by a Stellar SDK `Keypair`.
 *
 * Intended for backend / server-side use where the secret key is available
 * as a `Keypair` instance. Mirrors `KeypairSigner` (for `Transaction`
 * signing) but signs an arbitrary payload directly, without requiring a
 * Stellar transaction envelope.
 *
 * @example
 * ```ts
 * const signer = new KeypairInstructionSigner(Keypair.fromSecret("S…"));
 * const instruction = await builder.sign(signer);
 * ```
 */
export class KeypairInstructionSigner implements PayrollInstructionSigner {
  constructor(private readonly keypair: Keypair) {}

  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  async signPayload(payload: Uint8Array): Promise<Uint8Array> {
    return this.keypair.sign(Buffer.from(payload));
  }
}
