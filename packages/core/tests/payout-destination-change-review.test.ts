import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { reviewPayoutDestinationChange } from "../src/employees";

const CURRENT = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11)).publicKey();
const PROPOSED = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 12)).publicKey();

describe("reviewPayoutDestinationChange", () => {
  it("builds a masked, standard-risk review for a valid account change", () => {
    const result = reviewPayoutDestinationChange({
      currentDestination: CURRENT,
      proposedDestination: PROPOSED,
    });

    expect(result).toEqual({
      ok: true,
      review: {
        current: { preview: `${CURRENT.slice(0, 6)}…${CURRENT.slice(-4)}`, kind: "account" },
        proposed: {
          preview: `${PROPOSED.slice(0, 6)}…${PROPOSED.slice(-4)}`,
          kind: "account",
        },
        risk: "standard",
        warnings: [],
      },
    });
    expect(JSON.stringify(result)).not.toContain(CURRENT);
    expect(JSON.stringify(result)).not.toContain(PROPOSED);
  });

  it("rejects an unchanged destination", () => {
    expect(
      reviewPayoutDestinationChange({
        currentDestination: CURRENT,
        proposedDestination: CURRENT,
      })
    ).toMatchObject({ ok: false, code: "DESTINATION_UNCHANGED" });
  });

  it("reports which side is invalid without echoing submitted values", () => {
    const privateValue = "invalid-private-destination";
    const invalidCurrent = reviewPayoutDestinationChange({
      currentDestination: privateValue,
      proposedDestination: PROPOSED,
    });
    const invalidProposed = reviewPayoutDestinationChange({
      currentDestination: CURRENT,
      proposedDestination: privateValue,
    });

    expect(invalidCurrent).toMatchObject({
      ok: false,
      code: "CURRENT_DESTINATION_INVALID",
      validationCode: "DESTINATION_UNSUPPORTED",
    });
    expect(invalidProposed).toMatchObject({
      ok: false,
      code: "PROPOSED_DESTINATION_INVALID",
      validationCode: "DESTINATION_UNSUPPORTED",
    });
    expect(JSON.stringify([invalidCurrent, invalidProposed])).not.toContain(privateValue);
  });

  it("flags an account-type change for elevated review", () => {
    const muxedPayload = Buffer.alloc(40);
    StrKey.decodeEd25519PublicKey(PROPOSED).copy(muxedPayload);
    muxedPayload.writeBigUInt64BE(42n, 32);
    const muxed = StrKey.encodeMed25519PublicKey(muxedPayload);
    expect(
      reviewPayoutDestinationChange({
        currentDestination: CURRENT,
        proposedDestination: muxed,
      })
    ).toMatchObject({
      ok: true,
      review: {
        proposed: { kind: "muxed_account" },
        risk: "elevated",
        warnings: ["DESTINATION_TYPE_CHANGED"],
      },
    });
  });

  it("rejects whitespace changes instead of silently normalizing them", () => {
    expect(
      reviewPayoutDestinationChange({
        currentDestination: CURRENT,
        proposedDestination: ` ${PROPOSED}`,
      })
    ).toMatchObject({
      ok: false,
      code: "PROPOSED_DESTINATION_INVALID",
      validationCode: "DESTINATION_WHITESPACE",
    });
  });
});
