import {
  checkContractRevisionCompatibility,
  SDK_SUPPORTED_CONTRACT_REVISION_RANGE,
  ValidationError,
} from "../src";

describe("checkContractRevisionCompatibility", () => {
  it("reports compatible when the connected revision is within the supported range (main path)", () => {
    const warning = checkContractRevisionCompatibility(SDK_SUPPORTED_CONTRACT_REVISION_RANGE.min);

    expect(warning.status).toBe("compatible");
    expect(warning.compatible).toBe(true);
    expect(warning.code).toBe("CONTRACT_REVISION_COMPATIBLE");
    expect(warning.connectedRevision).toBe(SDK_SUPPORTED_CONTRACT_REVISION_RANGE.min);
    expect(warning.supportedRange).toEqual(SDK_SUPPORTED_CONTRACT_REVISION_RANGE);
  });

  it("warns when the connected revision is below the supported range", () => {
    const range = { min: 5, max: 10 };
    const warning = checkContractRevisionCompatibility(3, range);

    expect(warning.status).toBe("outdated");
    expect(warning.compatible).toBe(false);
    expect(warning.code).toBe("CONTRACT_REVISION_OUTDATED");
    expect(warning.message).toContain("older than");
    expect(warning.connectedRevision).toBe(3);
  });

  it("warns when the connected revision is above the supported range", () => {
    const range = { min: 1, max: 3 };
    const warning = checkContractRevisionCompatibility(4, range);

    expect(warning.status).toBe("ahead");
    expect(warning.compatible).toBe(false);
    expect(warning.code).toBe("CONTRACT_REVISION_AHEAD");
    expect(warning.message).toContain("newer than");
    expect(warning.connectedRevision).toBe(4);
  });

  it("accepts numeric strings and bigints as the connected revision", () => {
    const range = { min: 1, max: 3 };
    expect(checkContractRevisionCompatibility("2", range).status).toBe("compatible");
    expect(checkContractRevisionCompatibility(2n, range).status).toBe("compatible");
  });

  it("treats an unparseable or negative revision as unknown (edge case) without throwing", () => {
    for (const bad of [undefined, null, "not-a-number", -1, NaN, 1.5, {}]) {
      const warning = checkContractRevisionCompatibility(bad);
      expect(warning.status).toBe("unknown");
      expect(warning.compatible).toBe(false);
      expect(warning.code).toBe("CONTRACT_REVISION_UNREADABLE");
      expect(warning.connectedRevision).toBeUndefined();
    }
  });

  it("never echoes recipient, amount, or asset values in the warning message", () => {
    const warning = checkContractRevisionCompatibility(999, { min: 1, max: 3 });
    const serialized = JSON.stringify(warning);
    expect(serialized).not.toMatch(/recipient|amount|asset|employee/i);
  });

  it("throws ValidationError for a malformed supported range", () => {
    expect(() => checkContractRevisionCompatibility(1, { min: 5, max: 1 })).toThrow(
      ValidationError
    );
    expect(() => checkContractRevisionCompatibility(1, { min: -1, max: 1 })).toThrow(
      ValidationError
    );
  });
});
