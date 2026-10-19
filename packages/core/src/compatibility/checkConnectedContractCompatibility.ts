import {
  rpc,
  Account,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  StrKey,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  SDK_SUPPORTED_CONTRACT_REVISION_RANGE,
  checkContractRevisionCompatibility,
} from "./checkContractRevisionCompatibility";
import type { ContractCompatibilityWarning, SupportedContractRevisionRange } from "./types";

/** Dummy, never-funded account used purely to build a read-only simulation. */
const DUMMY_SOURCE_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface CheckConnectedContractCompatibilityOptions {
  /** Soroban RPC server for the target network. */
  server: rpc.Server;
  /** Payroll contract ID to read the revision from. */
  contractId: string;
  /**
   * Read-only contract method that returns the contract's revision as an
   * integer. Defaults to `"get_revision"`.
   */
  revisionMethod?: string;
  /** Overrides {@link SDK_SUPPORTED_CONTRACT_REVISION_RANGE} for this check. */
  supportedRange?: SupportedContractRevisionRange;
}

function unreadableWarning(
  message: string,
  supportedRange: SupportedContractRevisionRange
): ContractCompatibilityWarning {
  return {
    status: "unknown",
    compatible: false,
    code: "CONTRACT_REVISION_UNREADABLE",
    message,
    supportedRange,
  };
}

/**
 * Reads a connected payroll contract's revision (via a read-only,
 * unsigned simulation) and warns when it falls outside the range this SDK
 * version supports.
 *
 * Never throws: RPC failures, an invalid contract ID, or a contract that
 * doesn't expose `revisionMethod` all resolve to `status: "unknown"` with a
 * stable code, so a compatibility check can never crash a payroll workflow.
 * Only revision numbers are exchanged with the network — no recipient,
 * amount, or employee data is read or logged.
 *
 * @example
 * ```ts
 * const warning = await checkConnectedContractCompatibility({ server, contractId });
 * if (!warning.compatible) {
 *   console.warn(warning.code, warning.message); // safe to log
 * }
 * ```
 */
export async function checkConnectedContractCompatibility(
  options: CheckConnectedContractCompatibilityOptions
): Promise<ContractCompatibilityWarning> {
  const {
    server,
    contractId,
    revisionMethod = "get_revision",
    supportedRange = SDK_SUPPORTED_CONTRACT_REVISION_RANGE,
  } = options;

  if (typeof contractId !== "string" || !StrKey.isValidContract(contractId)) {
    return unreadableWarning(
      "The connected contract's revision could not be determined because the contract ID is invalid. Compatibility could not be verified.",
      supportedRange
    );
  }

  try {
    const dummySource = new Account(DUMMY_SOURCE_ACCOUNT, "0");
    const contract = new Contract(contractId);
    const network = await server.getNetwork();

    const tx = new TransactionBuilder(dummySource, {
      fee: BASE_FEE,
      networkPassphrase: network.passphrase,
    })
      .addOperation(contract.call(revisionMethod))
      .setTimeout(30)
      .build();

    const simResult = await server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simResult) || !("result" in simResult) || !simResult.result) {
      return unreadableWarning(
        "This SDK could not read a revision from the connected contract, so compatibility could not be verified. The deployed contract may predate revision reporting.",
        supportedRange
      );
    }

    const native = scValToNative(simResult.result.retval);
    const revision =
      typeof native === "bigint" ? Number(native) : typeof native === "number" ? native : NaN;

    return checkContractRevisionCompatibility(revision, supportedRange);
  } catch {
    return unreadableWarning(
      "This SDK could not read a revision from the connected contract, so compatibility could not be verified. Check RPC connectivity and retry.",
      supportedRange
    );
  }
}
