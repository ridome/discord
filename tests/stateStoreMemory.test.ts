import fs from "fs";
import os from "os";
import path from "path";
import { StateStore } from "../src/store/stateStore";

describe("StateStore memory", () => {
  let tempDir: string;
  let dbPath: string;
  let store: StateStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-memory-"));
    dbPath = path.join(tempDir, "state.db");
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("upserts and lists memory per user", () => {
    const first = store.upsertMemory("u1", "c1", "偏好中文回复", "manual");
    expect(first.created).toBe(true);
    expect(first.record.id).toBeGreaterThan(0);

    const second = store.upsertMemory("u1", "c1", "偏好中文回复", "gemini");
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.source).toBe("gemini");

    const list = store.listMemories("u1", 10);
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe("偏好中文回复");
  });

  it("deletes and clears memories", () => {
    const a = store.upsertMemory("u2", "c1", "记忆A", "manual");
    const b = store.upsertMemory("u2", "c1", "记忆B", "manual");

    expect(store.deleteMemory("u2", a.record.id)).toBe(true);
    expect(store.deleteMemory("u2", a.record.id)).toBe(false);

    const removed = store.clearMemories("u2");
    expect(removed).toBeGreaterThanOrEqual(1);

    const list = store.listMemories("u2", 10);
    expect(list).toHaveLength(0);
    expect(b.record.id).toBeGreaterThan(0);
  });

  it("supports per-user auto memory setting", () => {
    expect(store.isAutoMemoryEnabled("u3")).toBe(true);
    store.setAutoMemoryEnabled("u3", false);
    expect(store.isAutoMemoryEnabled("u3")).toBe(false);
    store.setAutoMemoryEnabled("u3", true);
    expect(store.isAutoMemoryEnabled("u3")).toBe(true);
  });

  it("stores recent user context per user and channel", () => {
    store.addUserContextMessage("u1", "c1", "第一句");
    store.addUserContextMessage("u1", "c1", "第二句");
    store.addUserContextMessage("u1", "c1", "第三句");
    store.addUserContextMessage("u1", "c2", "另一个频道");
    store.addUserContextMessage("u2", "c1", "另一个用户");

    const context = store.listRecentUserContext("u1", "c1", 2);
    expect(context).toHaveLength(2);
    expect(context[0].content).toBe("第二句");
    expect(context[1].content).toBe("第三句");
  });

  it("cleans old user context", () => {
    store.addUserContextMessage("u1", "c1", "将被清理");
    expect(store.listRecentUserContext("u1", "c1", 10)).toHaveLength(1);
    store.cleanupOldUserContext(0);
    expect(store.listRecentUserContext("u1", "c1", 10)).toHaveLength(0);
  });
});
