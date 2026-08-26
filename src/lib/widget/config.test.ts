import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Uses an isolated throwaway SQLite fixture per test (same convention as
 * `src/lib/storage/index.test.ts`) rather than the product's real `./data/kyzerdocs.db` — this
 * module only needs a `StorageDriver`, and local mode is the cheapest, credential-free one to
 * exercise. `vi.resetModules()` before each import matches `PRODUCT_CONFIG`'s
 * snapshot-`process.env`-at-import-time behaviour.
 */
describe("widget/config", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDatabasePath = process.env.DATABASE_PATH;
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kdl-widget-config-test-"));
    process.env.DATABASE_PATH = join(testDir, "test.db");
    delete process.env.DATABASE_URL;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = originalDatabasePath;
    }
    rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("exports DEFAULT_WIDGET_CONFIG matching UI-SPEC's defaults", async () => {
    const { DEFAULT_WIDGET_CONFIG } = await import("./config.js");
    expect(DEFAULT_WIDGET_CONFIG.accentColor).toBe("#0E4F4A");
    expect(DEFAULT_WIDGET_CONFIG.position).toBe("bottom-right");
  });

  it("returns a schema-valid default config for a kbId that was never configured", async () => {
    const { getWidgetConfig, widgetConfigSchema } = await import("./config.js");
    const config = await getWidgetConfig("never-configured-kb");
    expect(() => widgetConfigSchema.parse(config)).not.toThrow();
  });

  it("round-trips a config written by setWidgetConfig", async () => {
    const { getWidgetConfig, setWidgetConfig, DEFAULT_WIDGET_CONFIG } = await import("./config.js");
    const kbId = "roundtrip-kb";
    const custom = {
      ...DEFAULT_WIDGET_CONFIG,
      productName: "Acme Support",
      title: "Ask Acme",
      allowedDomains: ["acme.example"],
    };

    await setWidgetConfig(kbId, custom);
    const stored = await getWidgetConfig(kbId);

    expect(stored).toEqual(custom);
  });

  it("returns defaults, not a throw, when the stored blob fails schema validation", async () => {
    const { getWidgetConfig } = await import("./config.js");
    const { getStorageDriver } = await import("../storage/index.js");
    const kbId = "corrupt-kb";

    const driver = getStorageDriver();
    // Deliberately corrupt: accentColor is not a valid hex colour at all.
    await driver.setSetting(`widget:${kbId}`, JSON.stringify({ accentColor: "not-a-color" }), 0);

    const config = await getWidgetConfig(kbId);
    expect(config.accentColor).toBe("#0E4F4A");
  });

  it("returns defaults, not a throw, when the stored blob is not valid JSON", async () => {
    const { getWidgetConfig } = await import("./config.js");
    const { getStorageDriver } = await import("../storage/index.js");
    const kbId = "malformed-json-kb";

    const driver = getStorageDriver();
    await driver.setSetting(`widget:${kbId}`, "{not json", 0);

    const config = await getWidgetConfig(kbId);
    expect(config.productName).toBe("KyzerDocs");
  });

  it("rejects an out-of-range accentColor at write time via widgetConfigSchema", async () => {
    const { setWidgetConfig, DEFAULT_WIDGET_CONFIG } = await import("./config.js");
    await expect(
      setWidgetConfig("bad-write-kb", { ...DEFAULT_WIDGET_CONFIG, accentColor: "red" }),
    ).rejects.toThrow();
  });
});
