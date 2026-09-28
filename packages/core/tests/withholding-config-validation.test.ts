/**
 * Tests for the Withholding Configuration Validator (#519).
 *
 * Covers the main path, every failure state, batch aggregation, the throwing
 * assertion helper, PayrollService integration, and the privacy guarantee that
 * employee identifiers and configured amounts never leak into messages.
 */

import {
  validateWithholdingConfig,
  assertWithholdingConfig,
  validateBatchWithholdingConfigs,
  WithholdingConfigError,
  WithholdingConfigErrorCode,
  MAX_WITHHOLDING_RATE,
  DEFAULT_WITHHOLDING_ROUNDING,
} from "../src/payroll/withholdingConfig";
import { PayrollService } from "../src/payroll";

const EMPLOYEE_ID = "emp-987654321";

describe("Withholding Configuration Validator (#519)", () => {
  describe("percentage configurations (main path)", () => {
    it("validates a percentage rule and normalizes it", () => {
      const result = validateWithholdingConfig({
        employeeId: EMPLOYEE_ID,
        method: "percentage",
        rate: 12.5,
        rounding: "floor",
        jurisdiction: "US-FED-2026",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state).toBe("validated");
      expect(result.config).toEqual({
        employeeId: EMPLOYEE_ID,
        method: "percentage",
        rate: 12.5,
        rounding: "floor",
        jurisdiction: "US-FED-2026",
        amount: undefined,
        maxPerRun: undefined,
      });
      expect(result.config.amount).toBeUndefined();
      expect(result.config.maxPerRun).toBeUndefined();
    });

    it("applies the default rounding mode and allows an employer-wide rule", () => {
      const result = validateWithholdingConfig({ method: "percentage", rate: 5 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.rounding).toBe(DEFAULT_WITHHOLDING_ROUNDING);
      expect(result.config.employeeId).toBeUndefined();
      expect(result.displayEmployeeId).toBe("[ANONYMOUS_RECIPIENT]");
    });

    it("accepts the boundary rate of exactly 100%", () => {
      const result = validateWithholdingConfig({
        method: "percentage",
        rate: MAX_WITHHOLDING_RATE,
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("fixed configurations (main path)", () => {
    it("parses a bigint amount and an optional per-run cap", () => {
      const result = validateWithholdingConfig({
        employeeId: EMPLOYEE_ID,
        method: "fixed",
        amount: 2_500_000n,
        maxPerRun: 10_000_000n,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.method).toBe("fixed");
      expect(result.config.amount).toBe(2_500_000n);
      expect(result.config.maxPerRun).toBe(10_000_000n);
      expect(result.displayEmployeeId).toBe("emp***321");
    });

    it("parses a decimal string amount using the default asset precision", () => {
      const result = validateWithholdingConfig({ method: "fixed", amount: "10.50" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.amount).toBe(105_000_000n); // 10.5 with 7 decimals
    });

    it("honours a custom decimals precision when parsing strings", () => {
      const result = validateWithholdingConfig(
        { method: "fixed", amount: "10.5" },
        { decimals: 2 }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.amount).toBe(1_050n);
    });
  });

  describe("malformed input", () => {
    it.each([[null], [undefined], ["percentage"], [[]], [42]])(
      "reports %p as malformed",
      (entry) => {
        const result = validateWithholdingConfig(entry);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.state).toBe("malformed");
        expect(result.code).toBe(WithholdingConfigErrorCode.CONFIG_REQUIRED);
        expect(result.message).toContain("must be an object");
      }
    );
  });

  describe("method failures", () => {
    it("requires a method", () => {
      const result = validateWithholdingConfig({ rate: 10 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.METHOD_REQUIRED);
      expect(result.state).toBe("invalid");
    });

    it("rejects unsupported methods without echoing arbitrary input", () => {
      const result = validateWithholdingConfig({ method: "tithing", rate: 10 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.METHOD_UNSUPPORTED);
      expect(result.message).not.toContain("tithing");
    });
  });

  describe("rate failures", () => {
    it("requires a rate for percentage rules", () => {
      const result = validateWithholdingConfig({ method: "percentage" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.RATE_REQUIRED);
    });

    it("rejects non-numeric rates", () => {
      const result = validateWithholdingConfig({ method: "percentage", rate: "12.5" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.RATE_INVALID);
    });

    it("rejects rates with more than four decimal places", () => {
      const result = validateWithholdingConfig({ method: "percentage", rate: 7.12345 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.RATE_INVALID);
      expect(result.message).toContain("4 decimal places");
    });

    it("rejects a zero rate by default and accepts it when explicitly allowed", () => {
      const rejected = validateWithholdingConfig({ method: "percentage", rate: 0 });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.code).toBe(WithholdingConfigErrorCode.RATE_OUT_OF_RANGE);
        expect(rejected.message).toContain("allowZeroRate");
      }

      const accepted = validateWithholdingConfig(
        { method: "percentage", rate: 0 },
        { allowZeroRate: true }
      );
      expect(accepted.ok).toBe(true);
      if (accepted.ok) expect(accepted.config.rate).toBe(0);
    });

    it("rejects negative and above-100 rates", () => {
      const negative = validateWithholdingConfig({ method: "percentage", rate: -1 });
      expect(negative.ok).toBe(false);
      if (!negative.ok) {
        expect(negative.code).toBe(WithholdingConfigErrorCode.RATE_OUT_OF_RANGE);
      }

      const tooHigh = validateWithholdingConfig({ method: "percentage", rate: 100.01 });
      expect(tooHigh.ok).toBe(false);
      if (!tooHigh.ok) {
        expect(tooHigh.code).toBe(WithholdingConfigErrorCode.RATE_OUT_OF_RANGE);
        expect(tooHigh.message).toContain("100");
      }
    });

    it("enforces a stricter policy ceiling from options", () => {
      const result = validateWithholdingConfig({ method: "percentage", rate: 30 }, { maxRate: 25 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.RATE_OUT_OF_RANGE);
      expect(result.message).toContain("25");
    });
  });

  describe("method/value contradictions", () => {
    it("rejects an amount on a percentage rule", () => {
      const result = validateWithholdingConfig({
        method: "percentage",
        rate: 10,
        amount: 1_000n,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.AMOUNT_UNEXPECTED);
    });

    it("rejects a rate on a fixed rule", () => {
      const result = validateWithholdingConfig({
        method: "fixed",
        rate: 10,
        amount: 1_000n,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.RATE_INVALID);
    });
  });

  describe("fixed amount failures", () => {
    it("requires an amount", () => {
      const result = validateWithholdingConfig({ method: "fixed" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.AMOUNT_REQUIRED);
    });

    it("rejects negative amounts", () => {
      const result = validateWithholdingConfig({ method: "fixed", amount: -5n });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.AMOUNT_NEGATIVE);
    });

    it("rejects zero amounts by default and accepts them when explicitly allowed", () => {
      const rejected = validateWithholdingConfig({ method: "fixed", amount: 0n });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.code).toBe(WithholdingConfigErrorCode.AMOUNT_ZERO);
      }

      const accepted = validateWithholdingConfig(
        { method: "fixed", amount: 0 },
        { allowZeroAmount: true }
      );
      expect(accepted.ok).toBe(true);
      if (accepted.ok) expect(accepted.config.amount).toBe(0n);
    });

    it("rejects malformed, fractional, and over-precise amounts", () => {
      for (const amount of ["abc", 10.5, "1.12345678"]) {
        const result = validateWithholdingConfig({ method: "fixed", amount });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(WithholdingConfigErrorCode.AMOUNT_INVALID);
        }
      }
    });
  });

  describe("per-run cap", () => {
    it("rejects a cap that is not a positive integer", () => {
      const result = validateWithholdingConfig({
        method: "fixed",
        amount: 1_000n,
        maxPerRun: "not-a-cap",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.CAP_INVALID);
    });

    it("rejects a fixed amount above the cap", () => {
      const result = validateWithholdingConfig({
        method: "fixed",
        amount: 5_000_000n,
        maxPerRun: 1_000_000n,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.CAP_EXCEEDED);
      expect(result.state).toBe("invalid");
    });

    it("accepts a cap at or above the configured amount", () => {
      const result = validateWithholdingConfig({
        method: "fixed",
        amount: 1_000_000n,
        maxPerRun: 1_000_000n,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config.maxPerRun).toBe(1_000_000n);
    });
  });

  describe("rounding, jurisdiction, and employee reference", () => {
    it("rejects an unsupported rounding mode", () => {
      const result = validateWithholdingConfig({
        method: "percentage",
        rate: 10,
        rounding: "bankers",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.ROUNDING_UNSUPPORTED);
    });

    it("rejects an empty jurisdiction label", () => {
      const result = validateWithholdingConfig({
        method: "percentage",
        rate: 10,
        jurisdiction: "   ",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.JURISDICTION_INVALID);
    });

    it("requires an employee reference when the run demands one", () => {
      const result = validateWithholdingConfig(
        { method: "percentage", rate: 10 },
        { requireEmployeeId: true }
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.EMPLOYEE_REQUIRED);
    });

    it("rejects a rule bound to a different employee without echoing either identifier", () => {
      const result = validateWithholdingConfig(
        { employeeId: EMPLOYEE_ID, method: "percentage", rate: 10 },
        { expectedEmployeeId: "emp-000000000" }
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.EMPLOYEE_MISMATCH);
      expect(result.message).not.toContain(EMPLOYEE_ID);
      expect(result.message).not.toContain("emp-000000000");
    });

    it("accepts a matching expected employee reference", () => {
      const result = validateWithholdingConfig(
        { employeeId: ` ${EMPLOYEE_ID} `, method: "percentage", rate: 10 },
        { expectedEmployeeId: EMPLOYEE_ID }
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config.employeeId).toBe(EMPLOYEE_ID);
    });

    it("rejects a non-string employee reference", () => {
      const result = validateWithholdingConfig({
        employeeId: 12345,
        method: "percentage",
        rate: 10,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(WithholdingConfigErrorCode.EMPLOYEE_REQUIRED);
    });
  });

  describe("privacy guarantees", () => {
    it("never echoes the raw employee identifier in failure messages", () => {
      const result = validateWithholdingConfig({
        employeeId: EMPLOYEE_ID,
        method: "fixed",
        amount: -1n,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).not.toContain(EMPLOYEE_ID);
      expect(result.message).toContain("emp***321");
    });

    it("never echoes configured amounts in failure messages by default", () => {
      const secretAmount = "987654321";
      const result = validateWithholdingConfig({
        method: "fixed",
        amount: secretAmount,
        maxPerRun: 1n,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).not.toContain(secretAmount);
      expect(result.message).toContain("[REDACTED]");
    });

    it("can surface amounts only when explicitly requested", () => {
      const result = validateWithholdingConfig(
        {
          method: "fixed",
          amount: 5_000_000n,
          maxPerRun: 1_000_000n,
        },
        { includeAmounts: true }
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain("5000000");
    });

    it("never returns the raw employee identifier inside a failure result", () => {
      const result = validateWithholdingConfig({
        employeeId: EMPLOYEE_ID,
        method: "percentage",
        rate: 250,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(JSON.stringify(result)).not.toContain(EMPLOYEE_ID);
    });
  });

  describe("assertWithholdingConfig", () => {
    it("returns the normalized configuration for a valid rule", () => {
      const config = assertWithholdingConfig({ method: "percentage", rate: 15 });
      expect(config.method).toBe("percentage");
      expect(config.rate).toBe(15);
    });

    it("throws a sanitized WithholdingConfigError for an invalid rule", () => {
      expect(() => assertWithholdingConfig({ method: "percentage", rate: 500 })).toThrow(
        WithholdingConfigError
      );

      try {
        assertWithholdingConfig({
          employeeId: EMPLOYEE_ID,
          method: "percentage",
          rate: 500,
        });
        throw new Error("expected assertWithholdingConfig to throw");
      } catch (err) {
        const withhodlingError = err as WithholdingConfigError;
        expect(withhodlingError.name).toBe("WithholdingConfigError");
        expect(withhodlingError.code).toBe(WithholdingConfigErrorCode.RATE_OUT_OF_RANGE);
        expect(withhodlingError.state).toBe("invalid");
        expect(withhodlingError.message).not.toContain(EMPLOYEE_ID);
      }
    });
  });

  describe("validateBatchWithholdingConfigs", () => {
    it("aggregates issues with their entry indexes and sanitized details", () => {
      const result = validateBatchWithholdingConfigs([
        { method: "percentage", rate: 12.5 },
        { employeeId: EMPLOYEE_ID, method: "fixed", amount: -1n },
        "not-an-object",
        { method: "fixed", amount: "25.00" },
      ]);

      expect(result.isValid).toBe(false);
      expect(result.summary).toEqual({
        totalEntries: 4,
        validCount: 2,
        invalidCount: 2,
        malformedCount: 1,
      });
      expect(result.issues.map((issue) => issue.index)).toEqual([1, 2]);
      expect(result.issues[0].code).toBe(WithholdingConfigErrorCode.AMOUNT_NEGATIVE);
      expect(result.issues[0].displayEmployeeId).toBe("emp***321");
      expect(result.issues[0].message).not.toContain(EMPLOYEE_ID);
      expect(result.issues[1].state).toBe("malformed");
    });

    it("returns isValid when every entry passes", () => {
      const result = validateBatchWithholdingConfigs([
        { method: "percentage", rate: 10 },
        { method: "fixed", amount: 1_000n },
      ]);

      expect(result.isValid).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.summary.validCount).toBe(2);
    });

    it("rejects a non-array batch input", () => {
      const result = validateBatchWithholdingConfigs("nope" as unknown as unknown[]);
      expect(result.isValid).toBe(false);
      expect(result.summary.malformedCount).toBe(1);
      expect(result.issues[0].code).toBe(WithholdingConfigErrorCode.CONFIG_REQUIRED);
    });

    it("applies policy options to every entry", () => {
      const result = validateBatchWithholdingConfigs(
        [
          { method: "percentage", rate: 30 },
          { method: "percentage", rate: 40 },
        ],
        { maxRate: 25 }
      );

      expect(result.isValid).toBe(false);
      expect(result.issues).toHaveLength(2);
      expect(
        result.issues.every((i) => i.code === WithholdingConfigErrorCode.RATE_OUT_OF_RANGE)
      ).toBe(true);
    });
  });

  describe("PayrollService integration", () => {
    const service = new PayrollService(
      {} as never,
      {} as never,
      { sign: jest.fn(), getPublicKey: () => "G..." } as never,
      "testnet"
    );

    it("exposes the validator as an instance helper", () => {
      const result = service.validateWithholdingConfig({ method: "percentage", rate: 12 });
      expect(result.ok).toBe(true);
    });

    it("exposes the validator as a static helper", () => {
      const invalid = PayrollService.validateWithholdingConfig({ method: "percentage" });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.code).toBe(WithholdingConfigErrorCode.RATE_REQUIRED);
      }

      const valid = PayrollService.validateWithholdingConfig({ method: "percentage", rate: 12 });
      expect(valid.ok).toBe(true);
    });
  });
});
