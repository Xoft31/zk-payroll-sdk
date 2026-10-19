import { describe, it, expect, beforeEach } from 'vitest';
import {
  assertPayrollStateConsistency,
  PayrollStateConsistencyError,
  type PayrollStateSnapshot,
} from '../../src/payroll/stateConsistencyGuard';

const makeSnapshot = (
  overrides: Partial<PayrollStateSnapshot> = {},
): PayrollStateSnapshot => ({
  payrollId: 'primary',
  periodId: '2024-01',
  expectedEmployeeCount: 3,
  processedEmployeeIds: ['alice', 'bob', 'carol'],
  totalAmount: 1000,
  paidAmount: 1000,
  status: 'completed',
  ...overrides,
});

describe('assertPayrollStateConsistency', () => {
  it('returns a consistent result for a valid completed payroll', () => {
    const result = assertPayrollStateConsistency(makeSnapshot());
    expect(result.consistent).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.snapshot.payrollId).toBe('primary');
  });

  it('reports an issue when the employee count mismatches the processed ids length', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({ expectedEmployeeCount: 4 }),
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('EMPLOYEE_COUNT_MISMATCH');
  });

  it('reports an issue when duplicate employee ids are present', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({
        expectedEmployeeCount: 3,
        processedEmployeeIds: ['alice', 'alice', 'bob'],
      }),
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('DUPLICATE_EMPLOYEE_ID');
  });

  it('reports an issue when the paid amount exceeds the total amount', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({ totalAmount: 1000, paidAmount: 1250 }),
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('PAID_EXCEEDS_TOTAL');
  });

  it('reports an issue when a completed payroll has not been fully paid', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({ status: 'completed', paidAmount: 500 }),
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('COMPLETED_WITH_UNPAID');
  });

  it('reports an issue when a non-completed payroll is fully paid but not marked complete', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({ status: 'processing', paidAmount: 1000 }),
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('PAID_WITH_INCOMPLETE_STATUS');
  });

  it('reports an issue when total amount is negative', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({ totalAmount: -1, paidAmount: 0 }),
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('NEGATIVE_TOTAL');
  });

  it('reports an issue when paid amount is negative', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({ paidAmount: -1 }),
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('NEGATIVE_PAID');
  });

  it('reports an issue when the payroll reference is missing', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({ payrollId: '' }),
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('MISSING_PAYROLL_ID');
  });

  it('reports an issue when the period reference is missing', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({ periodId: ' ' }),
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('MISSING_PERIOD_ID');
  });

  it('reports an issue when the status is unknown', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({ status: 'unknown' as PayrollStateSnapshot['status'] }),
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('UNKNOWN_STATUS');
  });

  it('reports an issue when the employee id list is not an array', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({
        processedEmployeeIds: 'not-an-array' as unknown as string[],
      }),
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain($INVALID_EMPLOYEE_IDS$);
  });

  it('reports an issue when an employee id is blank', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({
        expectedEmployeeCount: 3,
        processedEmployeeIds: ['alice', ' ', 'bob'],
      }),
    );
    expect(result.consistent).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('INVALID_EMPLOYEE_ID');
  });

  it('accumulates multiple issues in a single call', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({
        payrollId: '',
        periodId: '',
        expectedEmployeeCount: 5,
        processedEmployeeIds: ['alice', 'alice'],
        totalAmount: 1000,
        paidAmount: 2000,
        status: 'completed',
      }),
    );
    expect(result.consistent).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('MISSING_PAYROLL_ID');
    expect(codes).toContain('MISSING_PERIOD_ID');
    expect(codes).toContain('EMPLOYEE_COUNT_MISMATCH');
    expect(codes).toContain($DUPLICATE_EMPLOYEE_ID');
    expect(codes).toContain($PAID_EXCEEDS_TOTAL');
  });

  it('throws a PayrollStateConsistencyError with actionable messages when strict mode is enabled', () => {
    expect(() =>
      assertPayrollStateConsistency(
        makeSnapshot({ expectedEmployeeCount: 4 }),
        { strict: true },
      ),
    ).toThrow(PayrollStateConsistencyError);
  });

  it('thrown error exposes the underlying issues for integrators', () => {
    try {
      assertPayrollStateConsistency(
        makeSnapshot({ expectedEmployeeCount: 4 }),
        { strict: true },
      );
      throw new Error('expected assertPayrollStateConsistency to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PayrollStateConsistencyError);
      const guardError = error as PayrollStateConsistencyError;
      expect(guardError.issues.length).toBeGreaterThan(0);
      expect(guardError.message).toMatch(/employee count/i);
    }
  });

  it('does not throw in strict mode when the snapshot is consistent', () => {
    expect(() =>
      assertPayrollStateConsistency(makeSnapshot(), { strict: true }),
    ).not.toThrow();
  });

  it('returns a defensive copy of the snapshot and issues so callers cannot mutate internal state', () => {
    const input = makeSnapshot({ expectedEmployeeCount: 4 });
    const result = assertPayrollStateConsistency(input);
    input.processedEmployeeIds.push('dave');
    expect(result.snapshot.processedEmployeeIds).toEqual(['alice', 'bob', 'carol']);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('treats total and paid amounts with floating point precision consistently', () => {
    const result = assertPayrollStateConsistency(
      makeSnapshot({ totalAmount: 0.1 + 0.2, paidAmount: 0.3 }),
    );
    expect(result.consistent).toBe(true);
  });
});
