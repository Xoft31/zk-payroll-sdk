/**
 * Organization Policy Migration Validation
 *
 * Validates that an organization's payroll policy can be migrated from a legacy
 * schema (version 0 — the pre-`CompiledPayrollPolicy` format) to the current SDK
 * schema (version 1, {@link CompiledPayrollPolicy}).
 *
 * Migration is validated rather than applied destructively, so an integration can
 * preview whether a stored legacy policy is coherent before committing it. When
 * the migration is valid, the compiled current-schema policy is returned so the
 * caller can apply it directly.
 *
 * Legacy policies used deprecated, human-authored field names and numeric
 * (non-`bigint`) monetary values. This module remaps them to the canonical
 * {@link PayrollPolicyInput} shape and re-runs the full policy compiler so every
 * existing invariant (settlement windows, capacity/reserve coherence, asset
 * identity, effective-date rules) is enforced without duplicating logic.
 *
 * @module
 */

import { normalizeAssetIdentity, AssetIdentityError } from "../assets/assetIdentity";
import { compilePayrollPolicy } from "./compiler";
import {
  CompiledPayrollPolicy,
  type AuditSettingsInput,
  type CapacityLimitsInput,
  type PayrollPolicyInput,
  type ReserveRequirementsInput,
  type SettlementWindowInput,
} from "./types";

/** Legacy "flat" organization policy field names understood by the migrator. */
export const LEGACY_ORG_POLICY_VERSION = 0;
/** Current organization policy schema version (`CompiledPayrollPolicy.schemaVersion`). */
export const CURRENT_ORG_POLICY_SCHEMA_VERSION = 1;

/**
 * Machine-readable error codes for organization policy migration failures.
 */
export enum OrgPolicyMigrationErrorCode {
  /** The policy `version` is not a supported legacy version. */
  INVALID_SCHEMA_VERSION = "INVALID_SCHEMA_VERSION",
  /** A required field is missing or empty. */
  MISSING_FIELD = "MISSING_FIELD",
  /** A field has the wrong runtime type or shape. */
  INVALID_FIELD_TYPE = "INVALID_FIELD_TYPE",
  /** The organization identifier is missing or malformed. */
  INVALID_ORGANIZATION_ID = "INVALID_ORGANIZATION_ID",
  /** The asset could not be normalized (delegates to `AssetIdentityErrorCode`). */
  INVALID_ASSET = "INVALID_ASSET",
  /** A coherence rule failed during compilation of the remapped policy. */
  COMPILE_ERROR = "COMPILE_ERROR",
  /** The policy is already at the current schema; no legacy migration needed. */
  ALREADY_MIGRATED = "ALREADY_MIGRATED",
}

/**
 * Structured error thrown (or collected) when an organization policy migration
 * fails. Carries a machine-readable `code`, the offending `field`, and optional
 * `context` so callers can surface precise, actionable diagnostics.
 */
export class OrganizationPolicyMigrationError extends Error {
  constructor(
    message: string,
    public readonly code: OrgPolicyMigrationErrorCode,
    public readonly field: string,
    public readonly context: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "OrganizationPolicyMigrationError";
  }
}

/** A single deprecated-field notice surfaced during migration. */
export interface OrganizationPolicyMigrationWarning {
  /** Legacy field path that was remapped. */
  field: string;
  /** Human-readable explanation of what changed. */
  message: string;
  /** Replacement field path to use going forward. */
  suggestion: string;
}

/** Remapping between a legacy field path and its current canonical location. */
export interface OrganizationPolicyFieldMapping {
  /** Legacy (deprecated) field path. */
  legacy: string;
  /** Current canonical field path. */
  current: string;
  /** Human-readable guidance for integrators. */
  suggestion: string;
}

/** Plan describing how a legacy organization policy is migrated to the current schema. */
export interface OrganizationPolicyMigrationPlan {
  /** Source schema version (`0` for legacy, `1` for already-current). */
  fromVersion: number;
  /** Target schema version (always {@link CURRENT_ORG_POLICY_SCHEMA_VERSION}). */
  toVersion: number;
  /** Explicit legacy→current field remappings applied during migration. */
  fieldMappings: OrganizationPolicyFieldMapping[];
  /** Subset of {@link fieldMappings} actually present in the migrated input. */
  appliedMappings: OrganizationPolicyFieldMapping[];
}

/**
 * Result of {@link validateOrganizationPolicyMigration}.
 */
export interface OrganizationPolicyMigrationValidationResult {
  /** `true` when the policy migrates (or is already) to a coherent current-schema policy. */
  valid: boolean;
  /** Organization identifier carried from the input. */
  organizationId: string;
  /** Schema version the input was detected at. */
  version: number;
  /** Migration plan; present whenever a migration (or no-op) was evaluated. */
  migrationPlan?: OrganizationPolicyMigrationPlan;
  /** Compiled current-schema policy; present only when `valid` is `true`. */
  migratedPolicy?: CompiledPayrollPolicy;
  /** Actionable notices about remapped legacy fields (never empty for a migrated policy). */
  warnings: OrganizationPolicyMigrationWarning[];
  /** Collected migration/compilation errors (empty when `valid` is `true`). */
  errors: OrganizationPolicyMigrationError[];
}

/** Options for {@link validateOrganizationPolicyMigration}. */
export interface OrganizationPolicyMigrationOptions {
  /** Reference time (epoch ms) forwarded to the policy compiler for date checks. */
  now?: number;
}

/**
 * Complete legacy→current field remapping table used by the migrator.
 *
 * Each entry also carries a `suggestion` surfaced as a migration warning so
 * integrators know exactly which current field to author.
 */
export const ORG_POLICY_FIELD_MAPPINGS: OrganizationPolicyFieldMapping[] = [
  {
    legacy: "assetCode:assetIssuer",
    current: "asset",
    suggestion:
      'Use `asset` (a canonical id such as "native" or "CODE:ISSUER") instead of `assetCode`/`assetIssuer`.',
  },
  {
    legacy: "settlement.minDelay",
    current: "settlementWindow.minDelaySeconds",
    suggestion: "Use `settlementWindow.minDelaySeconds` instead of `settlement.minDelay`.",
  },
  {
    legacy: "settlement.maxOpen",
    current: "settlementWindow.maxOpenSeconds",
    suggestion: "Use `settlementWindow.maxOpenSeconds` instead of `settlement.maxOpen`.",
  },
  {
    legacy: "limits.maxBatch",
    current: "capacityLimits.maxBatchSize",
    suggestion: "Use `capacityLimits.maxBatchSize` instead of `limits.maxBatch`.",
  },
  {
    legacy: "limits.maxTotal",
    current: "capacityLimits.maxTotalPayout",
    suggestion: "Use `capacityLimits.maxTotalPayout` instead of `limits.maxTotal`.",
  },
  {
    legacy: "limits.maxPerRecipient",
    current: "capacityLimits.maxPerRecipientPayout",
    suggestion: "Use `capacityLimits.maxPerRecipientPayout` instead of `limits.maxPerRecipient`.",
  },
  {
    legacy: "minReserve",
    current: "reserveRequirements.minReserveBalance",
    suggestion: "Use `reserveRequirements.minReserveBalance` instead of `minReserve`.",
  },
  {
    legacy: "audit.required",
    current: "auditSettings.auditRequired",
    suggestion: "Use `auditSettings.auditRequired` instead of `audit.required`.",
  },
  {
    legacy: "audit.retentionDays",
    current: "auditSettings.retentionDays",
    suggestion: "Use `auditSettings.retentionDays` instead of `audit.retentionDays`.",
  },
  {
    legacy: "audit.viewerRoles",
    current: "auditSettings.allowedViewerRoles",
    suggestion: "Use `auditSettings.allowedViewerRoles` instead of `audit.viewerRoles`.",
  },
];

/**
 * A legacy organization payroll policy stored at schema version 0.
 *
 * This is the pre-`CompiledPayrollPolicy` shape: a flat, human-authored policy
 * using deprecated field names and numeric (not `bigint`) monetary values.
 */
export interface LegacyOrganizationPolicy {
  /** Schema version. `0` (or absent) indicates the legacy organization format. */
  version?: number;
  /** Organization-scoped identifier for this policy. Required. */
  organizationId: string;
  policyId: string;
  /** Legacy asset split: canonical asset is `assetCode:assetIssuer` (or `native`). */
  assetCode: string;
  assetIssuer: string;
  /** Legacy settlement container — use `PayrollPolicyInput.settlementWindow`. */
  settlement: {
    /** Legacy alias for `settlementWindow.minDelaySeconds`. */
    minDelay: number;
    /** Legacy alias for `settlementWindow.maxOpenSeconds`. */
    maxOpen: number;
  };
  /** Legacy capacity container — use `PayrollPolicyInput.capacityLimits`. */
  limits: {
    maxBatch: number;
    maxTotal: number;
    maxPerRecipient: number;
  };
  /** Legacy flat reserve balance (numeric, migrated to `bigint`). */
  minReserve: number;
  /** Legacy audit block. */
  audit: {
    required: boolean;
    retentionDays: number;
    viewerRoles?: string[];
  };
  effectiveDate?: string | number;
  endDate?: string | number;
}

/** Any organization policy accepted by the migrator — legacy or already-current. */
export type OrganizationPolicyMigrationInput = LegacyOrganizationPolicy | CompiledPayrollPolicy;

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Duck-type discriminator: a value is a compiled policy when it carries the
 * current schema's `schemaVersion` and `assetId` anchors.
 */
function isCompiledPayrollPolicy(value: unknown): value is CompiledPayrollPolicy {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    "assetId" in value &&
    "policyId" in value
  );
}

/**
 * Reads a legacy numeric field, pushing an actionable migration error when the
 * value is missing or is not a finite number (so `NaN`/`Infinity` never reach a
 * `BigInt` conversion).
 */
function readLegacyNumber(
  value: unknown,
  field: string,
  errors: OrganizationPolicyMigrationError[]
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(
      new OrganizationPolicyMigrationError(
        `${field} must be a finite number on a legacy policy.`,
        OrgPolicyMigrationErrorCode.INVALID_FIELD_TYPE,
        field,
        { value }
      )
    );
    return undefined;
  }
  return value;
}

/** Coerces an already-validated finite number to `bigint` (never throws). */
function numberToBigInt(value: number | undefined): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }
  return BigInt(Math.trunc(value));
}

/** Safely narrows an unknown value to a plain object, or `undefined`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function normalizeOrganizationId(id: unknown): string | undefined {
  if (typeof id !== "string" || id.trim() === "") {
    return undefined;
  }
  return id.trim();
}

function normalizeLegacyAsset(
  assetCode: unknown,
  assetIssuer: unknown,
  field: string,
  errors: OrganizationPolicyMigrationError[]
): string | undefined {
  if (typeof assetCode !== "string" || assetCode.trim() === "") {
    errors.push(
      new OrganizationPolicyMigrationError(
        "assetCode is required on a legacy policy.",
        OrgPolicyMigrationErrorCode.MISSING_FIELD,
        "assetCode",
        { assetCode }
      )
    );
    return undefined;
  }

  const code = assetCode.trim();
  const isNative = /^native$/i.test(code) || /^xlm$/i.test(code);
  if (isNative) {
    if (assetIssuer !== undefined && assetIssuer !== null && assetIssuer !== "") {
      errors.push(
        new OrganizationPolicyMigrationError(
          "Native asset (XLM) cannot carry an issuer; drop `assetIssuer` for native policies.",
          OrgPolicyMigrationErrorCode.INVALID_ASSET,
          field,
          { assetCode, assetIssuer }
        )
      );
      return undefined;
    }
    try {
      return normalizeAssetIdentity("native").id;
    } catch (err) {
      if (err instanceof AssetIdentityError) {
        errors.push(
          new OrganizationPolicyMigrationError(
            err.message,
            OrgPolicyMigrationErrorCode.INVALID_ASSET,
            field,
            { assetIdentityErrorCode: err.code, input: "native" }
          )
        );
        return undefined;
      }
      throw err;
    }
  }

  if (typeof assetIssuer !== "string" || assetIssuer.trim() === "") {
    errors.push(
      new OrganizationPolicyMigrationError(
        "Issued assets require an `assetIssuer`.",
        OrgPolicyMigrationErrorCode.MISSING_FIELD,
        field,
        { assetCode, assetIssuer }
      )
    );
    return undefined;
  }

  const issuer = assetIssuer.trim();
  const canonical = `${code.toUpperCase()}:${issuer}`;
  try {
    return normalizeAssetIdentity(canonical).id;
  } catch (err) {
    if (err instanceof AssetIdentityError) {
      errors.push(
        new OrganizationPolicyMigrationError(
          err.message,
          OrgPolicyMigrationErrorCode.INVALID_ASSET,
          field,
          { assetIdentityErrorCode: err.code, input: canonical }
        )
      );
      return undefined;
    }
    throw err;
  }
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null;
}

function isPresent(value: unknown): boolean {
  return !isMissing(value) && !(typeof value === "string" && value.trim() === "");
}

/**
 * Detects deprecated/legacy field usages on a legacy policy and returns the
 * matching migration warnings (without mutating the input).
 */
function detectLegacyFieldWarnings(
  input: LegacyOrganizationPolicy
): OrganizationPolicyMigrationWarning[] {
  const warnings: OrganizationPolicyMigrationWarning[] = [];
  const mapping = new Map(ORG_POLICY_FIELD_MAPPINGS.map((m) => [m.legacy, m]));

  if (isPresent(input.assetCode) || isPresent(input.assetIssuer)) {
    const m = mapping.get("assetCode:assetIssuer");
    if (m)
      warnings.push({
        field: m.legacy,
        message: `Deprecated field \`${m.legacy}\` remapped to \`${m.current}\`.`,
        suggestion: m.suggestion,
      });
  }

  if (input.settlement !== undefined && typeof input.settlement === "object") {
    const legacySettlement = input.settlement as { minDelay?: unknown; maxOpen?: unknown };
    if (isPresent(legacySettlement.minDelay)) {
      const m = mapping.get("settlement.minDelay");
      if (m)
        warnings.push({
          field: m.legacy,
          message: `Deprecated field \`${m.legacy}\` remapped to \`${m.current}\`.`,
          suggestion: m.suggestion,
        });
    }
    if (isPresent(legacySettlement.maxOpen)) {
      const m = mapping.get("settlement.maxOpen");
      if (m)
        warnings.push({
          field: m.legacy,
          message: `Deprecated field \`${m.legacy}\` remapped to \`${m.current}\`.`,
          suggestion: m.suggestion,
        });
    }
  }

  if (input.limits !== undefined && typeof input.limits === "object") {
    const legacyLimits = input.limits as {
      maxBatch?: unknown;
      maxTotal?: unknown;
      maxPerRecipient?: unknown;
    };
    if (isPresent(legacyLimits.maxBatch)) {
      const m = mapping.get("limits.maxBatch");
      if (m)
        warnings.push({
          field: m.legacy,
          message: `Deprecated field \`${m.legacy}\` remapped to \`${m.current}\`.`,
          suggestion: m.suggestion,
        });
    }
    if (isPresent(legacyLimits.maxTotal)) {
      const m = mapping.get("limits.maxTotal");
      if (m)
        warnings.push({
          field: m.legacy,
          message: `Deprecated field \`${m.legacy}\` remapped to \`${m.current}\`.`,
          suggestion: m.suggestion,
        });
    }
    if (isPresent(legacyLimits.maxPerRecipient)) {
      const m = mapping.get("limits.maxPerRecipient");
      if (m)
        warnings.push({
          field: m.legacy,
          message: `Deprecated field \`${m.legacy}\` remapped to \`${m.current}\`.`,
          suggestion: m.suggestion,
        });
    }
  }

  if (isPresent(input.minReserve)) {
    const m = mapping.get("minReserve");
    if (m)
      warnings.push({
        field: m.legacy,
        message: `Deprecated field \`${m.legacy}\` remapped to \`${m.current}\`.`,
        suggestion: m.suggestion,
      });
  }

  if (input.audit !== undefined && typeof input.audit === "object") {
    const legacyAudit = input.audit as {
      required?: unknown;
      retentionDays?: unknown;
      viewerRoles?: unknown;
    };
    if (isPresent(legacyAudit.required)) {
      const m = mapping.get("audit.required");
      if (m)
        warnings.push({
          field: m.legacy,
          message: `Deprecated field \`${m.legacy}\` remapped to \`${m.current}\`.`,
          suggestion: m.suggestion,
        });
    }
    if (isPresent(legacyAudit.retentionDays)) {
      const m = mapping.get("audit.retentionDays");
      if (m)
        warnings.push({
          field: m.legacy,
          message: `Deprecated field \`${m.legacy}\` remapped to \`${m.current}\`.`,
          suggestion: m.suggestion,
        });
    }
    if (isPresent(legacyAudit.viewerRoles)) {
      const m = mapping.get("audit.viewerRoles");
      if (m)
        warnings.push({
          field: m.legacy,
          message: `Deprecated field \`${m.legacy}\` remapped to \`${m.current}\`.`,
          suggestion: m.suggestion,
        });
    }
  }

  return warnings;
}

/**
 * Remaps a legacy organization policy to the canonical `PayrollPolicyInput`
 * shape, collecting any structural/type-level errors along the way.
 *
 * Semantic coherence (settlement ordering, reserve vs. capacity, audit
 * retention, effective dates) is intentionally left to `compilePayrollPolicy`
 * so there is a single source of truth for every policy invariant.
 */
function remapLegacyOrganizationPolicy(
  input: LegacyOrganizationPolicy,
  errors: OrganizationPolicyMigrationError[]
): PayrollPolicyInput {
  const assetId = normalizeLegacyAsset(input.assetCode, input.assetIssuer, "asset", errors);

  const settlement = asRecord(input.settlement);
  if (!settlement) {
    errors.push(
      new OrganizationPolicyMigrationError(
        "settlement is required on a legacy policy.",
        OrgPolicyMigrationErrorCode.MISSING_FIELD,
        "settlement",
        {}
      )
    );
  }
  const minDelay = readLegacyNumber(settlement?.minDelay, "settlement.minDelay", errors);
  const maxOpen = readLegacyNumber(settlement?.maxOpen, "settlement.maxOpen", errors);
  const settlementWindow: SettlementWindowInput = {
    minDelaySeconds: minDelay ?? 0,
    maxOpenSeconds: maxOpen ?? 0,
  };

  const limits = asRecord(input.limits);
  if (!limits) {
    errors.push(
      new OrganizationPolicyMigrationError(
        "limits is required on a legacy policy.",
        OrgPolicyMigrationErrorCode.MISSING_FIELD,
        "limits",
        {}
      )
    );
  }
  const maxBatch = readLegacyNumber(limits?.maxBatch, "limits.maxBatch", errors);
  const maxTotal = numberToBigInt(readLegacyNumber(limits?.maxTotal, "limits.maxTotal", errors));
  const maxPerRecipient = numberToBigInt(
    readLegacyNumber(limits?.maxPerRecipient, "limits.maxPerRecipient", errors)
  );

  const capacityLimits: CapacityLimitsInput = {
    maxBatchSize: maxBatch ?? 0,
    maxTotalPayout: maxTotal ?? 0n,
    maxPerRecipientPayout: maxPerRecipient ?? 0n,
  };

  const reserveRequirements: ReserveRequirementsInput = {
    minReserveBalance:
      numberToBigInt(readLegacyNumber(input.minReserve, "minReserve", errors)) ?? 0n,
  };

  const audit = asRecord(input.audit);
  if (!audit) {
    errors.push(
      new OrganizationPolicyMigrationError(
        "audit is required on a legacy policy.",
        OrgPolicyMigrationErrorCode.MISSING_FIELD,
        "audit",
        {}
      )
    );
  }
  const auditRequired = audit?.required;
  if (typeof auditRequired !== "boolean") {
    errors.push(
      new OrganizationPolicyMigrationError(
        "audit.required must be a boolean on a legacy policy.",
        OrgPolicyMigrationErrorCode.INVALID_FIELD_TYPE,
        "audit.required",
        { value: auditRequired }
      )
    );
  }
  const retentionDays = readLegacyNumber(audit?.retentionDays, "audit.retentionDays", errors);
  const viewerRoles = audit?.viewerRoles;
  if (isPresent(viewerRoles) && !Array.isArray(viewerRoles)) {
    errors.push(
      new OrganizationPolicyMigrationError(
        "audit.viewerRoles must be an array of strings on a legacy policy.",
        OrgPolicyMigrationErrorCode.INVALID_FIELD_TYPE,
        "audit.viewerRoles",
        { value: viewerRoles }
      )
    );
  }
  const auditSettings: AuditSettingsInput = {
    auditRequired: typeof auditRequired === "boolean" ? auditRequired : false,
    retentionDays: retentionDays ?? 0,
    allowedViewerRoles: Array.isArray(viewerRoles)
      ? viewerRoles.filter((r): r is string => typeof r === "string")
      : undefined,
  };

  const policyInput: PayrollPolicyInput = {
    policyId: input.policyId,
    asset: assetId ?? input.assetCode ?? "",
    settlementWindow,
    capacityLimits,
    reserveRequirements,
    auditSettings,
    ...(input.effectiveDate !== undefined ? { effectiveDate: input.effectiveDate } : {}),
    ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
  };

  return policyInput;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Detects deprecated/legacy field usages on an organization policy migration
 * input, returning actionable warnings (without mutating the input or
 * performing a full compile).
 *
 * @example
 * const { version, warnings } = detectOrganizationPolicyMigrationIssues(legacy);
 * for (const w of warnings) console.warn(`${w.field}: ${w.suggestion}`);
 */
export function detectOrganizationPolicyMigrationIssues(input: OrganizationPolicyMigrationInput): {
  version: number;
  warnings: OrganizationPolicyMigrationWarning[];
} {
  if (isCompiledPayrollPolicy(input)) {
    return { version: input.schemaVersion ?? CURRENT_ORG_POLICY_SCHEMA_VERSION, warnings: [] };
  }

  const legacy = input as LegacyOrganizationPolicy;
  const version = legacy.version ?? LEGACY_ORG_POLICY_VERSION;
  const warnings = detectLegacyFieldWarnings(legacy);

  if (legacy.version === undefined) {
    warnings.push({
      field: "version",
      message: "Legacy policies should declare `version: 0` explicitly; assumed `0`.",
      suggestion: "Add `version: 0` to legacy organization policies.",
    });
  }

  return { version, warnings };
}

/**
 * Builds the {@link OrganizationPolicyMigrationPlan} describing which legacy
 * fields were detected on a legacy policy.
 */
export function buildOrganizationPolicyMigrationPlan(
  input: OrganizationPolicyMigrationInput
): OrganizationPolicyMigrationPlan {
  if (isCompiledPayrollPolicy(input)) {
    const version = input.schemaVersion ?? CURRENT_ORG_POLICY_SCHEMA_VERSION;
    return {
      fromVersion: version,
      toVersion: CURRENT_ORG_POLICY_SCHEMA_VERSION,
      fieldMappings: [],
      appliedMappings: [],
    };
  }

  const legacy = input as LegacyOrganizationPolicy;
  const version = legacy.version ?? LEGACY_ORG_POLICY_VERSION;
  const applied = detectLegacyFieldWarnings(legacy).map((w) => {
    const m = ORG_POLICY_FIELD_MAPPINGS.find((m) => m.legacy === w.field);
    return m ?? { legacy: w.field, current: "policy", suggestion: w.suggestion };
  });

  return {
    fromVersion: version,
    toVersion: CURRENT_ORG_POLICY_SCHEMA_VERSION,
    fieldMappings: ORG_POLICY_FIELD_MAPPINGS,
    appliedMappings: applied,
  };
}

/**
 * Validates that an organization policy can be migrated to the current
 * {@link CompiledPayrollPolicy} schema and, when valid, returns the compiled
 * migrated policy.
 *
 * - Already-current policies (`schemaVersion === 1`) pass through with no
 *   migration warnings and are echoed back as `migratedPolicy`.
 * - Legacy policies (`version === 0` or absent) have deprecated fields detected,
 *   remapped to {@link PayrollPolicyInput}, and re-compiled via
 *   {@link compilePayrollPolicy} so every existing invariant is enforced.
 * - All problems (structural, type, coherence) are collected and returned
 *   together rather than failing on the first one.
 *
 * @example
 * const result = validateOrganizationPolicyMigration(legacy, { now: Date.now() });
 * if (result.valid) {
 *   await contract.setPolicy(result.migratedPolicy);
 * } else {
 *   for (const e of result.errors) console.error(`${e.field}: ${e.message}`);
 * }
 */
export function validateOrganizationPolicyMigration(
  input: OrganizationPolicyMigrationInput,
  options: OrganizationPolicyMigrationOptions = {}
): OrganizationPolicyMigrationValidationResult {
  const errors: OrganizationPolicyMigrationError[] = [];
  const compileOptions = { now: options.now };

  // Already-current (v1) policy — nothing to migrate; validate coherence only.
  if (isCompiledPayrollPolicy(input)) {
    const version = input.schemaVersion ?? CURRENT_ORG_POLICY_SCHEMA_VERSION;
    if (version !== CURRENT_ORG_POLICY_SCHEMA_VERSION) {
      errors.push(
        new OrganizationPolicyMigrationError(
          `Unsupported policy schema version ${version}; expected ${CURRENT_ORG_POLICY_SCHEMA_VERSION}.`,
          OrgPolicyMigrationErrorCode.INVALID_SCHEMA_VERSION,
          "schemaVersion",
          { schemaVersion: version }
        )
      );
      return {
        valid: false,
        organizationId: input.policyId,
        version,
        errors,
        warnings: [],
        migrationPlan: buildOrganizationPolicyMigrationPlan(input),
      };
    }

    return {
      valid: true,
      organizationId: input.policyId,
      version,
      migrationPlan: buildOrganizationPolicyMigrationPlan(input),
      migratedPolicy: input,
      warnings: [],
      errors,
    };
  }

  // Legacy (v0) policy.
  const legacy = input as LegacyOrganizationPolicy;
  const version = legacy.version ?? LEGACY_ORG_POLICY_VERSION;

  if (legacy.version !== undefined && legacy.version !== LEGACY_ORG_POLICY_VERSION) {
    errors.push(
      new OrganizationPolicyMigrationError(
        `Unsupported legacy policy version ${legacy.version}; expected ${LEGACY_ORG_POLICY_VERSION} or omitted (legacy v0).`,
        OrgPolicyMigrationErrorCode.INVALID_SCHEMA_VERSION,
        "version",
        { version: legacy.version }
      )
    );
    const organizationId = normalizeOrganizationId(legacy.organizationId) ?? "";
    return {
      valid: false,
      organizationId,
      version: legacy.version,
      errors,
      warnings: [],
      migrationPlan: buildOrganizationPolicyMigrationPlan(legacy),
    };
  }

  const organizationId = normalizeOrganizationId(legacy.organizationId);
  if (!organizationId) {
    errors.push(
      new OrganizationPolicyMigrationError(
        "organizationId is required and cannot be empty.",
        OrgPolicyMigrationErrorCode.INVALID_ORGANIZATION_ID,
        "organizationId",
        { organizationId: legacy.organizationId }
      )
    );
  }

  if (!isPresent(legacy.policyId)) {
    errors.push(
      new OrganizationPolicyMigrationError(
        "policyId is required.",
        OrgPolicyMigrationErrorCode.MISSING_FIELD,
        "policyId",
        { policyId: legacy.policyId }
      )
    );
  }

  const warnings = detectLegacyFieldWarnings(legacy);
  if (legacy.version === undefined) {
    warnings.push({
      field: "version",
      message: "Legacy policies should declare `version: 0` explicitly; assumed `0`.",
      suggestion: "Add `version: 0` to legacy organization policies.",
    });
  }

  // If the organization identifier is missing, there is nothing coherent to compile.
  if (errors.length > 0) {
    return {
      valid: false,
      organizationId: organizationId ?? "",
      version,
      errors,
      warnings,
      migrationPlan: buildOrganizationPolicyMigrationPlan(legacy),
    };
  }

  const policyInput = remapLegacyOrganizationPolicy(legacy, errors);

  // Structural/type errors short-circuit before compilation.
  if (errors.length > 0) {
    return {
      valid: false,
      organizationId: organizationId as string,
      version,
      errors,
      warnings,
      migrationPlan: buildOrganizationPolicyMigrationPlan(legacy),
    };
  }

  const compileResult = compilePayrollPolicy(policyInput, compileOptions);
  if (!compileResult.ok) {
    for (const err of compileResult.errors) {
      errors.push(
        new OrganizationPolicyMigrationError(
          err.message,
          OrgPolicyMigrationErrorCode.COMPILE_ERROR,
          err.field,
          { policyCompileCode: err.code, ...err.context }
        )
      );
    }
    return {
      valid: false,
      organizationId: organizationId as string,
      version,
      errors,
      warnings,
      migrationPlan: buildOrganizationPolicyMigrationPlan(legacy),
    };
  }

  return {
    valid: true,
    organizationId: organizationId as string,
    version,
    migrationPlan: buildOrganizationPolicyMigrationPlan(legacy),
    migratedPolicy: compileResult.value,
    warnings,
    errors,
  };
}

/**
 * Migrating alias for {@link validateOrganizationPolicyMigration}.
 *
 * Performs the full migration (remap + compile) and returns the same
 * {@link OrganizationPolicyMigrationValidationResult}.
 */
export function migrateOrganizationPolicy(
  input: OrganizationPolicyMigrationInput,
  options: OrganizationPolicyMigrationOptions = {}
): OrganizationPolicyMigrationValidationResult {
  return validateOrganizationPolicyMigration(input, options);
}

/**
 * Throwing variant of {@link validateOrganizationPolicyMigration}.
 *
 * @throws {OrganizationPolicyMigrationError} on any migration/compilation
 *   failure, carrying the first error's `code`/`field` and the full list on
 *   `error.context.allErrors`.
 */
export function assertOrganizationPolicyMigration(
  input: OrganizationPolicyMigrationInput,
  options: OrganizationPolicyMigrationOptions = {}
): CompiledPayrollPolicy {
  const result = validateOrganizationPolicyMigration(input, options);
  if (!result.valid) {
    const [first, ...rest] = result.errors;
    first.context.allErrors = result.errors.map((e) => ({
      code: e.code,
      field: e.field,
      message: e.message,
    }));
    if (rest.length > 0) {
      first.message = `${first.message} (and ${rest.length} more migration error(s); see error.context.allErrors)`;
    }
    throw first;
  }
  return result.migratedPolicy as CompiledPayrollPolicy;
}
