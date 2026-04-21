import { Address } from "@ton/ton";
import { describe, expect, it } from "vitest";
import { TON_ADDRESS } from "../../src/constants.js";
import { normalizeAddress, sameAddress } from "../../src/utils/address.js";

describe("sameAddress", () => {
  const nonBounceable = "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8";
  const addr = Address.parse(nonBounceable);
  const bounceable = addr.toString({ bounceable: true });
  const raw = addr.toRawString();

  it("string-equal addresses match", () => {
    expect(sameAddress(bounceable, bounceable)).toBe(true);
  });

  it("EQ vs UQ forms match (bounceable vs non-bounceable)", () => {
    expect(sameAddress(bounceable, nonBounceable)).toBe(true);
  });

  it("user-friendly vs raw form match", () => {
    expect(sameAddress(bounceable, raw)).toBe(true);
  });

  it("different addresses don't match", () => {
    expect(sameAddress(bounceable, TON_ADDRESS)).toBe(false);
  });

  it("invalid addresses fall back to string equality", () => {
    expect(sameAddress("garbage", "garbage")).toBe(true);
    expect(sameAddress("garbage", "other")).toBe(false);
  });

  it("TON_ADDRESS placeholder parses and matches itself across forms", () => {
    const tonAddr = Address.parse(TON_ADDRESS);
    expect(sameAddress(TON_ADDRESS, tonAddr.toRawString())).toBe(true);
    expect(
      sameAddress(TON_ADDRESS, tonAddr.toString({ bounceable: false })),
    ).toBe(true);
  });
});

describe("normalizeAddress", () => {
  it("returns the canonical EQ form", () => {
    const addr = Address.parse(
      "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8",
    );
    expect(normalizeAddress(addr.toRawString())).toBe(addr.toString());
    expect(normalizeAddress(addr.toString({ bounceable: false }))).toBe(
      addr.toString(),
    );
  });

  it("returns the input unchanged when unparseable", () => {
    expect(normalizeAddress("not-an-address")).toBe("not-an-address");
  });
});
