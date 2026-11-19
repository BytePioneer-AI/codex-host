import "../src/renderer-schema-config.js";
import { z } from "zod";
import { expect, it, vi } from "vitest";

const schema = z.object({ name: z.string(), revision: z.number() });

it("validates schemas without runtime code generation under Desktop's CSP", () => {
  const compile = vi.spyOn(globalThis, "Function").mockImplementation(() => {
    throw new EvalError("CSP forbids unsafe-eval");
  });
  try {
    expect(z.config().jitless).toBe(true);
    expect(schema.parse({ name: "eli5", revision: 1 })).toEqual({ name: "eli5", revision: 1 });
    expect(schema.safeParse({ name: 1, revision: "bad" }).success).toBe(false);
    expect(compile).not.toHaveBeenCalled();
  } finally {
    compile.mockRestore();
  }
});
