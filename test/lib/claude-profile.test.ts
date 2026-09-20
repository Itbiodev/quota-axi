import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CONFIG_DIRS_ENV,
  CLAUDE_KEYCHAIN_SERVICE,
  CLAUDE_OAUTH_TOKEN_ENV,
  claudeAccountKey,
  claudeEnvOauthToken,
  claudeProfileLocations,
  discoverClaudeProfileLanes,
  runWithClaudeProfile,
} from "../../src/lib/claude-profile.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalClaudeStorageDir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
const originalClaudeDirs = process.env[CLAUDE_CONFIG_DIRS_ENV];
const originalClaudeToken = process.env[CLAUDE_OAUTH_TOKEN_ENV];
let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-claude-profile-"));
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  delete process.env[CLAUDE_CONFIG_DIRS_ENV];
  delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
});

afterEach(() => {
  restore("HOME", originalHome);
  restore("USERPROFILE", originalUserProfile);
  restore("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
  restore("CLAUDE_SECURESTORAGE_CONFIG_DIR", originalClaudeStorageDir);
  restore(CLAUDE_CONFIG_DIRS_ENV, originalClaudeDirs);
  restore(CLAUDE_OAUTH_TOKEN_ENV, originalClaudeToken);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function writeProfile(dir: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: marker } }),
  );
}

describe("Claude profile account keys", () => {
  it("names home siblings from their directory basename", () => {
    expect(claudeAccountKey(join(tempDir!, ".claude"))).toBe("claude");
    expect(claudeAccountKey(join(tempDir!, ".claude-whc"))).toBe("claude-whc");
  });
});

describe("Claude profile discovery", () => {
  it("stays on the single selected profile when no sibling exists", () => {
    writeProfile(join(tempDir!, ".claude"), "default-token");
    expect(discoverClaudeProfileLanes()).toBeUndefined();
  });

  it("enrolls ~/.claude and ~/.claude-whc as separate lanes", () => {
    writeProfile(join(tempDir!, ".claude"), "default-token");
    writeProfile(join(tempDir!, ".claude-whc"), "whc-token");

    const lanes = discoverClaudeProfileLanes();
    expect(lanes?.map((lane) => lane.accountKey)).toEqual([
      "claude",
      "claude-whc",
    ]);
    expect(lanes?.[0]).toMatchObject({
      selected: true,
      configured: false,
      includeEnvToken: true,
      accountKey: "claude",
    });
    expect(lanes?.[1]).toMatchObject({
      selected: false,
      configured: true,
      includeEnvToken: false,
      accountKey: "claude-whc",
    });
  });

  it("keeps an explicit CLAUDE_CONFIG_DIR first and still finds ~/.claude", () => {
    const selected = join(tempDir!, ".claude-whc");
    writeProfile(join(tempDir!, ".claude"), "default-token");
    writeProfile(selected, "whc-token");
    process.env.CLAUDE_CONFIG_DIR = selected;

    const lanes = discoverClaudeProfileLanes();
    expect(lanes?.map((lane) => [lane.accountKey, lane.selected])).toEqual([
      ["claude-whc", true],
      ["claude", false],
    ]);
    expect(lanes?.[0]?.configured).toBe(true);
    expect(lanes?.[1]?.configured).toBe(false);
    expect(lanes?.[1]?.includeEnvToken).toBe(false);
  });

  it("ignores .claude.json files and empty sibling directories", () => {
    writeProfile(join(tempDir!, ".claude"), "default-token");
    writeFileSync(join(tempDir!, ".claude.json"), "{}");
    mkdirSync(join(tempDir!, ".claude-empty"));
    writeProfile(join(tempDir!, ".claude-whc"), "whc-token");

    expect(
      discoverClaudeProfileLanes()?.map((lane) => lane.accountKey),
    ).toEqual(["claude", "claude-whc"]);
  });

  it("enrolls an explicit extra directory that is not a home sibling", () => {
    writeProfile(join(tempDir!, ".claude"), "default-token");
    const extra = join(tempDir!, "work", "claude-profile");
    writeProfile(extra, "work-token");
    process.env[CLAUDE_CONFIG_DIRS_ENV] = extra;

    const lanes = discoverClaudeProfileLanes();
    expect(lanes?.map((lane) => lane.accountKey)).toEqual([
      "claude",
      "claude-profile",
    ]);
    expect(lanes?.[1]).toMatchObject({
      configDir: extra,
      configured: true,
      selected: false,
    });
  });
});

describe("Claude profile overrides", () => {
  it("does not inherit the process env token or config dir on an extra lane", () => {
    process.env.CLAUDE_CONFIG_DIR = join(tempDir!, ".claude");
    process.env[CLAUDE_OAUTH_TOKEN_ENV] = "sk-ant-process-token";
    const extra = join(tempDir!, ".claude-whc");

    const extraLocations = runWithClaudeProfile(
      {
        configDir: extra,
        configured: true,
        includeEnvToken: false,
        accountKey: "claude-whc",
      },
      () => ({
        locations: claudeProfileLocations(),
        token: claudeEnvOauthToken(),
      }),
    );

    expect(extraLocations.token).toBeUndefined();
    expect(extraLocations.locations.configDir).toBe(extra);
    expect(extraLocations.locations.keychainService).toBe(
      `${CLAUDE_KEYCHAIN_SERVICE}-${createHash("sha256")
        .update(extra.normalize("NFC"))
        .digest("hex")
        .slice(0, 8)}`,
    );
    expect(extraLocations.locations.acceptsOpaqueDefaultItem).toBe(false);
  });

  it("keeps the unsuffixed Keychain service for the default home profile", () => {
    const homeProfile = join(tempDir!, ".claude");
    const locations = runWithClaudeProfile(
      {
        configDir: homeProfile,
        configured: false,
        includeEnvToken: true,
      },
      () => claudeProfileLocations(),
    );

    expect(locations.keychainService).toBe(CLAUDE_KEYCHAIN_SERVICE);
    expect(locations.acceptsOpaqueDefaultItem).toBe(true);
  });
});
