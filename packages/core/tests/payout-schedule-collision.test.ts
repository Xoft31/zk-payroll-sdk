import {
  detectPayoutScheduleCollisions,
  assertNoPayoutScheduleCollision,
  findPayoutScheduleCollisions,
  filterNonCollidingPayoutSchedules,
  isPayoutScheduleColliding,
  normalizePayoutScheduleEntry,
  redactRecipientAddress,
  redactScheduleId,
  PayoutScheduleCollisionError,
  type PayoutScheduleEntry,
} from "../src/schedules/payoutScheduleCollision";

describe("Payout Schedule Collision Detection", () => {
  const BASE_TIME = Date.parse("2026-10-01T09:00:00.000Z");
  const ALICE = "GAA111111111111111111111111111111111111111111111111111111111ALICE";
  const BOB = "GBB22222222222222222222222222222222222222222222222222222222222BOB";

  describe("redactRecipientAddress & redactScheduleId", () => {
    it("redacts standard recipient addresses preserving first and last 3 characters", () => {
      expect(redactRecipientAddress(ALICE)).toBe("GAA***ICE");
      expect(redactRecipientAddress("short")).toBe("[REDACTED_RECIPIENT]");
      expect(redactRecipientAddress("")).toBe("[ANONYMOUS_RECIPIENT]");
      expect(redactRecipientAddress(undefined)).toBe("[ANONYMOUS_RECIPIENT]");
    });

    it("redacts schedule IDs preserving first and last 3 characters", () => {
      expect(redactScheduleId("sched-oct-01")).toBe("sch***-01");
      expect(redactScheduleId("abc")).toBe("[SCHEDULE_REDACTED]");
      expect(redactScheduleId("")).toBe("[ANONYMOUS_SCHEDULE]");
      expect(redactScheduleId(undefined)).toBe("[ANONYMOUS_SCHEDULE]");
    });
  });

  describe("normalizePayoutScheduleEntry", () => {
    it("normalizes a valid schedule entry with numeric timestamp and string amount", () => {
      const entry: PayoutScheduleEntry = {
        scheduleId: "sched-1",
        recipient: ALICE,
        asset: "USDC",
        executionTimestamp: BASE_TIME,
        amount: "5000000000",
        periodId: "2026-10",
      };

      const { schedule, violation } = normalizePayoutScheduleEntry(entry);
      expect(violation).toBeUndefined();
      expect(schedule).toBeDefined();
      expect(schedule?.scheduleId).toBe("sched-1");
      expect(schedule?.recipient).toBe(ALICE);
      expect(schedule?.asset).toBe("USDC");
      expect(schedule?.executionTimestampMs).toBe(BASE_TIME);
      expect(schedule?.executionDateIso).toBe("2026-10-01T09:00:00.000Z");
      expect(schedule?.amount).toBe(5000000000n);
      expect(schedule?.periodId).toBe("2026-10");
    });

    it("accepts ISO string and Date objects for timestamps", () => {
      const dateObj = new Date("2026-10-05T12:00:00.000Z");
      const { schedule: s1 } = normalizePayoutScheduleEntry({
        scheduleId: "sched-iso",
        recipient: ALICE,
        asset: "XLM",
        executionTimestamp: "2026-10-05T12:00:00.000Z",
      });
      const { schedule: s2 } = normalizePayoutScheduleEntry({
        scheduleId: "sched-date",
        recipient: ALICE,
        asset: "XLM",
        executionTimestamp: dateObj,
      });

      expect(s1?.executionTimestampMs).toBe(dateObj.getTime());
      expect(s2?.executionTimestampMs).toBe(dateObj.getTime());
    });

    it("rejects empty or whitespace schedule ID", () => {
      const { violation } = normalizePayoutScheduleEntry({
        scheduleId: "   ",
        recipient: ALICE,
        asset: "USDC",
        executionTimestamp: BASE_TIME,
      });

      expect(violation).toBeDefined();
      expect(violation?.code).toBe("INVALID_SCHEDULE_ID");
      expect(violation?.suggestedFix).toBeDefined();
    });

    it("rejects missing or empty recipient", () => {
      const { violation } = normalizePayoutScheduleEntry({
        scheduleId: "sched-1",
        recipient: "",
        asset: "USDC",
        executionTimestamp: BASE_TIME,
      });

      expect(violation).toBeDefined();
      expect(violation?.code).toBe("INVALID_RECIPIENT");
    });

    it("rejects invalid or unparseable executionTimestamp", () => {
      const { violation } = normalizePayoutScheduleEntry({
        scheduleId: "sched-1",
        recipient: ALICE,
        asset: "USDC",
        executionTimestamp: "invalid-date",
      });

      expect(violation).toBeDefined();
      expect(violation?.code).toBe("INVALID_TIMESTAMP");
    });

    it("rejects negative or malformed amounts when validateAmount is true", () => {
      const negativeResult = normalizePayoutScheduleEntry({
        scheduleId: "sched-1",
        recipient: ALICE,
        asset: "USDC",
        executionTimestamp: BASE_TIME,
        amount: "-1000",
      });
      expect(negativeResult.violation?.code).toBe("INVALID_AMOUNT");

      const malformedResult = normalizePayoutScheduleEntry({
        scheduleId: "sched-1",
        recipient: ALICE,
        asset: "USDC",
        executionTimestamp: BASE_TIME,
        amount: "123.45.67",
      });
      expect(malformedResult.violation?.code).toBe("INVALID_AMOUNT");
    });
  });

  describe("detectPayoutScheduleCollisions", () => {
    it("returns valid report for empty or non-colliding distinct schedules", () => {
      const reportEmpty = detectPayoutScheduleCollisions([]);
      expect(reportEmpty.isValid).toBe(true);
      expect(reportEmpty.violations).toHaveLength(0);
      expect(reportEmpty.summary.validCount).toBe(0);

      const schedules: PayoutScheduleEntry[] = [
        {
          scheduleId: "sched-1",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
        {
          scheduleId: "sched-2",
          recipient: BOB,
          asset: "USDC",
          executionTimestamp: BASE_TIME, // Same time, but different recipient -> OK!
        },
        {
          scheduleId: "sched-3",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME + 86400000, // Same recipient, next day -> OK!
        },
      ];

      const report = detectPayoutScheduleCollisions(schedules);
      expect(report.isValid).toBe(true);
      expect(report.violations).toHaveLength(0);
      expect(report.summary.totalEntries).toBe(3);
      expect(report.summary.hasCollisions).toBe(false);
    });

    it("detects exact timestamp collisions for the same recipient and asset", () => {
      const schedules: PayoutScheduleEntry[] = [
        {
          scheduleId: "sched-alice-1",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
        {
          scheduleId: "sched-alice-2",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
      ];

      const report = detectPayoutScheduleCollisions(schedules);
      expect(report.isValid).toBe(false);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0].code).toBe("EXACT_TIMESTAMP_COLLISION");
      expect(report.violations[0].scheduleId).toBe("sched-alice-1");
      expect(report.violations[0].conflictingScheduleId).toBe("sched-alice-2");
      expect(report.violations[0].redactedRecipient).toBe("GAA***ICE");
      expect(report.summary.collisionCount).toBe(1);
    });

    it("allows same recipient and same timestamp if assets differ and matchAsset is true", () => {
      const schedules: PayoutScheduleEntry[] = [
        {
          scheduleId: "sched-usdc",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
        {
          scheduleId: "sched-xlm",
          recipient: ALICE,
          asset: "XLM",
          executionTimestamp: BASE_TIME,
        },
      ];

      const report = detectPayoutScheduleCollisions(schedules, { matchAsset: true });
      expect(report.isValid).toBe(true);
      expect(report.violations).toHaveLength(0);
    });

    it("detects collision across different assets when matchAsset is false", () => {
      const schedules: PayoutScheduleEntry[] = [
        {
          scheduleId: "sched-usdc",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
        {
          scheduleId: "sched-xlm",
          recipient: ALICE,
          asset: "XLM",
          executionTimestamp: BASE_TIME,
        },
      ];

      const report = detectPayoutScheduleCollisions(schedules, { matchAsset: false });
      expect(report.isValid).toBe(false);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0].code).toBe("EXACT_TIMESTAMP_COLLISION");
    });

    it("detects minimum interval spacing collisions (minIntervalMs)", () => {
      const ONE_HOUR_MS = 3600000;
      const schedules: PayoutScheduleEntry[] = [
        {
          scheduleId: "sched-1",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
        {
          scheduleId: "sched-2",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME + 1800000, // 30 minutes later
        },
      ];

      const report = detectPayoutScheduleCollisions(schedules, {
        minIntervalMs: ONE_HOUR_MS,
      });

      expect(report.isValid).toBe(false);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0].code).toBe("MIN_INTERVAL_COLLISION");
      expect(report.violations[0].timeDeltaMs).toBe(1800000);
      expect(report.violations[0].minIntervalMs).toBe(ONE_HOUR_MS);
    });

    it("passes when schedule separation equals or exceeds minIntervalMs", () => {
      const ONE_HOUR_MS = 3600000;
      const schedules: PayoutScheduleEntry[] = [
        {
          scheduleId: "sched-1",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
        {
          scheduleId: "sched-2",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME + ONE_HOUR_MS, // Exactly 1 hour
        },
      ];

      const report = detectPayoutScheduleCollisions(schedules, {
        minIntervalMs: ONE_HOUR_MS,
      });

      expect(report.isValid).toBe(true);
      expect(report.violations).toHaveLength(0);
    });

    it("detects period-based disbursement collision when enforceUniquePerPeriod is enabled", () => {
      const schedules: PayoutScheduleEntry[] = [
        {
          scheduleId: "sched-period-1",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
          periodId: "2026-10",
        },
        {
          scheduleId: "sched-period-2",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME + 86400000 * 5, // 5 days later
          periodId: "2026-10",
        },
      ];

      const report = detectPayoutScheduleCollisions(schedules, {
        enforceUniquePerPeriod: true,
      });

      expect(report.isValid).toBe(false);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0].code).toBe("PERIOD_DISBURSEMENT_COLLISION");
      expect(report.violations[0].periodId).toBe("2026-10");
    });

    it("ignores cancelled status schedules by default", () => {
      const schedules: PayoutScheduleEntry[] = [
        {
          scheduleId: "sched-active",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
          status: "scheduled",
        },
        {
          scheduleId: "sched-cancelled",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
          status: "cancelled",
        },
      ];

      const report = detectPayoutScheduleCollisions(schedules);
      expect(report.isValid).toBe(true);
      expect(report.violations).toHaveLength(0);
    });

    it("detects duplicate schedule identifiers", () => {
      const schedules: PayoutScheduleEntry[] = [
        {
          scheduleId: "duplicate-id-1",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
        {
          scheduleId: "duplicate-id-1",
          recipient: BOB,
          asset: "USDC",
          executionTimestamp: BASE_TIME + 500000,
        },
      ];

      const report = detectPayoutScheduleCollisions(schedules);
      expect(report.isValid).toBe(false);
      expect(report.summary.duplicateIdCount).toBe(1);
      expect(report.violations.some((v) => v.code === "DUPLICATE_SCHEDULE_ID")).toBe(true);
    });
  });

  describe("assertNoPayoutScheduleCollision", () => {
    it("does not throw when schedules are valid and free of collisions", () => {
      const schedules: PayoutScheduleEntry[] = [
        {
          scheduleId: "s-1",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
        {
          scheduleId: "s-2",
          recipient: BOB,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
      ];

      expect(() => assertNoPayoutScheduleCollision(schedules)).not.toThrow();
    });

    it("throws PayoutScheduleCollisionError with violations attached upon collision", () => {
      const schedules: PayoutScheduleEntry[] = [
        {
          scheduleId: "s-1",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
        {
          scheduleId: "s-2",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
      ];

      try {
        assertNoPayoutScheduleCollision(schedules);
        fail("Expected assertNoPayoutScheduleCollision to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(PayoutScheduleCollisionError);
        const collisionErr = err as PayoutScheduleCollisionError;
        expect(collisionErr.code).toBe("PAYOUT_SCHEDULE_COLLISION");
        expect(collisionErr.violations).toHaveLength(1);
        expect(collisionErr.suggestedFix).toBeDefined();
      }
    });
  });

  describe("findPayoutScheduleCollisions", () => {
    it("finds colliding entries for a candidate against existing calendar", () => {
      const existing: PayoutScheduleEntry[] = [
        {
          scheduleId: "exist-1",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
        {
          scheduleId: "exist-2",
          recipient: BOB,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
      ];

      const candidateAlice: PayoutScheduleEntry = {
        scheduleId: "candidate-1",
        recipient: ALICE,
        asset: "USDC",
        executionTimestamp: BASE_TIME,
      };

      const collisions = findPayoutScheduleCollisions(candidateAlice, existing);
      expect(collisions).toHaveLength(1);
      expect(collisions[0].code).toBe("EXACT_TIMESTAMP_COLLISION");

      const candidateBobDifferentTime: PayoutScheduleEntry = {
        scheduleId: "candidate-2",
        recipient: BOB,
        asset: "USDC",
        executionTimestamp: BASE_TIME + 1000000,
      };
      const noCollisions = findPayoutScheduleCollisions(candidateBobDifferentTime, existing);
      expect(noCollisions).toHaveLength(0);
    });
  });

  describe("filterNonCollidingPayoutSchedules", () => {
    it("partitions list into valid and colliding schedules", () => {
      const schedules: PayoutScheduleEntry[] = [
        {
          scheduleId: "clean-bob",
          recipient: BOB,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
        {
          scheduleId: "collide-alice-1",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
        {
          scheduleId: "collide-alice-2",
          recipient: ALICE,
          asset: "USDC",
          executionTimestamp: BASE_TIME,
        },
      ];

      const { validSchedules, collidingSchedules, report } =
        filterNonCollidingPayoutSchedules(schedules);

      expect(report.isValid).toBe(false);
      expect(validSchedules).toHaveLength(1);
      expect(validSchedules[0].scheduleId).toBe("clean-bob");
      expect(collidingSchedules).toHaveLength(2);
      expect(collidingSchedules.map((s) => s.scheduleId)).toEqual([
        "collide-alice-1",
        "collide-alice-2",
      ]);
    });
  });

  describe("isPayoutScheduleColliding", () => {
    it("accurately tests direct pairwise collision", () => {
      const a: PayoutScheduleEntry = {
        scheduleId: "a",
        recipient: ALICE,
        asset: "USDC",
        executionTimestamp: BASE_TIME,
      };
      const bSame: PayoutScheduleEntry = {
        scheduleId: "b",
        recipient: ALICE,
        asset: "USDC",
        executionTimestamp: BASE_TIME,
      };
      const cDiffTime: PayoutScheduleEntry = {
        scheduleId: "c",
        recipient: ALICE,
        asset: "USDC",
        executionTimestamp: BASE_TIME + 5000,
      };

      expect(isPayoutScheduleColliding(a, bSame)).toBe(true);
      expect(isPayoutScheduleColliding(a, cDiffTime)).toBe(false);
      expect(isPayoutScheduleColliding(a, cDiffTime, { minIntervalMs: 10000 })).toBe(true);
    });
  });
});
