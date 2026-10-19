import { Keypair } from "@stellar/stellar-sdk";
import {
  SignedPayrollInstructionBuilder,
  KeypairInstructionSigner,
  verifySignedPayrollInstruction,
  describeSignedPayrollInstruction,
  PayrollInstructionError,
  PayrollInstructionErrorCode,
  type PayrollInstructionSigner,
} from "../src";

const entry = (
  overrides: Partial<{ recipient: string; amount: bigint; asset: string }> = {}
): { recipient: string; amount: bigint; asset: string } => ({
  recipient: "GABC1234567890",
  amount: 1000n,
  asset: "native",
  ...overrides,
});

describe("SignedPayrollInstructionBuilder", () => {
  let signer: KeypairInstructionSigner;
  let keypair: Keypair;

  beforeEach(() => {
    keypair = Keypair.random();
    signer = new KeypairInstructionSigner(keypair);
  });

  it("builds, signs, and verifies a valid instruction (main path)", async () => {
    const builder = new SignedPayrollInstructionBuilder()
      .add(entry())
      .add(entry({ recipient: "GDEF0987654321", amount: 2000n }))
      .withContext({ network: "testnet", contractId: "CABC..." });

    const instruction = await builder.sign(signer);

    expect(instruction.state).toBe("signed");
    expect(instruction.signerPublicKey).toBe(keypair.publicKey());
    expect(instruction.signature).toMatch(/^[0-9a-f]+$/);
    expect(instruction.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(instruction.request.entries).toHaveLength(2);

    const result = await verifySignedPayrollInstruction(instruction);
    expect(result.ok).toBe(true);
  });

  it("produces the same payload hash for identical instructions and a different hash for different entries", async () => {
    const a = await new SignedPayrollInstructionBuilder()
      .add(entry())
      .sign(new KeypairInstructionSigner(keypair));
    const b = await new SignedPayrollInstructionBuilder()
      .add(entry())
      .sign(new KeypairInstructionSigner(keypair));
    const c = await new SignedPayrollInstructionBuilder()
      .add(entry({ amount: 5000n }))
      .sign(new KeypairInstructionSigner(keypair));

    // Idempotency keys embed randomness-free deterministic derivation, so
    // identical entries + context should reproduce the same payload hash.
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.payloadHash).not.toBe(c.payloadHash);
  });

  it("detects tampering with the request after signing (integrity failure)", async () => {
    const instruction = await new SignedPayrollInstructionBuilder().add(entry()).sign(signer);

    const tampered = {
      ...instruction,
      request: {
        ...instruction.request,
        entries: [{ ...instruction.request.entries[0], amount: 999999n }],
      },
    };

    const result = await verifySignedPayrollInstruction(tampered);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("PAYLOAD_HASH_MISMATCH");
  });

  it("detects a signature that does not match the signer (authenticity failure)", async () => {
    const instruction = await new SignedPayrollInstructionBuilder().add(entry()).sign(signer);

    const otherSigner = new KeypairInstructionSigner(Keypair.random());
    const forgedInstruction = await new SignedPayrollInstructionBuilder()
      .add(entry())
      .sign(otherSigner);

    const mixed = { ...instruction, signature: forgedInstruction.signature };
    const result = await verifySignedPayrollInstruction(mixed);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SIGNATURE_INVALID");
  });

  it("rejects an instruction with a malformed signer public key", async () => {
    const instruction = await new SignedPayrollInstructionBuilder().add(entry()).sign(signer);
    const result = await verifySignedPayrollInstruction({
      ...instruction,
      signerPublicKey: "not-a-valid-key",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SIGNER_PUBLIC_KEY_INVALID");
  });

  it("throws PayrollInstructionError for an empty instruction (edge case)", async () => {
    const builder = new SignedPayrollInstructionBuilder();
    await expect(builder.sign(signer)).rejects.toMatchObject({
      code: PayrollInstructionErrorCode.EMPTY_INSTRUCTION,
    });
  });

  it("throws PayrollInstructionError for invalid entries without echoing payroll values", async () => {
    const builder = new SignedPayrollInstructionBuilder().add(entry({ amount: -1n }));
    await expect(builder.sign(signer)).rejects.toThrow(PayrollInstructionError);

    try {
      await builder.sign(signer);
      fail("expected sign() to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("GABC1234567890");
      expect(message).not.toContain("-1");
    }
  });

  it("wraps signer failures without leaking payload details", async () => {
    const failingSigner: PayrollInstructionSigner = {
      getPublicKey: async () => keypair.publicKey(),
      signPayload: async () => {
        throw new Error("hardware wallet unavailable");
      },
    };

    const builder = new SignedPayrollInstructionBuilder().add(entry());
    await expect(builder.sign(failingSigner)).rejects.toMatchObject({
      code: PayrollInstructionErrorCode.SIGNING_FAILED,
    });
  });

  it("requires a signer implementing getPublicKey/signPayload", async () => {
    const builder = new SignedPayrollInstructionBuilder().add(entry());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(builder.sign({} as any)).rejects.toMatchObject({
      code: PayrollInstructionErrorCode.SIGNER_UNAVAILABLE,
    });
  });

  it("buildUnsigned() returns the same payload hash sign() later produces", async () => {
    const builder = new SignedPayrollInstructionBuilder().add(entry());
    const unsigned = await builder.buildUnsigned();
    const signed = await builder.sign(signer);
    expect(unsigned.payloadHash).toBe(signed.payloadHash);
  });

  it("describeSignedPayrollInstruction never exposes recipient or amount values", async () => {
    const instruction = await new SignedPayrollInstructionBuilder()
      .add(entry())
      .withContext({ network: "testnet" })
      .sign(signer);

    const description = describeSignedPayrollInstruction(instruction);
    const serialized = JSON.stringify(description);

    expect(serialized).not.toContain("GABC1234567890");
    expect(serialized).not.toContain("1000");
    expect(description.entryCount).toBe(1);
    expect(description.network).toBe("testnet");
    expect(description.signerPublicKey).not.toBe(keypair.publicKey());
    expect(description.signerPublicKey.startsWith(keypair.publicKey().slice(0, 5))).toBe(true);
  });
});
