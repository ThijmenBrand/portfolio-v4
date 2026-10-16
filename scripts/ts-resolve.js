// Lets Node run the browser sources directly, for the self-checks under src/.
//
// Vite resolves "./mount" to "./mount.ts"; Node does not, and the kernel
// writes its imports both ways. Rather than spell out every extension in
// code the browser never needs it in, add the extension at resolve time:
//   node --import ./scripts/ts-resolve.js src/kernel/fs/remote.check.ts
import { registerHooks } from "node:module";

const HAS_EXTENSION = /\.(ts|tsx|js|mjs|cjs|json|css|html|svg|txt)$/;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !HAS_EXTENSION.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        // Not a .ts file after all: let the normal rules report it.
      }
    }
    return next(specifier, context);
  },
});
