/*
  Token amounts, written the way people say them.

  Alkanes are integers on the wire — a u128 of the smallest unit — and the SDK
  takes them that way everywhere. `Amount` is only a way to type one without
  counting zeroes: `Amount.fromNumber(1)` IS `100000000n`, a plain bigint that
  goes wherever a bigint goes. Nothing accepts an "Amount" type, because there
  is no such thing.

  Scaling goes through the decimal STRING, never `value * 1e8` — `0.1 * 1e8`
  is `10000000.000000002` in binary floating point, and a token amount that is
  off by a hundred-millionth is a bug you find in production. For the same
  reason `fromString` exists beside `fromNumber`: digits that arrive as text
  never have to become a float at all.
*/

/** What an alkane's smallest unit is worth: 1 token = 10^8 of them. */
export const DECIMALS = 8;

export class Amount {
  private constructor() {}

  /**
   * A decimal WRITTEN OUT as the integer the wire wants — exact, because the
   * digits never pass through a float:
   *
   *     Amount.fromString("2.221")        // 222100000n
   *     Amount.fromString("0.00000001")   // 1n
   *     Amount.fromString("21000000")     // 2100000000000000n
   *
   * This is the one to reach for when the value came from a person, a form,
   * or JSON — anywhere the digits already exist as text. A JS number can only
   * carry ~15 significant digits, so writing `2.2214748364712345` as a literal
   * has already lost something before any of this runs; as a string it has
   * not.
   *
   * Throws on more precision than `decimals` can hold, rather than rounding
   * it away silently.
   */
  static fromString(value: string, decimals: number = DECIMALS): bigint {
    const text = plainDecimal(value.trim());
    if (!/^-?\d*(\.\d*)?$/.test(text) || text === "" || text === "-") {
      throw new Error(`Amount.fromString: "${value}" is not a number`);
    }
    const negative = text.startsWith("-");
    const [whole = "0", fraction = ""] = text.replace(/^-/, "").split(".");
    if (fraction.length > decimals) {
      throw new Error(
        `Amount.fromString: ${value} has more than ${decimals} decimal places`,
      );
    }
    const scale = 10n ** BigInt(decimals);
    const scaled =
      BigInt(whole || "0") * scale +
      (decimals === 0 ? 0n : BigInt(fraction.padEnd(decimals, "0")));
    return negative ? -scaled : scaled;
  }

  /**
   * The same, from a JS number:
   *
   *     Amount.fromNumber(1)        // 100000000n
   *     Amount.fromNumber(0.5)      // 50000000n
   *
   * Exact for anything a double represents exactly, which is every amount
   * you would reasonably type. Past ~15 significant digits a number cannot
   * hold what you wrote — use `fromString` there, where the digits stay
   * digits.
   */
  static fromNumber(value: number, decimals: number = DECIMALS): bigint {
    if (!Number.isFinite(value)) {
      throw new Error(`Amount.fromNumber: ${value} is not a finite number`);
    }
    return Amount.fromString(plainDecimal(value), decimals);
  }

  /** The other way, for display. `toString` keeps every digit; use it to print. */
  static toString(value: bigint, decimals: number = DECIMALS): string {
    const negative = value < 0n;
    const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
    const whole = digits.slice(0, digits.length - decimals);
    const fraction = decimals === 0 ? "" : digits.slice(digits.length - decimals);
    const trimmed = fraction.replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole}${trimmed ? `.${trimmed}` : ""}`;
  }

  /** Lossy above 2^53 — for arithmetic keep the bigint; this is for display. */
  static toNumber(value: bigint, decimals: number = DECIMALS): number {
    return Number(Amount.toString(value, decimals));
  }
}

/** A number as a plain decimal string, with any exponent expanded out. */
function plainDecimal(value: number | string): string {
  const text = typeof value === "string" ? value.trim() : String(value);
  if (!/e/i.test(text)) return text;

  const [mantissa, exponent] = text.split(/e/i);
  const shift = Number(exponent);
  const negative = mantissa.startsWith("-");
  const [whole = "", fraction = ""] = mantissa.replace(/^[-+]/, "").split(".");
  const digits = whole + fraction;
  const point = whole.length + shift;

  const out =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? "-" : "") + out;
}
