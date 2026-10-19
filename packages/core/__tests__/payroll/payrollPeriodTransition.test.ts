import {
  assertPayrollPeriodTransition,
  StateConsistencyError,
  StateConsistencyErrorCode,
} from "../../src/payroll/stateConsistencyGuard";

describe("assertPayrollPeriodTransition", () => {
  it("allows draft to locked", () => {
    expect(() =>
      assertPayrollPeriodTransition("draft", "locked")
    ).not.toThrow();
  });

  it("allows draft to cancelled", () => {
    expect(() =>
      assertPayrollPeriodTransition("draft", "cancelled")
    ).not.toThrow();
  });

  it("allows locked to settled", () => {
    expect(() =>
      assertPayrollPeriodTransition("locked", "settled")
    ).not.toThrow();
  });

  it("rejects invalid transitions", () => {
    expect(() =>
      assertPayrollPeriodTransition("draft", "settled")
    ).toThrow(StateConsistencyError);

    try {
      assertPayrollPeriodTransition("draft", "settled");
    } catch (error) {
      expect(error).toBeInstanceOf(StateConsistencyError);
      expect((error as StateConsistencyError).code).toBe(
        StateConsistencyErrorCode.INVALID_TRANSITION
      );
    }
  });

  it("rejects transitions from terminal states", () => {
    expect(() =>
      assertPayrollPeriodTransition("settled", "draft")
    ).toThrow(StateConsistencyError);

    expect(() =>
      assertPayrollPeriodTransition("cancelled", "draft")
    ).toThrow(StateConsistencyError);
  });

  it("rejects missing statuses", () => {
    expect(() =>
      assertPayrollPeriodTransition("", "locked")
    ).toThrow(StateConsistencyError);
  });
});
