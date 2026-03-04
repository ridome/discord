import { AccessControl } from "../src/security/accessControl";

describe("AccessControl", () => {
  const access = new AccessControl({
    allowedUserIds: new Set(["u1"]),
    allowedChannelIds: new Set(["c1"]),
    allowedRoleIds: new Set(["r1"])
  });

  it("allows matching user/channel/role", () => {
    const result = access.check({ userId: "u1", channelId: "c1", roleIds: ["r1"] });
    expect(result.ok).toBe(true);
  });

  it("blocks wrong role", () => {
    const result = access.check({ userId: "u1", channelId: "c1", roleIds: ["r2"] });
    expect(result.ok).toBe(false);
  });

  it("skips role check when allowedRoleIds is empty", () => {
    const noRoleLimit = new AccessControl({
      allowedUserIds: new Set(["u1"]),
      allowedChannelIds: new Set(["c1"]),
      allowedRoleIds: new Set()
    });

    const result = noRoleLimit.check({ userId: "u1", channelId: "c1", roleIds: [] });
    expect(result.ok).toBe(true);
  });
});
