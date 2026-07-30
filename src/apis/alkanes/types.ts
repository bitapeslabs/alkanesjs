export interface EncodedAlkaneId {
  block: string;
  tx: string;
}

export type AlkaneEncoded = {
  value: string; // in satoshis
} & EncodedAlkaneId;

/**
 * The structural shape of an id — just the two fields. This is the type
 * every INPUT position in the SDK accepts, so a hand-written
 * `{ block: 2n, tx: 0n }` works wherever an id is wanted; the `AlkaneId`
 * class satisfies it too, being exactly this plus methods.
 */
export interface AlkaneIdData {
  readonly block: bigint;
  readonly tx: bigint;
}

/**
 * Which alkane. `block:tx`, the pair every contract, outpoint and edict names
 * an asset by.
 *
 * Ids the SDK hands BACK are instances, so the conversions read off them
 * directly:
 *
 *     const id = await deployment.send().waitForDeployment();
 *     id.toString()   // "2:74"
 *     id.toSchema()   // { block: 74, tx: 74n } — the borsh argument shape
 *     id.toObject()   // { block: 2n, tx: 74n } — plain data, methods shed
 *     id.equals(other)
 *
 * Ids you WRITE can stay plain objects: input positions are typed
 * `AlkaneIdData`, the structural shape above, which both literals and
 * instances satisfy. The statics mirror the instance methods for exactly
 * those values — `AlkaneId.toString(idLike)` works on anything id-shaped
 * without constructing first.
 */
export class AlkaneId implements AlkaneIdData {
  readonly block: bigint;
  readonly tx: bigint;

  constructor(block: bigint | number | string, tx: bigint | number | string) {
    this.block = BigInt(block);
    this.tx = BigInt(tx);
  }

  /** `"2:0"` — the spelling espo, traces and wallets all use. Also what
   *  template literals print, so `` `deployed ${id}` `` just works. */
  toString(): string {
    return `${this.block}:${this.tx}`;
  }

  /**
   * The `SchemaAlkaneId` shape borsh arguments take — `block` a u32 number,
   * `tx` a u64 bigint. Contracts declare their ids that way; the wire does
   * not care, but the encoder does.
   */
  toSchema(): { block: number; tx: bigint } {
    return { block: Number(this.block), tx: this.tx };
  }

  /** Plain `{ block, tx }` data — the instance with its methods shed. */
  toObject(): AlkaneIdData {
    return { block: this.block, tx: this.tx };
  }

  equals(other: AlkaneIdLike): boolean {
    return AlkaneId.equal(this, other);
  }

  /**
   * `JSON.stringify` support: serializes as the `"block:tx"` string instead
   * of throwing on the bigint fields. `AlkaneId.from` reads it back.
   */
  toJSON(): string {
    return this.toString();
  }

  /** `"2:0"` — the spelling espo, traces and wallets all use. */
  static fromString(id: string): AlkaneId {
    const [block, tx, ...rest] = id.trim().split(":");
    if (rest.length > 0 || !block || !tx || !/^\d+$/.test(block) || !/^\d+$/.test(tx)) {
      throw new Error(`AlkaneId.fromString: "${id}" is not a block:tx id`);
    }
    return new AlkaneId(block, tx);
  }

  /** Whatever an id might arrive as — a string, or anything id-shaped. */
  static from(id: AlkaneIdLike): AlkaneId {
    return typeof id === "string"
      ? AlkaneId.fromString(id)
      : new AlkaneId(id.block, id.tx);
  }

  /** Back to `"block:tx"`. */
  static toString(id: AlkaneIdLike): string {
    const { block, tx } = AlkaneId.from(id);
    return `${block}:${tx}`;
  }

  /**
   * The `SchemaAlkaneId` shape borsh arguments take — `block` a u32 number,
   * `tx` a u64 bigint. Contracts declare their ids that way; the wire does
   * not care, but the encoder does.
   */
  static toSchema(id: AlkaneIdLike): { block: number; tx: bigint } {
    const { block, tx } = AlkaneId.from(id);
    return { block: Number(block), tx };
  }

  static equal(a: AlkaneIdLike, b: AlkaneIdLike): boolean {
    const x = AlkaneId.from(a);
    const y = AlkaneId.from(b);
    return x.block === y.block && x.tx === y.tx;
  }
}

/** An id, however it was written down. */
export type AlkaneIdLike =
  | AlkaneIdData
  | string
  | { block: bigint | number; tx: bigint | number };

export type Alkane = {
  value: bigint; // in satoshis
} & AlkaneIdData;

export interface AlkaneRune {
  rune: {
    id: EncodedAlkaneId;
    name: string;
    spacedName: string;
    divisibility: number;
    spacers: number;
    symbol: string;
  };
  balance: string;
}
export interface ProtoRunesToken {
  id: EncodedAlkaneId;
  name: string;
  symbol: string;
}

export type AlkaneReadableId = string;
export type AlkanesUtxoEntry = {
  value: string;
  name: string;
  symbol: string;
  id: string;
};

export type AlkanesOutpoint = {
  token: {
    id: {
      block: string;
      tx: string;
    };
    name: string;
    symbol: string;
  };
  value: string;
};

export type AlkanesOutpointExtended = AlkanesOutpoint & {
  outpoint: string; // "txid:vout"
};

export type AlkanesOutpoints = AlkanesOutpoint[];

export type AlkanesOutpointsExtended = AlkanesOutpointExtended[];

export type AlkanesByAddressResponse = {
  outpoints: AlkanesByAddressOutpoint[];
};

export type AlkanesByAddressOutpoint = {
  runes: AlkanesByAddressRuneBalance[];
  outpoint: {
    txid: string; // 64-character hex string
    vout: number;
  };
  output: {
    value: number; // in sats
    script: string; // hex-encoded scriptPubKey
  };
  height: number; // block height
  txindex: number; // transaction index within block
};

export type AlkanesByAddressRuneBalance = {
  rune: {
    id: {
      block: string; // hex string like "0x2"
      tx: string; // hex string like "0xa"
    };
    name: string;
    spacedName: string;
    divisibility: number;
    spacers: number;
    symbol: string;
  };
  balance: string; // hex string representing amount, e.g. "0x886c98b76000"
};
export interface AlkaneSimulateRequest {
  alkanes?: any[];
  transaction?: string;
  height?: string;
  txindex?: number;
  target: AlkaneIdData;
  callData: bigint[];
  pointer?: number;
  refundPointer?: number;
  vout?: number;
}

export type AlkaneEncodedSimulationRequest = {
  alkanes: any[];
  transaction: string;
  block: string;
  height: string;
  txindex: number;
  target: EncodedAlkaneId;
  inputs: string[];
  pointer: number;
  refundPointer: number;
  vout: number;
};
export interface AlkaneToken {
  name: string;
  symbol: string;
  totalSupply: number;
  cap: number;
  minted: number;
  mintActive: boolean;
  percentageMinted: number;
  mintAmount: number;
}

export interface AlkanesParsedSimulationResult {
  string: string;
  bytes: string;
  le: string;
  be: string;
}

export interface AlkanesRawSimulationResponse {
  status: number;
  gasUsed: number;
  execution: {
    alkanes: unknown[];
    storage: unknown[];
    data: string;
    error?: string;
  };
  parsed: unknown;
}

export type AlkanesSimulationResult = {
  raw: AlkanesRawSimulationResponse;
  parsed: AlkanesParsedSimulationResult | undefined;
};

export interface AlkanesTraceEncodedCreateEvent {
  event: "create";
  data: EncodedAlkaneId;
}

export interface AlkanesTraceEncodedInvokeEvent {
  event: "invoke";
  data: {
    type: "call";
    context: {
      myself: EncodedAlkaneId;
      caller: EncodedAlkaneId;
      inputs: string[];
      incomingAlkanes: AlkaneEncoded[];
      vout: number;
    };
    fuel: number;
  };
}

export interface AlkanesTraceEncodedReturnEvent {
  event: "return";
  data: {
    status: "success";
    response: {
      alkanes: AlkaneEncoded[];
      data: string;
      storage: {
        key: string;
        value: string;
      }[];
    };
  };
}

export type AlkanesTraceEncodedEvent =
  | AlkanesTraceEncodedCreateEvent
  | AlkanesTraceEncodedInvokeEvent
  | AlkanesTraceEncodedReturnEvent;

export type AlkanesTraceEncodedResult = AlkanesTraceEncodedEvent[];

export interface AlkanesTraceCreateEvent {
  event: "create";
  data: AlkaneId;
}

export interface AlkanesTraceInvokeEvent {
  event: "invoke";
  data: {
    type: "call";
    context: {
      myself: AlkaneId;
      caller: AlkaneId;
      inputs: bigint[];
      incomingAlkanes: Alkane[];
      vout: number;
    };
    fuel: number;
  };
}

export interface AlkanesTraceReturnEvent {
  event: "return";
  data: {
    status: "success" | "revert";
    response: {
      alkanes: Alkane[];
      data: string;
      storage: {
        key: string;
        value: bigint;
      }[];
    };
  };
}

export type AlkanesTraceEvent =
  | AlkanesTraceCreateEvent
  | AlkanesTraceInvokeEvent
  | AlkanesTraceReturnEvent;

export type AlkanesTraceResult = AlkanesTraceEvent[];
