/**
 * 用户对外安全视图。
 * 绝不暴露：passwordHash、internal BIGINT id。
 */

export interface UserPublicView {
  account: string;
  uid: string;
  nickname: string;
  avatarUrl?: string | null;
  region: {
    province: string;
    city: string;
    district: string;
  };
}

/** 将 Prisma User 转换为对外安全视图（不包含 id / passwordHash）。 */
export function toUserPublicView(user: {
  account: string;
  uid: string;
  nickname: string;
  province: string;
  city: string;
  district: string;
  avatarId?: string | null;
}): UserPublicView {
  return {
    account: user.account,
    uid: user.uid,
    nickname: user.nickname,
    avatarUrl: user.avatarId ? `/api/v1/media/${user.avatarId}` : null,
    region: {
      province: user.province,
      city: user.city,
      district: user.district,
    },
  };
}
