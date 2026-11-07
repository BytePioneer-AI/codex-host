export function installRendererManagerMethods<Name extends string>(
  manager: object,
  replacements: Record<Name, unknown>,
): (name: Name) => void {
  const originalPrototype: object | null = Object.getPrototypeOf(manager);
  const overrides: object = Object.create(originalPrototype);
  const names = Object.keys(replacements);
  const descriptors = new Map(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(manager, name)]),
  );
  for (const name of names) {
    const own = descriptors.get(name);
    // RpcTarget forbids own properties over RPC. Override inherited methods on
    // a private prototype; plain-object targets retain their own descriptors.
    Object.defineProperty(own ? manager : overrides, name, {
      configurable: own?.configurable ?? true,
      enumerable: own?.enumerable ?? false,
      writable: true,
      value: Reflect.get(replacements, name),
    });
  }
  if (names.some((name) => !descriptors.get(name))) Object.setPrototypeOf(manager, overrides);
  return (name) => {
    const own = descriptors.get(name);
    const holder = own ? manager : overrides;
    if (Reflect.get(holder, name) === Reflect.get(replacements, name)) {
      if (own) Object.defineProperty(manager, name, own);
      else Reflect.deleteProperty(overrides, name);
    }
    if (
      Object.getPrototypeOf(manager) === overrides &&
      names.every((key) => !Object.hasOwn(overrides, key))
    ) {
      Object.setPrototypeOf(manager, originalPrototype);
    }
  };
}
