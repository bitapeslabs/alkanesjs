export function stripFields<
  T extends Record<PropertyKey, any>,
  K extends readonly PropertyKey[]
>(obj: T, fields: K): Omit<T, Extract<K[number], keyof T>> {
  const out = { ...obj } as T;

  for (const key of fields) {
    delete out[key];
  }

  return out;
}
