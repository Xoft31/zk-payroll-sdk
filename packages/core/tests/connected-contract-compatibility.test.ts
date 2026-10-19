import { rpc, StrKey, xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { checkConnectedContractCompatibility } from "../src";

const mockGetNetwork = jest.fn();
const mockSimulateTransaction = jest.fn();

jest.mock("@stellar/stellar-sdk", () => {
  const original = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...original,
    rpc: {
      ...original.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getNetwork: mockGetNetwork,
        simulateTransaction: mockSimulateTransaction,
      })),
    },
  };
});

function scValRevision(revision: number): xdr.ScVal {
  return nativeToScVal(revision, { type: "u32" });
}

describe("checkConnectedContractCompatibility", () => {
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
  const server = new rpc.Server("https://soroban-testnet.stellar.org");

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetNetwork.mockResolvedValue({ passphrase: "Test SDF Network ; September 2015" });
  });

  it("reads the connected revision and reports compatibility (main path)", async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: scValRevision(1) },
    });

    const warning = await checkConnectedContractCompatibility({ server, contractId });

    expect(warning.status).toBe("compatible");
    expect(warning.compatible).toBe(true);
    expect(warning.connectedRevision).toBe(1);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("warns without throwing when the contract revision is outside the supported range", async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: scValRevision(99) },
    });

    const warning = await checkConnectedContractCompatibility({
      server,
      contractId,
      supportedRange: { min: 1, max: 3 },
    });

    expect(warning.status).toBe("ahead");
    expect(warning.compatible).toBe(false);
    expect(warning.code).toBe("CONTRACT_REVISION_AHEAD");
  });

  it("resolves to unknown (never throws) when the contract does not expose the revision method (edge case)", async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: "HostError: Error(Contracts, #12): function not found",
    });

    const warning = await checkConnectedContractCompatibility({ server, contractId });

    expect(warning.status).toBe("unknown");
    expect(warning.compatible).toBe(false);
    expect(warning.code).toBe("CONTRACT_REVISION_UNREADABLE");
  });

  it("resolves to unknown (never throws) when the RPC call fails", async () => {
    mockGetNetwork.mockRejectedValue(new Error("Connection refused"));

    const warning = await checkConnectedContractCompatibility({ server, contractId });

    expect(warning.status).toBe("unknown");
    expect(warning.code).toBe("CONTRACT_REVISION_UNREADABLE");
  });

  it("resolves to unknown for an invalid contract ID without contacting the network", async () => {
    const warning = await checkConnectedContractCompatibility({
      server,
      contractId: "not-a-contract-id",
    });

    expect(warning.status).toBe("unknown");
    expect(warning.code).toBe("CONTRACT_REVISION_UNREADABLE");
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it("never includes recipient, amount, or employee values in the warning", async () => {
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: scValRevision(99) },
    });

    const warning = await checkConnectedContractCompatibility({
      server,
      contractId,
      supportedRange: { min: 1, max: 3 },
    });

    expect(JSON.stringify(warning)).not.toMatch(/recipient|amount|employee/i);
  });
});
