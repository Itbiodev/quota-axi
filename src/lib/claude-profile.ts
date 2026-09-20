import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { usableLiteralSecret } from "./secret.js";

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * The environment credential Claude Code itself resolves before it consults any
 * stored credential, so an explicit token here names the account a session is
 * actually using.
 */
export const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Extra Claude Code config directories, path-separated (`:` on POSIX, `;` on
 * Windows). Each existing directory is enrolled as its own account lane
 * alongside the process-selected profile and any home-directory siblings.
 */
export const CLAUDE_CONFIG_DIRS_ENV = "QUOTA_AXI_CLAUDE_CONFIG_DIRS";

const HOME_PROFILE_NAME = /^\.claude($|[-_].+)/;
const ACCOUNT_KEY = /^[a-z0-9][a-z0-9:_-]{0,95}$/;

/**
 * Per-lane Claude Code profile selection. Extra profiles never inherit the
 * process environment token or secure-storage selector: those name the account
 * a live session is using, not a bystander directory.
 */
export type ClaudeProfileOverride = {
  configDir: string;
  /**
   * True when this lane is (or is treated as) an explicit `CLAUDE_CONFIG_DIR`
   * selection, so the Keychain service is hashed from the directory. The
   * default `~/.claude` home profile stays unsuffixed.
   */
  configured: boolean;
  includeEnvToken: boolean;
  secureStorageDir?: string;
  accountKey?: string;
};

const profileStore = new AsyncLocalStorage<ClaudeProfileOverride>();

export function runWithClaudeProfile<T>(
  override: ClaudeProfileOverride,
  fn: () => T,
): T {
  return profileStore.run(override, fn);
}

export function claudeProfileOverride(): ClaudeProfileOverride | undefined {
  return profileStore.getStore();
}

/**
 * The explicitly supplied environment access token, when one is usable as a
 * literal bearer. Absent, empty, and unusable values all resolve to
 * `undefined`, which leaves discovery of the stored credential untouched. The
 * value is returned for request use only and is never logged or persisted.
 *
 * An extra profile lane never inherits this token: it names the account the
 * current process is using, not a sibling directory.
 *
 * @returns the literal token, or undefined when none is supplied
 */
export function claudeEnvOauthToken(): string | undefined {
  if (profileStore.getStore()?.includeEnvToken === false) return undefined;
  return usableLiteralSecret(process.env[CLAUDE_OAUTH_TOKEN_ENV]?.trim());
}

/**
 * Mirrors Claude Code's configuration and secure-storage selectors. The
 * credential directory is `CLAUDE_CONFIG_DIR` or `~/.claude`; a nonempty
 * secure-storage selector names the Keychain service instead.
 *
 * A profile override, when one is running, is the selector: extra lanes must
 * not leak the process environment's directory or Keychain item.
 */
export function claudeProfileLocations(): {
  configDir: string;
  secureStorageSelected: boolean;
  keychainService: string;
  acceptsOpaqueDefaultItem: boolean;
} {
  const override = profileStore.getStore();
  if (override) {
    return locationsFrom(
      override.configDir,
      override.configured,
      override.secureStorageDir,
    );
  }
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return locationsFrom(
    configured ?? defaultClaudeConfigDir(),
    Boolean(configured),
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  );
}

function locationsFrom(
  configDirRaw: string,
  configured: boolean,
  storageRaw: string | undefined,
): {
  configDir: string;
  secureStorageSelected: boolean;
  keychainService: string;
  acceptsOpaqueDefaultItem: boolean;
} {
  const configDir = configDirRaw.normalize("NFC");
  // Hash the raw NFC path, just as the vendor does: resolving a relative path
  // or expanding ~ would select another item.
  const storageSelector = storageRaw ? storageRaw.normalize("NFC") : undefined;
  const selector = storageSelector ?? (configured ? configDir : undefined);
  return {
    configDir,
    secureStorageSelected: storageSelector !== undefined,
    keychainService: selector
      ? suffixedKeychainService(selector)
      : CLAUDE_KEYCHAIN_SERVICE,
    // A default selection cannot re-derive the suffix Claude Code gave its own
    // item, so a suffixed item may still be this profile's. An explicit
    // selector names one exact item and must never fall through to another.
    acceptsOpaqueDefaultItem: selector === undefined,
  };
}

function defaultClaudeConfigDir(): string {
  return join(homedir(), ".claude").normalize("NFC");
}

/** The `Claude Code-credentials-<8 lowercase hex>` shape the vendor writes. */
export function isOpaqueSuffixedKeychainService(service: string): boolean {
  return (
    service.startsWith(`${CLAUDE_KEYCHAIN_SERVICE}-`) &&
    /^[0-9a-f]{8}$/.test(service.slice(CLAUDE_KEYCHAIN_SERVICE.length + 1))
  );
}

function suffixedKeychainService(selector: string): string {
  const suffix = createHash("sha256")
    .update(selector)
    .digest("hex")
    .slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

export type ClaudeProfileLane = ClaudeProfileOverride & {
  selected: boolean;
  accountKey: string;
};

/**
 * Local Claude Code config directories that should each be read as their own
 * account. Returns undefined when only the process-selected profile exists, so
 * a single-profile machine keeps the legacy keyless report.
 *
 * Home-directory siblings named `.claude` or `.claude-*` / `.claude_*` are
 * enrolled when they look like a Claude Code profile (a `.credentials.json` or
 * `settings.json`). `$QUOTA_AXI_CLAUDE_CONFIG_DIRS` adds directories the user
 * named explicitly. The process-selected profile is always a lane.
 */
export function discoverClaudeProfileLanes(): ClaudeProfileLane[] | undefined {
  if (profileStore.getStore()) return undefined;

  const selectedConfigured = Boolean(process.env.CLAUDE_CONFIG_DIR);
  const selectedDir = selectedConfigured
    ? process.env.CLAUDE_CONFIG_DIR!
    : defaultClaudeConfigDir();
  const byResolved = new Map<
    string,
    { configDir: string; configured: boolean; selected: boolean }
  >();

  const add = (
    configDir: string,
    configured: boolean,
    selected: boolean,
  ): void => {
    const resolved = resolve(configDir);
    const existing = byResolved.get(resolved);
    if (existing) {
      if (selected) {
        existing.selected = true;
        existing.configured = configured;
        existing.configDir = configDir;
      }
      return;
    }
    byResolved.set(resolved, { configDir, configured, selected });
  };

  add(selectedDir, selectedConfigured, true);
  const defaultHome = resolve(defaultClaudeConfigDir());
  for (const dir of homeClaudeProfileDirs()) {
    add(dir, resolve(dir) !== defaultHome, false);
  }
  for (const dir of extraClaudeProfileDirs()) {
    add(dir, true, false);
  }

  const discovered = [...byResolved.values()].filter(
    (entry) => entry.selected || isPresentClaudeProfileDir(entry.configDir),
  );
  if (discovered.length < 2) return undefined;

  const selected = discovered.filter((entry) => entry.selected);
  const others = discovered
    .filter((entry) => !entry.selected)
    .sort((left, right) =>
      claudeAccountKey(left.configDir).localeCompare(
        claudeAccountKey(right.configDir),
      ),
    );
  const usedKeys = new Set<string>();
  const selectedStorage = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  return [...selected, ...others].map((entry) => {
    const accountKey = uniqueAccountKey(entry.configDir, usedKeys);
    return {
      configDir: entry.configDir,
      configured: entry.configured,
      selected: entry.selected,
      includeEnvToken: entry.selected,
      ...(entry.selected && selectedStorage
        ? { secureStorageDir: selectedStorage }
        : {}),
      accountKey,
    };
  });
}

function homeClaudeProfileDirs(): string[] {
  let names: string[];
  try {
    names = readdirSync(homedir());
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of names) {
    if (!HOME_PROFILE_NAME.test(name)) continue;
    const dir = join(homedir(), name);
    if (isPresentClaudeProfileDir(dir)) dirs.push(dir);
  }
  return dirs;
}

function extraClaudeProfileDirs(): string[] {
  const raw = process.env[CLAUDE_CONFIG_DIRS_ENV];
  if (!raw) return [];
  const dirs: string[] = [];
  for (const item of raw.split(delimiter)) {
    const dir = item.trim();
    if (!dir) continue;
    try {
      if (statSync(dir).isDirectory()) dirs.push(dir);
    } catch {
      continue;
    }
  }
  return dirs;
}

function isPresentClaudeProfileDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return (
    existsSync(join(dir, ".credentials.json")) ||
    existsSync(join(dir, "settings.json"))
  );
}

export function claudeAccountKey(configDir: string): string {
  const base = basename(configDir.normalize("NFC"));
  let key = base
    .replace(/^\./, "")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (key.length > 96) key = key.slice(0, 96).replace(/-+$/g, "");
  if (ACCOUNT_KEY.test(key)) return key;
  return hashedAccountKey(configDir);
}

function uniqueAccountKey(configDir: string, used: Set<string>): string {
  const base = claudeAccountKey(configDir);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const hashed = hashedAccountKey(configDir);
  used.add(hashed);
  return hashed;
}

function hashedAccountKey(configDir: string): string {
  const suffix = createHash("sha256")
    .update(resolve(configDir))
    .digest("hex")
    .slice(0, 8);
  return `claude-${suffix}`;
}
