export interface AccessContext {
  userId: string;
  channelId: string;
  roleIds: string[];
}

export interface AccessControlConfig {
  allowedUserIds: Set<string>;
  allowedChannelIds: Set<string>;
  allowedRoleIds: Set<string>;
}

export class AccessControl {
  constructor(private readonly config: AccessControlConfig) {}

  public check(context: AccessContext): { ok: boolean; reason?: string } {
    if (!this.config.allowedUserIds.has(context.userId)) {
      return { ok: false, reason: "User not allowed" };
    }

    if (!this.config.allowedChannelIds.has(context.channelId)) {
      return { ok: false, reason: "Channel not allowed" };
    }

    if (this.config.allowedRoleIds.size > 0) {
      const hasRole = context.roleIds.some((role) => this.config.allowedRoleIds.has(role));
      if (!hasRole) {
        return { ok: false, reason: "Role not allowed" };
      }
    }

    return { ok: true };
  }
}
