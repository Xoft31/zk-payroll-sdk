/**
 * Tests for the Transaction Fee Ceiling Validator (#524).
 *
 * Covers the explicit validation result for every fee/ceiling state, the
 * throwing gate, estimate-object validation, the opt-in `feeCeiling` option on
 * the fee estimation entry points, and the privacy guarantee that no
 * recipient, amount, or proof value ever reaches a message or result.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import {
  validateFeeCeiling,
  assertFeeWithinCeiling,
  validateTransactionFeeCeiling,
  isFeeWithinCeiling,
  FeeCeilingErrorCode,
  TransactionFeeCeilingError,
  DEFAULT_FEE_CEILING_WARN_BPS,
  TransactionFeeEstimator,
  estimatePreparedTransactionFee,
  FeeEstimationErrorCode,
} from "../src/fee-estimation";
import { ValidationError } from "../src/core/errors";

const TEST_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const TEST_RECIPIENT = Keypair.random().publicKey();

/** Assembled transaction, the way `rpc.assembleTransaction` leaves it. */
function buildAssembledTransaction(baseFee: string, resourceFee: bigint = 0n): Transaction {
  const account = new Account(Keypair.random().publicKey(), "1");
  return new TransactionBuilder(account, {
    fee: baseFee,
    networkPassphrase: Networks.TESTNET,
    sorobanData: new SorobanDataBuilder().setResourceFee(resourceFee).build(),
  })
    .addOperation(new Contract(TEST_CONTRACT_ID).call("private_pay"))
    .setTimeout(30)
    .build();
}

const SIM_SUCCESS = { minResourceFee: "1234" } as unknown as rpc.Api.SimulateTransactionResponse;

describe("Transaction Fee Ceiling Validator (#524)", () => {
  describe("validateFeeCeiling", () => {
    it("accepts a fee comfortably below the ceiling", () => {
      const result = validateFeeCeiling(500n, 1_000n);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state).toBe("within_ceiling");
      expect(result.fee).toBe(500n);
      expect(result.ceiling).toBe(1_000n);
      expect(result.headroom).toBe(500n);
      expect(result.utilizationBps).toBe(5_000);
      expect(result.warning).toBeUndefined();
    });

    it("defaults the approaching warning band to 80% of the ceiling", () => {
      expect(DEFAULT_FEE_CEILING_WARN_BPS).toBe(8_000);

      const result = validateFeeCeiling(800n, 1_000n);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state).toBe("approaching_ceiling");
      expect(result.utilizationBps).toBe(8_000);
      expect(result.warning).toContain("80%");
      expect(result.warning).toContain("800 of 1000 stroops");
    });

    it("reports a fee exactly at the ceiling as ok but approaching", () => {
      const result = validateFeeCeiling(1_000n, 1_000n);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state).toBe("approaching_ceiling");
      expect(result.headroom).toBe(0n);
      expect(result.utilizationBps).toBe(10_000);
    });

    it("supports a custom warning band and disabling it with 0", () => {
      const strict = validateFeeCeiling(600n, 1_000n, { warnBps: 5_000 });
      expect(strict.ok).toBe(true);
      if (strict.ok) expect(strict.state).toBe("approaching_ceiling");

      const disabled = validateFeeCeiling(999n, 1_000n, { warnBps: 0 });
      expect(disabled.ok).toBe(true);
      if (disabled.ok) {
        expect(disabled.state).toBe("within_ceiling");
        expect(disabled.warning).toBeUndefined();
      }
    });

    it("rejects an invalid warning band", () => {
      for (const warnBps of [10_001, -1, 2.5]) {
        const result = validateFeeCeiling(1n, 1_000n, { warnBps });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(FeeCeilingErrorCode.WARN_BAND_INVALID);
          expect(result.state).toBe("invalid");
        }
      }
    });

    it("rejects a fee above the ceiling with an actionable, fee-only message", () => {
      const result = validateFeeCeiling(1_500n, 1_000n, { label: "private_pay" });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.state).toBe("exceeds_ceiling");
      expect(result.code).toBe(FeeCeilingErrorCode.FEE_EXCEEDS_CEILING);
      expect(result.message).toContain("1500");
      expect(result.message).toContain("1000");
      expect(result.message).toContain("500 stroops");
      expect(result.message).toContain("private_pay");
      expect(result.message).toContain("before signing");
    });

    it("accepts integer numbers and integer strings for both values", () => {
      const result = validateFeeCeiling("900", 1_000);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.fee).toBe(900n);
      expect(result.ceiling).toBe(1_000n);
    });

    it("requires both values", () => {
      const missingFee = validateFeeCeiling(undefined, 1_000n);
      expect(missingFee.ok).toBe(false);
      if (!missingFee.ok) {
        expect(missingFee.code).toBe(FeeCeilingErrorCode.FEE_REQUIRED);
      }

      const missingCeiling = validateFeeCeiling(100n, null);
      expect(missingCeiling.ok).toBe(false);
      if (!missingCeiling.ok) {
        expect(missingCeiling.code).toBe(FeeCeilingErrorCode.CEILING_REQUIRED);
      }
    });

    it("rejects non-integer and unparseable fee values", () => {
      for (const fee of [1.5, "abc", {}, Number.NaN, Number.POSITIVE_INFINITY]) {
        const result = validateFeeCeiling(fee, 1_000n);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(FeeCeilingErrorCode.FEE_INVALID);
        }
      }
    });

    it("rejects negative fees", () => {
      for (const fee of [-1n, -100, "-100"]) {
        const result = validateFeeCeiling(fee, 1_000n);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(FeeCeilingErrorCode.FEE_NEGATIVE);
        }
      }
    });

    it("rejects zero, negative, and unparseable ceilings", () => {
      for (const ceiling of [0n, 0, "0", -5n, "abc"]) {
        const result = validateFeeCeiling(100n, ceiling);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(FeeCeilingErrorCode.CEILING_INVALID);
        }
      }
    });
  });

  describe("assertFeeWithinCeiling", () => {
    it("does not throw for a fee within the ceiling", () => {
      expect(() => assertFeeWithinCeiling(100n, 1_000n)).not.toThrow();
    });

    it("throws a typed TransactionFeeCeilingError carrying the fee figures", () => {
      try {
        assertFeeWithinCeiling(2_000n, 1_000n, { label: "private_pay" });
        throw new Error("expected assertFeeWithinCeiling to throw");
      } catch (err) {
        const error = err as TransactionFeeCeilingError;
        expect(error).toBeInstanceOf(TransactionFeeCeilingError);
        expect(error.name).toBe("TransactionFeeCeilingError");
        expect(error.code).toBe(FeeCeilingErrorCode.FEE_EXCEEDS_CEILING);
        expect(error.state).toBe("exceeds_ceiling");
        expect(error.fee).toBe(2_000n);
        expect(error.ceiling).toBe(1_000n);
        expect(error.message).not.toContain(TEST_RECIPIENT);
      }
    });

    it("treats a missing ceiling as no ceiling configured", () => {
      expect(() => assertFeeWithinCeiling(9_999_999n, undefined)).not.toThrow();
      expect(() => assertFeeWithinCeiling(9_999_999n, null)).not.toThrow();
    });

    it("throws for malformed inputs that cannot be validated", () => {
      expect(() => assertFeeWithinCeiling("abc", 1_000n)).toThrow(TransactionFeeCeilingError);
      expect(() => assertFeeWithinCeiling(100n, "abc")).toThrow(TransactionFeeCeilingError);
    });
  });

  describe("isFeeWithinCeiling", () => {
    it("returns a quick boolean for valid and invalid inputs", () => {
      expect(isFeeWithinCeiling(500n, 1_000n)).toBe(true);
      expect(isFeeWithinCeiling(1_000n, 1_000n)).toBe(true);
      expect(isFeeWithinCeiling(1_001n, 1_000n)).toBe(false);
      expect(isFeeWithinCeiling(100n, 0n)).toBe(false);
      expect(isFeeWithinCeiling(100n, undefined)).toBe(false);
      expect(isFeeWithinCeiling("x", 1_000n)).toBe(false);
    });
  });

  describe("validateTransactionFeeCeiling", () => {
    it("validates a fee estimate object's totalFee", () => {
      const result = validateTransactionFeeCeiling(
        { baseFee: 100n, resourceFee: 400n, totalFee: 500n },
        1_000n
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.fee).toBe(500n);
      expect(result.headroom).toBe(500n);
    });

    it("reports estimates that exceed the ceiling", () => {
      const result = validateTransactionFeeCeiling({ totalFee: 5_000n }, 1_000n);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(FeeCeilingErrorCode.FEE_EXCEEDS_CEILING);
        expect(result.state).toBe("exceeds_ceiling");
      }
    });

    it("rejects malformed estimates instead of throwing", () => {
      for (const estimate of [null, "estimate", [], {}, { totalFee: null }]) {
        const result = validateTransactionFeeCeiling(estimate, 1_000n);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(FeeCeilingErrorCode.FEE_REQUIRED);
          expect(result.state).toBe("invalid");
        }
      }
    });

    it("never echoes recipient or amount values from the estimate object", () => {
      const result = validateTransactionFeeCeiling(
        { totalFee: 5_000n, recipient: TEST_RECIPIENT, amount: 999_999_999n },
        1_000n
      );

      const serialized = JSON.stringify(result, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value
      );
      expect(serialized).not.toContain(TEST_RECIPIENT);
      expect(serialized).not.toContain("999999999");
      expect(serialized).toContain(FeeCeilingErrorCode.FEE_EXCEEDS_CEILING);
    });
  });

  describe("feeCeiling option on the estimation entry points", () => {
    it("passes an estimate whose total fits the ceiling", () => {
      const tx = buildAssembledTransaction("100", 1_234n);
      const estimate = estimatePreparedTransactionFee(tx);

      expect(() =>
        estimatePreparedTransactionFee(tx, { feeCeiling: estimate.totalFee })
      ).not.toThrow();
    });

    it("throws TransactionFeeCeilingError when the prepared estimate is over the ceiling", () => {
      const tx = buildAssembledTransaction("100", 1_234n);
      const estimate = estimatePreparedTransactionFee(tx);

      let caught: unknown;
      try {
        estimatePreparedTransactionFee(tx, { feeCeiling: estimate.totalFee - 1n });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(TransactionFeeCeilingError);
      const error = caught as TransactionFeeCeilingError;
      expect(error.code).toBe(FeeCeilingErrorCode.FEE_EXCEEDS_CEILING);
      expect(error.message).not.toContain(TEST_RECIPIENT);
    });

    it("applies the ceiling to the buffered total from a live simulation", async () => {
      const simulate = jest.fn().mockResolvedValue(SIM_SUCCESS);
      const server = { simulateTransaction: simulate } as unknown as rpc.Server;

      // subtotal = 100 + 1234 = 1334; buffer 10% => total 1467
      const estimator = new TransactionFeeEstimator(server, {
        bufferBps: 1_000,
        feeCeiling: 1_400n,
      });
      await expect(estimator.estimate(buildAssembledTransaction(BASE_FEE))).rejects.toThrow(
        TransactionFeeCeilingError
      );

      const affordable = new TransactionFeeEstimator(server, {
        bufferBps: 1_000,
        feeCeiling: 1_467n,
      });
      const estimate = await affordable.estimate(buildAssembledTransaction(BASE_FEE));
      expect(estimate.totalFee).toBe(1_467n);
    });

    it("rejects an invalid feeCeiling option with a typed ValidationError", () => {
      for (const feeCeiling of [0n, -5n, 10.5 as unknown as bigint]) {
        const tx = buildAssembledTransaction("100", 1_234n);
        expect(() => estimatePreparedTransactionFee(tx, { feeCeiling })).toThrow(ValidationError);

        try {
          estimatePreparedTransactionFee(tx, { feeCeiling });
        } catch (err) {
          const error = err as ValidationError;
          expect(error.code).toBe(FeeEstimationErrorCode.INVALID_CEILING);
        }
      }
    });

    it("leaves estimates untouched when no ceiling is configured", async () => {
      const simulate = jest.fn().mockResolvedValue(SIM_SUCCESS);
      const server = { simulateTransaction: simulate } as unknown as rpc.Server;

      const estimator = new TransactionFeeEstimator(server);
      const estimate = await estimator.estimate(buildAssembledTransaction(BASE_FEE));
      expect(estimate.totalFee).toBe(BigInt(BASE_FEE) + 1_234n);
    });
  });
});
