export type TreasuryReplenishmentAssetStatus = "ready" | "replenishment_required" | "blocked";

export interface TreasuryReplenishmentAssetInput {
  asset: string;
  requiredAmount: bigint;
  allowlisted?: boolean;
  suspended?: boolean;
}

export interface TreasuryReplenishmentBalanceInput {
  asset: string;
  availableBalance: bigint;
  isLocked?: boolean;
}

export interface AnalyzeTreasuryReplenishmentReadinessInput {
  obligations: TreasuryReplenishmentAssetInput[];
  treasuryBalances: TreasuryReplenishmentBalanceInput[];
  defaultBufferPercent?: number;
  employerAddress?: string;
  batchId?: string;
}

export interface TreasuryReplenishmentAssetReadiness {
  asset: string;
  status: TreasuryReplenishmentAssetStatus;
  availableBalance?: bigint;
  requiredAmount: bigint;
  targetBalance: bigint;
  replenishmentAmount?: bigint;
  canExecuteNow: boolean;
  blockers: string[];
  recommendations: string[];
}

export interface TreasuryReplenishmentReadinessResult {
  readinessLevel: TreasuryReplenishmentAssetStatus;
  canExecuteNow: boolean;
  assets: TreasuryReplenishmentAssetReadiness[];
  blockers: string[];
  recommendations: string[];
  lastCheckedAt: number;
  employerAddress?: string;
  batchId?: string;
}

export function analyzeTreasuryReplenishmentReadiness(
  input: AnalyzeTreasuryReplenishmentReadinessInput
): TreasuryReplenishmentReadinessResult {
  if (!input || !Array.isArray(input.obligations) || input.obligations.length === 0) {
    throw new TypeError("At least one treasury obligation is required for replenishment analysis.");
  }
  if (!Array.isArray(input.treasuryBalances)) {
    throw new TypeError("Treasury balances must be provided as an array.");
  }

  const bufferPercent = input.defaultBufferPercent ?? 0;
  if (!Number.isSafeInteger(bufferPercent) || bufferPercent < 0) {
    throw new RangeError(
      "The treasury replenishment buffer must be a non-negative whole percentage."
    );
  }

  const obligations = new Map<string, TreasuryReplenishmentAssetInput>();
  for (const obligation of input.obligations) {
    validateAsset(obligation?.asset, "obligation");
    validateAmount(obligation.requiredAmount, `Required amount for ${obligation.asset}`);
    if (obligations.has(obligation.asset)) {
      throw new TypeError(`Duplicate treasury obligation for asset ${obligation.asset}.`);
    }
    obligations.set(obligation.asset, obligation);
  }

  const balances = new Map<string, TreasuryReplenishmentBalanceInput>();
  for (const balance of input.treasuryBalances) {
    validateAsset(balance?.asset, "balance");
    validateAmount(balance.availableBalance, `Available balance for ${balance.asset}`);
    if (balances.has(balance.asset)) {
      throw new TypeError(`Duplicate treasury balance for asset ${balance.asset}.`);
    }
    balances.set(balance.asset, balance);
  }

  const assets = [...obligations.values()].map((obligation) => {
    const balance = balances.get(obligation.asset);
    const blockers: string[] = [];
    const recommendations: string[] = [];
    const requiredAmount = obligation.requiredAmount;
    const targetBalance = calculateTargetBalance(requiredAmount, bufferPercent);

    if (obligation.suspended) {
      blockers.push(`Asset ${obligation.asset} is suspended and cannot be replenished.`);
    } else if (obligation.allowlisted === false) {
      blockers.push(`Asset ${obligation.asset} is not allowlisted in treasury policy.`);
    }
    if (!balance) {
      blockers.push(
        `Balance for asset ${obligation.asset} is unavailable; refresh treasury balances.`
      );
    } else if (balance.isLocked) {
      blockers.push(
        `Treasury for asset ${obligation.asset} is locked; resolve the hold before replenishing.`
      );
    }

    const availableBalance = balance?.availableBalance;
    const replenishmentAmount =
      blockers.length === 0 && availableBalance !== undefined
        ? targetBalance > availableBalance
          ? targetBalance - availableBalance
          : 0n
        : undefined;
    const canExecuteNow =
      blockers.length === 0 && availableBalance !== undefined && availableBalance >= requiredAmount;

    let status: TreasuryReplenishmentAssetStatus = "ready";
    if (blockers.length > 0) {
      status = "blocked";
    } else if (replenishmentAmount !== 0n) {
      status = "replenishment_required";
      recommendations.push(
        `Replenish ${obligation.asset} by ${replenishmentAmount?.toString()} stroops to reach the target balance.`
      );
    }

    return {
      asset: obligation.asset,
      status,
      availableBalance,
      requiredAmount,
      targetBalance,
      replenishmentAmount,
      canExecuteNow,
      blockers,
      recommendations,
    };
  });

  const blockers = assets.flatMap((asset) => asset.blockers);
  const recommendations = assets.flatMap((asset) => asset.recommendations);
  const readinessLevel: TreasuryReplenishmentAssetStatus =
    blockers.length > 0
      ? "blocked"
      : recommendations.length > 0
        ? "replenishment_required"
        : "ready";

  return {
    readinessLevel,
    canExecuteNow: assets.every((asset) => asset.canExecuteNow),
    assets,
    blockers,
    recommendations,
    lastCheckedAt: Date.now(),
    employerAddress: input.employerAddress,
    batchId: input.batchId,
  };
}

function calculateTargetBalance(requiredAmount: bigint, bufferPercent: number): bigint {
  const multiplier = 100n + BigInt(bufferPercent);
  return (requiredAmount * multiplier + 99n) / 100n;
}

function validateAsset(asset: unknown, field: string): asserts asset is string {
  if (typeof asset !== "string" || asset.trim().length === 0) {
    throw new TypeError(`A non-empty asset identifier is required for each treasury ${field}.`);
  }
}

function validateAmount(amount: unknown, label: string): asserts amount is bigint {
  if (typeof amount !== "bigint" || amount < 0n) {
    throw new RangeError(`${label} must be a non-negative bigint amount in stroops.`);
  }
}
