import { normalizeEmployeeIdentifier } from "../employees/referenceId";

export function validatePayrollDraftEmployeeRefs(employeeIds: string[]): {
  isValid: boolean;
  invalidIds: string[];
} {
  const invalidIds: string[] = [];
  for (const id of employeeIds) {
    if (normalizeEmployeeIdentifier(id) === null) {
      invalidIds.push(id);
    }
  }

  return {
    isValid: invalidIds.length === 0,
    invalidIds,
  };
}
