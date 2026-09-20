/**
 * Build dist when this tree still has sources (a git clone / `npx github:…`).
 * A registry install only unpacks `files`, so `src/` is absent and this is a
 * no-op — `prepublishOnly` already compiled before publish.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync("src") || !existsSync("tsconfig.json")) process.exit(0);

const localTsc = "node_modules/typescript/bin/tsc";
const result = existsSync(localTsc)
  ? spawnSync(process.execPath, [localTsc], { stdio: "inherit" })
  : spawnSync("npx", ["--yes", "typescript@6.0.3"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
