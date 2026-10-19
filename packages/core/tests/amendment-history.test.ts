import {
  buildAmendmentHistoryRecord,
  normalizeAmendmentHistory,
  normalizeAmendmentHistoryRecord,
} from "../src/amendments";

describe("amendment history", () => {
  it("normalizes wire records and preserves actor/revision metadata", () => {
    const record = normalizeAmendmentHistoryRecord({
      payrollId: "payroll-1",
      revision: "2",
      actor: "GABC...",
      occurredAt: "2026-09-28T12:00:00.000Z",
      changes: [
        { type: "modified", recipient: "GDEF...", oldAmount: "10", newAmount: 20, asset: "USDC" },
      ],
    });

    expect(record).toMatchObject({
      payrollId: "payroll-1",
      revision: 2,
      actor: "GABC...",
      recordedAt: Date.parse("2026-09-28T12:00:00.000Z"),
    });
    expect(record.diffs[0].oldAmount).toBe(10n);
    expect(record.diffs[0].newAmount).toBe(20n);
  });

  it("sorts history and rejects duplicate revisions", () => {
    const record = (revision: number) => ({
      payrollId: "payroll-1",
      revision,
      actor: "GABC...",
      recordedAt: 1000,
      diffs: [],
    });

    expect(normalizeAmendmentHistory([record(2), record(1)]).map((item) => item.revision)).toEqual([
      1, 2,
    ]);
    expect(() => normalizeAmendmentHistory([record(1), record(1)])).toThrow(
      "Invalid payroll amendment history record"
    );
  });

  it("builds a history record from an amendment plan", () => {
    const record = buildAmendmentHistoryRecord({
      payrollId: "payroll-1",
      revision: 3,
      actor: "GABC...",
      recordedAt: 5000,
      plan: {
        diffs: [{ type: "added", recipient: "GDEF...", newAmount: 25n, asset: "XLM" }],
      },
    });

    expect(record.revision).toBe(3);
    expect(record.diffs[0].newAmount).toBe(25n);
  });

  it("does not echo sensitive payloads in validation errors", () => {
    expect(() =>
      normalizeAmendmentHistoryRecord({ payrollId: "secret-payroll", revision: 0 })
    ).toThrow("Invalid payroll amendment history record");
    expect(() =>
      normalizeAmendmentHistoryRecord({ payrollId: "secret-payroll", revision: 0 })
    ).not.toThrow("secret-payroll");
  });
});
