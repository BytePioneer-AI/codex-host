import { z } from "zod";

// Desktop's CSP forbids runtime code generation, including schema JIT compilation.
z.config({ jitless: true });
