import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCachedProvider, writeCachedProviders } from "../../src/cache.js";
import { fetchAccountQuotas } from "../../src/providers/accounts.js";
import { renderQuotaTui } from "../../src/tui.js";
import type { ProviderOptions } from "../../src/types.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let tempDir: string | undefined;

const OPTIONS: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
};

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-claude-accounts-"));
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "linux",
  });
  vi.doMock("../../src/lib/process.js", async (importOriginal) => {
    const actual =
      await importOriginal<typeof import("../../src/lib/process.js")>();
    return {
      ...actual,
      execFileText: vi.fn(async () => {
        throw new Error("unexpected process call");
      }),
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  vi.resetModules();
  if (originalPlatform)
    Object.defineProperty(process, "platform", originalPlatform);
  restore("HOME", originalHome);
  restore("USERPROFILE", originalUserProfile);
  restore("XDG_CACHE_HOME", originalXdgCacheHome);
  restore("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
  restore("CLAUDE_CODE_OAUTH_TOKEN", originalClaudeToken);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function writeClaudeConfigCredential(configDir: string, token: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        expiresAt: "2035-01-01T00:00:00.000Z",
      },
    }),
  );
}

function stubUsageByToken(
  usage: Record<string, { percent: number; accountId: string }>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const authorization = (
        init?.headers as Record<string, string> | undefined
      )?.authorization;
      const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
      const entry = usage[token];
      if (!entry) {
        return new Response("unauthorized", { status: 401 });
      }
      if (String(input).endsWith("/api/oauth/profile")) {
        return new Response(
          JSON.stringify({ account: { uuid: entry.accountId } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ five_hour: { utilization: entry.percent } }),
        { status: 200 },
      );
    }),
  );
}

describe("Claude home-profile account lanes", () => {
  it("reports ~/.claude and ~/.claude-whc independently", async () => {
    writeClaudeConfigCredential(
      join(tempDir!, ".claude"),
      "CLAUDE-SENTINEL-DO-NOT-LEAK-DEFAULT-210001",
    );
    writeClaudeConfigCredential(
      join(tempDir!, ".claude-whc"),
      "CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210002",
    );
    stubUsageByToken({
      "CLAUDE-SENTINEL-DO-NOT-LEAK-DEFAULT-210001": {
        percent: 12,
        accountId: "acct-default",
      },
      "CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210002": {
        percent: 44,
        accountId: "acct-whc",
      },
    });

    const { claudeAdapter } = await import("../../src/providers/claude.js");
    const reports = await fetchAccountQuotas(claudeAdapter, OPTIONS);

    expect(reports).toHaveLength(2);
    expect(reports.map((report) => report.accountKey)).toEqual([
      "claude",
      "claude-whc",
    ]);
    expect(reports[0]).toMatchObject({
      provider: "claude",
      source: "oauth",
      account: { accountId: "acct-default" },
      windows: [{ percentUsed: 12 }],
      state: { status: "fresh" },
    });
    expect(reports[1]).toMatchObject({
      provider: "claude",
      source: "oauth",
      account: { accountId: "acct-whc" },
      windows: [{ percentUsed: 44 }],
      state: { status: "fresh" },
    });
    expect(JSON.stringify(reports)).not.toMatch(
      /CLAUDE-SENTINEL-DO-NOT-LEAK-DEFAULT-210001|CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210002/,
    );
  });

  it("does not apply the process env token to a sibling profile", async () => {
    writeClaudeConfigCredential(
      join(tempDir!, ".claude"),
      "CLAUDE-SENTINEL-DO-NOT-LEAK-STORED-210003",
    );
    writeClaudeConfigCredential(
      join(tempDir!, ".claude-whc"),
      "CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210004",
    );
    process.env.CLAUDE_CODE_OAUTH_TOKEN =
      "CLAUDE-SENTINEL-DO-NOT-LEAK-ENV-210005";
    stubUsageByToken({
      "CLAUDE-SENTINEL-DO-NOT-LEAK-ENV-210005": {
        percent: 8,
        accountId: "acct-env",
      },
      "CLAUDE-SENTINEL-DO-NOT-LEAK-STORED-210003": {
        percent: 90,
        accountId: "acct-stored",
      },
      "CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210004": {
        percent: 33,
        accountId: "acct-whc",
      },
    });

    const { claudeAdapter } = await import("../../src/providers/claude.js");
    const reports = await fetchAccountQuotas(claudeAdapter, OPTIONS);

    expect(reports[0]).toMatchObject({
      accountKey: "claude",
      account: { accountId: "acct-env" },
      windows: [{ percentUsed: 8 }],
    });
    expect(reports[1]).toMatchObject({
      accountKey: "claude-whc",
      account: { accountId: "acct-whc" },
      windows: [{ percentUsed: 33 }],
    });
  });

  it("does not hide a live sibling when the selected profile is signed out", async () => {
    writeClaudeConfigCredential(
      join(tempDir!, ".claude"),
      "CLAUDE-SENTINEL-DO-NOT-LEAK-DEAD-210006",
    );
    writeClaudeConfigCredential(
      join(tempDir!, ".claude-whc"),
      "CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210007",
    );
    stubUsageByToken({
      "CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210007": {
        percent: 21,
        accountId: "acct-whc",
      },
    });

    const { claudeAdapter } = await import("../../src/providers/claude.js");
    const reports = await fetchAccountQuotas(claudeAdapter, OPTIONS);

    expect(reports[0]?.state.status).toBe("auth_required");
    expect(reports[0]?.windows).toEqual([]);
    expect(reports[1]).toMatchObject({
      accountKey: "claude-whc",
      windows: [{ percentUsed: 21 }],
      state: { status: "fresh" },
    });
  });

  it("names each profile on its TUI card", async () => {
    writeClaudeConfigCredential(
      join(tempDir!, ".claude"),
      "CLAUDE-SENTINEL-DO-NOT-LEAK-DEFAULT-210008",
    );
    writeClaudeConfigCredential(
      join(tempDir!, ".claude-whc"),
      "CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210009",
    );
    stubUsageByToken({
      "CLAUDE-SENTINEL-DO-NOT-LEAK-DEFAULT-210008": {
        percent: 10,
        accountId: "acct-default",
      },
      "CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210009": {
        percent: 50,
        accountId: "acct-whc",
      },
    });

    const { claudeAdapter } = await import("../../src/providers/claude.js");
    const reports = await fetchAccountQuotas(claudeAdapter, OPTIONS);
    const output = renderQuotaTui(
      {
        generatedAt: "2026-07-06T18:10:00.000Z",
        schemaVersion: 6,
        providers: reports,
      },
      { columns: 120, timeZone: "UTC" },
    );

    expect(output).toContain("account claude ");
    expect(output).toContain("account claude-whc ");
    expect((output.match(/╭─ ● claude /g) ?? []).length).toBe(2);
  });

  it("does not open sibling profiles under --profile-only", async () => {
    writeClaudeConfigCredential(
      join(tempDir!, ".claude"),
      "CLAUDE-SENTINEL-DO-NOT-LEAK-DEFAULT-210010",
    );
    writeClaudeConfigCredential(
      join(tempDir!, ".claude-whc"),
      "CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210011",
    );
    process.env.CLAUDE_CONFIG_DIR = join(tempDir!, ".claude-whc");
    stubUsageByToken({
      "CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210011": {
        percent: 17,
        accountId: "acct-whc",
      },
    });

    const { claudeAdapter } = await import("../../src/providers/claude.js");
    const reports = await fetchAccountQuotas(claudeAdapter, {
      ...OPTIONS,
      credentialMode: "profile-only",
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.accountKey).toBeUndefined();
    expect(reports[0]).toMatchObject({
      account: { accountId: "acct-whc" },
      windows: [{ percentUsed: 17 }],
    });
  });

  it("caches each Claude profile in its own slot", async () => {
    writeClaudeConfigCredential(
      join(tempDir!, ".claude"),
      "CLAUDE-SENTINEL-DO-NOT-LEAK-DEFAULT-210012",
    );
    writeClaudeConfigCredential(
      join(tempDir!, ".claude-whc"),
      "CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210013",
    );
    stubUsageByToken({
      "CLAUDE-SENTINEL-DO-NOT-LEAK-DEFAULT-210012": {
        percent: 12,
        accountId: "acct-default",
      },
      "CLAUDE-SENTINEL-DO-NOT-LEAK-WHC-210013": {
        percent: 44,
        accountId: "acct-whc",
      },
    });

    const { claudeAdapter } = await import("../../src/providers/claude.js");
    const reports = await fetchAccountQuotas(claudeAdapter, OPTIONS);
    writeCachedProviders(reports);

    expect(readCachedProvider("claude", "claude")).toMatchObject({
      windows: [{ percentUsed: 12 }],
    });
    expect(readCachedProvider("claude", "claude-whc")).toMatchObject({
      windows: [{ percentUsed: 44 }],
    });
  });
});
