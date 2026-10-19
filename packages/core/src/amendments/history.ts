import { PayrollError } from "../errors";
import { AmendmentPlan } from "./types";

export type AmendmentHistoryDiff = AmendmentPlan["diffs"][number];

/** Canonical, privacy-safe representation of a payroll amendment event. */
export interface AmendmentHistoryRecord {
  payrollId: string;
  revision: number;
  actor: string;
  /** Epoch-millis timestamp at which the amendment was recorded. */
  recordedAt: number;
  diffs: AmendmentHistoryDiff[];
  reason?: string;
}

/** Accepted wire representations for an amendment history record. */
export interface AmendmentHistoryRecordInput {
  payrollId: unknown;
  revision: unknown;
  actor: unknown;
  recordedAt?: unknown;
  occurredAt?: unknown;
  timestamp?: unknown;
  diffs?: unknown;
  changes?: unknown;
  reason?: unknown;
}

function invalidHistoryRecord(): never {
  // Do not include the input in the message: history payloads can contain payroll data.
  throw new PayrollError("Invalid payroll amendment history record", "AMENDMENT_HISTORY_INVALID");
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : invalidHistoryRecord();
}

function positiveRevision(value: unknown): number {
  const revision = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : invalidHistoryRecord();
}

function epochMillis(value: unknown): number {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(String(value));
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : invalidHistoryRecord();
}

function amount(value: unknown): bigint {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  } catch {
    // Fall through to the redacted validation error.
  }
  return invalidHistoryRecord();
}

function normalizeDiff(value: unknown): AmendmentHistoryDiff {
  if (!value || typeof value !== "object") return invalidHistoryRecord();
  const diff = value as Record<string, unknown>;
  const type = diff.type;
  if (type !== "added" && type !== "removed" && type !== "modified") {
    return invalidHistoryRecord();
  }
  const result: AmendmentHistoryDiff = {
    type,
    recipient: nonEmptyString(diff.recipient),
    asset: nonEmptyString(diff.asset),
  };
  if (diff.oldAmount !== undefined) result.oldAmount = amount(diff.oldAmount);
  if (diff.newAmount !== undefined) result.newAmount = amount(diff.newAmount);
  return result;
}

/** Normalize and validate one record received from a contract or backend adapter. */
export function normalizeAmendmentHistoryRecord(input: unknown): AmendmentHistoryRecord {
  if (!input || typeof input !== "object") return invalidHistoryRecord();
  const record = input as AmendmentHistoryRecordInput;
  const timestamp = record.recordedAt ?? record.occurredAt ?? record.timestamp;
  const rawDiffs = record.diffs ?? record.changes ?? [];
  if (!Array.isArray(rawDiffs)) return invalidHistoryRecord();

  const normalized: AmendmentHistoryRecord = {
    payrollId: nonEmptyString(record.payrollId),
    revision: positiveRevision(record.revision),
    actor: nonEmptyString(record.actor),
    recordedAt: epochMillis(timestamp),
    diffs: rawDiffs.map(normalizeDiff),
  };
  if (record.reason !== undefined) normalized.reason = nonEmptyString(record.reason);
  return normalized;
}

/** Normalize a history page and reject duplicate revisions for the same payroll. */
export function normalizeAmendmentHistory(input: unknown): AmendmentHistoryRecord[] {
  if (!Array.isArray(input)) return invalidHistoryRecord();
  const records = input
    .map(normalizeAmendmentHistoryRecord)
    .sort((a, b) => a.revision - b.revision);
  for (let index = 1; index < records.length; index += 1) {
    if (records[index - 1].revision === records[index].revision) return invalidHistoryRecord();
  }
  return records;
}

/** Build a canonical history record from a validated amendment plan. */
export function buildAmendmentHistoryRecord(input: {
  payrollId: string;
  revision: number;
  actor: string;
  plan: Pick<AmendmentPlan, "diffs">;
  recordedAt?: number | Date;
  reason?: string;
}): AmendmentHistoryRecord {
  return normalizeAmendmentHistoryRecord({
    payrollId: input.payrollId,
    revision: input.revision,
    actor: input.actor,
    recordedAt: input.recordedAt ?? Date.now(),
    diffs: input.plan.diffs,
    reason: input.reason,
  });
}
