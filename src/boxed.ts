/*
  Boxed responses come from the bxrs package (https://github.com/encloinc/boxedts)
  — the canonical evolution of the BoxedResponse pattern, with Rust-style
  combinators (`unwrap`, `unwrapOr`, `expect`, `map`, `andThen`, `isOk`/`isErr`)
  on every response. Every consumer of a function that returns a BoxedResponse
  needs to properly handle the consumed function's error types.

  NOTE: bxrs's BoxedError constructor takes (message?, errorType?) — message
  first — unlike the legacy in-repo implementation this file used to hold.
*/

export * from "bxrs";

import { BoxedResponse, IBoxedError, isBoxedError } from "bxrs";

/*─────────────────────────────────────────────────────────────
  BoxedPromise — alkanesjs's extension of bxrs to the async world.
  -----------------------------------------------------------
  A thenable around Promise<BoxedResponse<T, E>> that lets the bxrs
  combinators run as soon as the promise fulfills:

    const symbol = await contract.getSymbol().unwrap();     // string
    const supply = await contract.getTotalSupply().unwrapOr(0n);

  Awaiting the BoxedPromise itself still yields the plain
  BoxedResponse, so existing consumeOrThrow-style code keeps working.
──────────────────────────────────────────────────────────────*/
export class BoxedPromise<T, E extends string | number>
  implements PromiseLike<BoxedResponse<T, E>>
{
  constructor(private readonly promise: Promise<BoxedResponse<T, E>>) {}

  static from<T, E extends string | number>(
    value: Promise<BoxedResponse<T, E>> | BoxedResponse<T, E>,
  ): BoxedPromise<T, E> {
    return new BoxedPromise(Promise.resolve(value));
  }

  /* PromiseLike — awaiting yields the BoxedResponse unchanged */
  then<R1 = BoxedResponse<T, E>, R2 = never>(
    onfulfilled?:
      | ((value: BoxedResponse<T, E>) => R1 | PromiseLike<R1>)
      | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  catch<R = never>(
    onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null,
  ): Promise<BoxedResponse<T, E> | R> {
    return this.promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<BoxedResponse<T, E>> {
    return this.promise.finally(onfinally);
  }

  /* async bxrs combinators — applied the moment the promise fulfills */
  unwrap(): Promise<T> {
    return this.promise.then((response) => response.unwrap());
  }

  unwrapOr(fallback: T): Promise<T> {
    return this.promise.then((response) =>
      isBoxedError(response) ? fallback : response.data,
    );
  }

  unwrapOrElse(f: (err: IBoxedError<E>) => T): Promise<T> {
    return this.promise.then((response) => response.unwrapOrElse(f));
  }

  expect(message: string): Promise<T> {
    return this.promise.then((response) => response.expect(message));
  }

  toNullable(): Promise<T | null> {
    return this.promise.then((response) => response.toNullable());
  }

  /** The untouched inner promise, when a plain Promise type is needed. */
  boxed(): Promise<BoxedResponse<T, E>> {
    return this.promise;
  }
}
