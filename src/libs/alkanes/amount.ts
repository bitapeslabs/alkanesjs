/*
  Token amounts, written the way people say them.

  Alkanes are integers on the wire — a u128 of the smallest unit — and the
  SDK speaks them as bigints everywhere. An `Amount` wraps one and answers in
  whichever form you need:

      Amount.fromString("2.221").bigint          // 222100000n — the wire value
      Amount.fromBigint(unclaimed).number        // 2.221      — for display
      Amount.fromBaseUnits("222100000").string   // "2.221"

  The constructor you reach for is decided by what you Hold, because the type
  tells you the denomination: numbers and decimal strings are how humans
  write TOKENS, so `fromNumber` / `fromString` scale by the decimals; bigints
  and base-unit strings are how the wire speaks, so `fromBigint` /
  `fromBaseUnits` take them verbatim. No constructor guesses.

  Scaling goes through the decimal STRING, never `value * 1e8` — `0.1 * 1e8`
  is `10000000.000000002` in binary floating point, and a token amount that
  is off by a hundred-millionth is a bug you find in production. For the same
  reason `fromString` exists beside `fromNumber`: digits that arrive as text
  never have to become a float at all.
*/

/** What an alkane's smallest unit is worth: 1 token = 10^8 of them. */
export const DECIMALS = 8;

/** An amount wherever one is accepted: the wire bigint, or an `Amount`. */
export type AmountLike = bigint | Amount;

export class Amount {
  private constructor(
    private readonly units: bigint,
    private readonly decimals: number,
  ) {}

  /*───────────────────────── constructors ─────────────────────────*/

  /**
   * TOKENS written out as text — exact, because the digits never pass
   * through a float:
   *
   *     Amount.fromString("2.221").bigint        // 222100000n
   *     Amount.fromString("0.00000001").bigint   // 1n
   *
   * This is the one for values from a person, a form, or JSON — anywhere the
   * digits already exist as text. A JS number can only carry ~15 significant
   * digits, so `2.2214748364712345` as a literal has already lost something
   * before any of this runs; as a string it has not.
   *
   * Throws on more precision than `decimals` can hold, rather than rounding
   * it away silently.
   */
  static fromString(value: string, decimals: number = DECIMALS): Amount {
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
    return new Amount(negative ? -scaled : scaled, decimals);
  }

  /**
   * TOKENS as a JS number:
   *
   *     Amount.fromNumber(1).bigint        // 100000000n
   *     Amount.fromNumber(0.5).bigint      // 50000000n
   *
   * Exact for anything a double represents exactly, which is every amount
   * you would reasonably type. Past ~15 significant digits a number cannot
   * hold what you wrote — use `fromString` there, where the digits stay
   * digits.
   */
  static fromNumber(value: number, decimals: number = DECIMALS): Amount {
    if (!Number.isFinite(value)) {
      throw new Error(`Amount.fromNumber: ${value} is not a finite number`);
    }
    return Amount.fromString(plainDecimal(value), decimals);
  }

  /**
   * BASE UNITS as a bigint, taken verbatim — no scaling. A bigint is how the
   * wire speaks: view results, balances and edict values all arrive this
   * way, already in smallest units.
   *
   *     const { unclaimed } = await taco.getUnclaimed(args).unwrap();
   *     Amount.fromBigint(unclaimed).number    // 12.5 — for display
   *
   * (To scale a whole-token COUNT you happen to hold as a bigint, write it
   * through `fromString`: `Amount.fromString(count.toString())`.)
   */
  static fromBigint(value: bigint, decimals: number = DECIMALS): Amount {
    return new Amount(value, decimals);
  }

  /**
   * BASE UNITS that arrived as text — espo reports raw units as decimal
   * strings — or a bigint; either way taken verbatim:
   *
   *     Amount.fromBaseUnits("222100000").string   // "2.221"
   *
   * Refuses anything with a decimal point: base units never carry one, and
   * "2.221" handed here instead of `fromString` would otherwise be silently
   * off by 10^decimals.
   */
  static fromBaseUnits(
    value: string | bigint,
    decimals: number = DECIMALS,
  ): Amount {
    if (typeof value === "bigint") return new Amount(value, decimals);
    const text = value.trim();
    if (!/^-?\d+$/.test(text)) {
      throw new Error(
        `Amount.fromBaseUnits: "${value}" is not an integer — base units ` +
          "never carry a decimal point (fromString is for token-denominated text)",
      );
    }
    return new Amount(BigInt(text), decimals);
  }

  /** The wire bigint of an AmountLike — unwraps an Amount, passes a bigint. */
  static toBigint(value: AmountLike): bigint {
    return typeof value === "bigint" ? value : value.bigint;
  }

  /*───────────────────────── the forms ─────────────────────────*/

  /** Base units, as the wire wants them: `222100000n`. */
  get bigint(): bigint {
    return this.units;
  }

  /** Base units as text: `"222100000"` — what espo reports. */
  get stringBaseUnits(): string {
    return this.units.toString();
  }

  /** Tokens as text: `"2.221"`. Keeps every digit; the form to print. */
  get string(): string {
    const negative = this.units < 0n;
    const digits = (negative ? -this.units : this.units)
      .toString()
      .padStart(this.decimals + 1, "0");
    const whole = digits.slice(0, digits.length - this.decimals);
    const fraction =
      this.decimals === 0 ? "" : digits.slice(digits.length - this.decimals);
    const trimmed = fraction.replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole}${trimmed ? `.${trimmed}` : ""}`;
  }

  /** Tokens as a number: `2.221`. Lossy above 2^53 — display, not arithmetic. */
  get number(): number {
    return Number(this.string);
  }

  /*───────────────────────── protocol hooks ─────────────────────────*/

  /** `${amount}` prints the token string: `"2.221"`. */
  toString(): string {
    return this.string;
  }

  /** Locale-formatted tokens for display: `"1,234.5"`. Lossy above 2^53. */
  toLocaleString(
    ...args: Parameters<Number["toLocaleString"]>
  ): string {
    return this.number.toLocaleString(...args);
  }

  /**
   * `JSON.stringify` support: serializes as the base-unit string — the exact
   * form — instead of throwing on the bigint. `fromBaseUnits` reads it back.
   */
  toJSON(): string {
    return this.stringBaseUnits;
  }

  /** Comparisons against bigints work: `amount.valueOf() === 222100000n`. */
  valueOf(): bigint {
    return this.units;
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
