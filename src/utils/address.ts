import { Address } from "@ton/ton";

/**
 * Compare two TON addresses while tolerating different textual formats.
 *
 * A single on-chain address can be represented as `EQ…` (bounceable), `UQ…`
 * (non-bounceable), or `0:hex…` (raw). Strict string equality breaks when
 * callers mix formats between `availableCoins` / `source` / STON.fi API
 * responses. This helper parses both sides and compares the underlying
 * workchain + hash, falling back to string equality when either side isn't
 * a valid address.
 */
export function sameAddress(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return Address.parse(a).equals(Address.parse(b));
  } catch {
    return false;
  }
}

/**
 * Normalise an address to its canonical bounceable `EQ…` form. Useful as a
 * `Set`/`Map` key when de-duplicating addresses across heterogeneous
 * sources. Returns the input unchanged when it is not parseable — the
 * caller can treat the value as opaque in that case.
 */
export function normalizeAddress(a: string): string {
  try {
    return Address.parse(a).toString();
  } catch {
    return a;
  }
}
