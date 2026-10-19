import {
  validateOrganizationPolicyMigration,
  migrateOrganizationPolicy,
  assertOrganizationPolicyMigration,
  detectOrganizationPolicyMigrationIssues,
  buildOrganizationPolicyMigrationPlan,
  OrganizationPolicyMigrationError,
  OrgPolicyMigrationErrorCode,
  LEGACY_ORG_POLICY_VERSION,
  CURRENT_ORG_POLICY_SCHEMA_VERSION,
  type LegacyOrganizationPolicy,
  type OrganizationPolicyMigrationValidationResult,
} from "../src/policy/migration";
import { type CompiledPayrollPolicy } from "../src/policy/types";

/** A valid issuer used to exercise the `CODE:ISSUER` asset path. */
const VALID_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/** A fixed reference clock so effective-date checks are deterministic. */
const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const FUTURE_ISO = "2026-10-01T00:00:00.000Z";
const LATER_ISO = "2027-10-01T00:00:00.000Z";

/** A legacy (v0) organization policy that migrates cleanly to the current schema. */
const VALID_LEGACY_POLICY: LegacyOrganizationPolicy = {
  version: 0,
  organizationId: "org_acme",
  policyId: "default",
  assetCode: "native",
  assetIssuer: "",
  settlement: { minDelay: 60, maxOpen: 3600 },
  limits: { maxBatch: 500, maxTotal: 1_000_000, maxPerRecipient: 50_000 },
  minReserve: 100_000,
  audit: { required: true, retentionDays: 365, viewerRoles: ["compliance_reviewer"] },
};

function validate(
  input: LegacyOrganizationPolicy,
  now?: number
): OrganizationPolicyMigrationValidationResult {
  return validateOrganizationPolicyMigration(input, now !== undefined ? { now } : {});
}

/** Asserts a migration is valid and narrows the type to the compiled policy. */
function expectMigrated(
  result: OrganizationPolicyMigrationValidationResult
): CompiledPayrollPolicy {
  expect(result.valid).toBe(true);
  if (!result.valid) {
    throw new Error(
      `expected a valid migration, got: ${result.errors.map((e) => e.message).join("; ")}`
    );
  }
  return result.migratedPolicy as CompiledPayrollPolicy;
}

describe("organization policy migration — legacy success paths", () => {
  it("migrates a valid legacy policy to the current compiled schema", () => {
    const result = validate(VALID_LEGACY_POLICY);
    const migrated = expectMigrated(result);

    expect(migrated.policyId).toBe("default");
    expect(migrated.assetId).toBe("native");
    expect(migrated.schemaVersion).toBe(CURRENT_ORG_POLICY_SCHEMA_VERSION);
    expect(migrated.settlement).toEqual({ minDelaySeconds: 60, maxOpenSeconds: 3600 });
    expect(migrated.capacity).toEqual({
      maxBatchSize: 500,
      maxTotalPayout: "1000000",
      maxPerRecipientPayout: "50000",
    });
    expect(migrated.reserve).toEqual({ minReserveBalance: "100000", strict: true });
    expect(migrated.audit).toEqual({
      auditRequired: true,
      retentionDays: 365,
      allowedViewerRoles: ["compliance_reviewer"],
    });
  });

  it("carries the organizationId and version onto the result", () => {
    const result = validate(VALID_LEGACY_POLICY);
    expect(result.valid).toBe(true);
    expect(result.organizationId).toBe("org_acme");
    expect(result.version).toBe(LEGACY_ORG_POLICY_VERSION);
    expect(result.errors).toHaveLength(0);
  });

  it("describes the migration from v0 to v1 in the plan", () => {
    const result = validate(VALID_LEGACY_POLICY);
    const plan = result.migrationPlan;
    expect(plan).toBeDefined();
    expect(plan?.fromVersion).toBe(0);
    expect(plan?.toVersion).toBe(1);
    expect(plan?.appliedMappings.some((m) => m.legacy === "settlement.minDelay")).toBe(true);
    expect(plan?.appliedMappings.some((m) => m.legacy === "minReserve")).toBe(true);
  });

  it("produces a JSON-serializable compiled policy (bigints become strings)", () => {
    const migrated = expectMigrated(validate(VALID_LEGACY_POLICY));
    expect(() => JSON.stringify(migrated)).not.toThrow();
    expect(typeof migrated.capacity.maxTotalPayout).toBe("string");
    expect(typeof migrated.reserve.minReserveBalance).toBe("string");
  });

  it("defaults reserve.strict to true and normalizes an empty viewerRoles list", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      audit: { required: false, retentionDays: 0 },
    };
    const migrated = expectMigrated(validate(input));
    expect(migrated.reserve.strict).toBe(true);
    expect(migrated.audit.allowedViewerRoles).toEqual([]);
  });

  it("is deterministic for identical input", () => {
    const a = validate(VALID_LEGACY_POLICY);
    const b = validate(VALID_LEGACY_POLICY);
    expect(a).toEqual(b);
  });
});

describe("organization policy migration — asset handling", () => {
  it("combines a legacy code + issuer into a canonical CODE:ISSUER asset id", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      assetCode: "usdc",
      assetIssuer: VALID_ISSUER,
    };
    const migrated = expectMigrated(validate(input));
    expect(migrated.assetId).toBe(`USDC:${VALID_ISSUER}`);
  });

  it("normalizes XLM to the reserved native asset id", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      assetCode: "XLM",
      assetIssuer: "",
    };
    const migrated = expectMigrated(validate(input));
    expect(migrated.assetId).toBe("native");
  });

  it("rejects a native asset that incorrectly carries an issuer", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      assetCode: "native",
      assetIssuer: VALID_ISSUER,
    };
    const result = validate(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === OrgPolicyMigrationErrorCode.INVALID_ASSET)).toBe(
      true
    );
  });

  it("rejects an issued asset with a missing issuer", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      assetCode: "usdc",
      assetIssuer: "",
    };
    const result = validate(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === OrgPolicyMigrationErrorCode.MISSING_FIELD)).toBe(
      true
    );
  });

  it("rejects an invalid issuer address with an actionable INVALID_ASSET error", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      assetCode: "usdc",
      assetIssuer: "NOT-A-VALID-G-ADDRESS",
    };
    const result = validate(input);
    expect(result.valid).toBe(false);
    const assetError = result.errors.find(
      (e) => e.code === OrgPolicyMigrationErrorCode.INVALID_ASSET
    );
    expect(assetError).toBeDefined();
    expect(assetError?.field).toBe("asset");
  });
});

describe("organization policy migration — effective dates", () => {
  it("remaps and compiles an effectiveDate/endDate pair", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      effectiveDate: FUTURE_ISO,
      endDate: LATER_ISO,
    };
    const migrated = expectMigrated(validate(input, NOW));
    expect(migrated.effectiveDateMs).toBe(Date.parse(FUTURE_ISO));
    expect(migrated.endDateMs).toBe(Date.parse(LATER_ISO));
  });

  it("rejects a past effectiveDate via the compiler (COMPILE_ERROR)", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      effectiveDate: "2020-01-01T00:00:00.000Z",
    };
    const result = validate(input, NOW);
    expect(result.valid).toBe(false);
    const dateError = result.errors.find((e) => e.field === "effectiveDate");
    expect(dateError).toBeDefined();
    expect(dateError?.code).toBe(OrgPolicyMigrationErrorCode.COMPILE_ERROR);
    expect(dateError?.message).toContain("must not be in the past");
  });

  it("uses the injected reference clock rather than the wall clock", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      effectiveDate: "2020-01-01T00:00:00.000Z",
    };
    // Compiling against a 2019 clock makes the "future" date valid.
    const migrated = expectMigrated(validate(input, Date.parse("2019-06-01T00:00:00.000Z")));
    expect(migrated.effectiveDateMs).toBe(Date.parse("2020-01-01T00:00:00.000Z"));
  });
});

describe("organization policy migration — already-current policies", () => {
  it("passes a current compiled policy through with no migration warnings", () => {
    const current = expectMigrated(validate(VALID_LEGACY_POLICY));
    const result = validateOrganizationPolicyMigration(current);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.migratedPolicy).toEqual(current);
    expect(result.version).toBe(CURRENT_ORG_POLICY_SCHEMA_VERSION);
  });

  it("builds an empty migration plan for a current compiled policy", () => {
    const current = expectMigrated(validate(VALID_LEGACY_POLICY));
    const plan = buildOrganizationPolicyMigrationPlan(current);
    expect(plan.fromVersion).toBe(1);
    expect(plan.toVersion).toBe(1);
    expect(plan.appliedMappings).toHaveLength(0);
  });
});

describe("organization policy migration — version and identity validation", () => {
  it("assumes v0 when version is omitted and emits a warning", () => {
    const input: LegacyOrganizationPolicy = { ...VALID_LEGACY_POLICY, version: undefined };
    const result = validate(input);
    expectMigrated(result);
    expect(result.version).toBe(0);
    expect(result.warnings.some((w) => w.field === "version")).toBe(true);
  });

  it("rejects an unsupported version with INVALID_SCHEMA_VERSION", () => {
    const input: LegacyOrganizationPolicy = { ...VALID_LEGACY_POLICY, version: 5 };
    const result = validate(input);
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.code === OrgPolicyMigrationErrorCode.INVALID_SCHEMA_VERSION
    );
    expect(err).toBeDefined();
    expect(err?.field).toBe("version");
  });

  it("rejects a missing/empty organizationId with INVALID_ORGANIZATION_ID", () => {
    const result = validate({ ...VALID_LEGACY_POLICY, organizationId: "   " });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === OrgPolicyMigrationErrorCode.INVALID_ORGANIZATION_ID)
    ).toBe(true);
  });

  it("rejects a missing policyId with MISSING_FIELD", () => {
    const result = validate({ ...VALID_LEGACY_POLICY, policyId: "" });
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.code === OrgPolicyMigrationErrorCode.MISSING_FIELD && e.field === "policyId"
    );
    expect(err).toBeDefined();
  });
});

describe("organization policy migration — structural & type failures", () => {
  it("rejects a missing settlement container", () => {
    const input = {
      ...VALID_LEGACY_POLICY,
      settlement: undefined,
    } as unknown as LegacyOrganizationPolicy;
    const result = validate(input);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === OrgPolicyMigrationErrorCode.MISSING_FIELD && e.field === "settlement"
      )
    ).toBe(true);
  });

  it("rejects a non-numeric legacy monetary value with INVALID_FIELD_TYPE", () => {
    const input = {
      ...VALID_LEGACY_POLICY,
      limits: { ...VALID_LEGACY_POLICY.limits, maxTotal: "1000000" },
    } as unknown as LegacyOrganizationPolicy;
    const result = validate(input);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === OrgPolicyMigrationErrorCode.INVALID_FIELD_TYPE && e.field === "limits.maxTotal"
      )
    ).toBe(true);
  });

  it("rejects a non-boolean audit.required with INVALID_FIELD_TYPE", () => {
    const input = {
      ...VALID_LEGACY_POLICY,
      audit: { required: "yes", retentionDays: 365 },
    } as unknown as LegacyOrganizationPolicy;
    const result = validate(input);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === OrgPolicyMigrationErrorCode.INVALID_FIELD_TYPE && e.field === "audit.required"
      )
    ).toBe(true);
  });
});

describe("organization policy migration — coherence failures (via compiler)", () => {
  it("rejects an inverted settlement window", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      settlement: { minDelay: 3600, maxOpen: 60 },
    };
    const result = validate(input);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "settlementWindow");
    expect(err).toBeDefined();
    expect(err?.code).toBe(OrgPolicyMigrationErrorCode.COMPILE_ERROR);
  });

  it("rejects a reserve that exceeds the total payout capacity", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      minReserve: 2_000_000,
    };
    const result = validate(input);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "reserveRequirements.minReserveBalance");
    expect(err).toBeDefined();
    expect(err?.code).toBe(OrgPolicyMigrationErrorCode.COMPILE_ERROR);
  });

  it("rejects auditRequired with zero retention days", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      audit: { required: true, retentionDays: 0 },
    };
    const result = validate(input);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "auditSettings.retentionDays");
    expect(err).toBeDefined();
    expect(err?.code).toBe(OrgPolicyMigrationErrorCode.COMPILE_ERROR);
  });

  it("collects multiple coherence failures together", () => {
    const input: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      settlement: { minDelay: 3600, maxOpen: 60 },
      minReserve: 2_000_000,
    };
    const result = validate(input);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("organization policy migration — warnings & issue detection", () => {
  it("emits a deprecation warning for every remapped legacy field", () => {
    const result = validate(VALID_LEGACY_POLICY);
    expectMigrated(result);
    const fields = result.warnings.map((w) => w.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        "assetCode:assetIssuer",
        "settlement.minDelay",
        "settlement.maxOpen",
        "limits.maxBatch",
        "limits.maxTotal",
        "limits.maxPerRecipient",
        "minReserve",
        "audit.required",
        "audit.retentionDays",
        "audit.viewerRoles",
      ])
    );
  });

  it("provides a concrete suggestion on each deprecation warning", () => {
    const result = validate(VALID_LEGACY_POLICY);
    const warning = result.warnings.find((w) => w.field === "minReserve");
    expect(warning?.suggestion).toContain("reserveRequirements.minReserveBalance");
  });

  it("detects issues without compiling (works on policies that fail to compile)", () => {
    const broken: LegacyOrganizationPolicy = {
      ...VALID_LEGACY_POLICY,
      settlement: { minDelay: 3600, maxOpen: 60 },
    };
    const detected = detectOrganizationPolicyMigrationIssues(broken);
    expect(detected.version).toBe(0);
    expect(detected.warnings.some((w) => w.field === "settlement.minDelay")).toBe(true);
  });

  it("returns no warnings for a current compiled policy", () => {
    const current = expectMigrated(validate(VALID_LEGACY_POLICY));
    const detected = detectOrganizationPolicyMigrationIssues(current);
    expect(detected.warnings).toHaveLength(0);
    expect(detected.version).toBe(1);
  });
});

describe("migrateOrganizationPolicy & assertOrganizationPolicyMigration", () => {
  it("migrateOrganizationPolicy behaves identically to validateOrganizationPolicyMigration", () => {
    const validated = validate(VALID_LEGACY_POLICY);
    const migrated = migrateOrganizationPolicy(VALID_LEGACY_POLICY);
    expect(migrated).toEqual(validated);
  });

  it("assertOrganizationPolicyMigration returns the compiled policy on success", () => {
    const compiled = assertOrganizationPolicyMigration(VALID_LEGACY_POLICY);
    expect(compiled.policyId).toBe("default");
    expect(compiled.schemaVersion).toBe(1);
  });

  it("assertOrganizationPolicyMigration throws a structured error on failure", () => {
    const input: LegacyOrganizationPolicy = { ...VALID_LEGACY_POLICY, organizationId: "" };
    expect(() => assertOrganizationPolicyMigration(input)).toThrow(
      OrganizationPolicyMigrationError
    );
    try {
      assertOrganizationPolicyMigration(input);
      throw new Error("expected throw");
    } catch (err) {
      const migrationError = err as OrganizationPolicyMigrationError;
      expect(migrationError).toBeInstanceOf(OrganizationPolicyMigrationError);
      expect(migrationError.code).toBe(OrgPolicyMigrationErrorCode.INVALID_ORGANIZATION_ID);
      expect(Array.isArray(migrationError.context.allErrors)).toBe(true);
    }
  });
});
