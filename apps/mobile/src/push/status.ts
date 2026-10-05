export type PushStatus =
  | "signed_out"
  | "registering"
  | "expo_go"
  | "unsupported"
  | "permission_denied"
  | "project_missing"
  | "token_failed"
  | "server_failed"
  | "ready";
let current: PushStatus = "signed_out";
const listeners = new Set<() => void>();
export const getPushStatus = () => current;
export const subscribePushStatus = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function setPushStatus(status: PushStatus): void {
  if (current === status) return;
  current = status;
  listeners.forEach((listener) => listener());
}
export const PUSH_STATUS_LABELS: Record<PushStatus, string> = {
  signed_out: "未登录",
  registering: "正在注册",
  expo_go: "Expo Go 不支持",
  unsupported: "当前平台不支持",
  permission_denied: "通知未授权",
  project_missing: "缺少项目配置",
  token_failed: "获取设备标识失败",
  server_failed: "服务器注册失败",
  ready: "设备已绑定",
};
export const PUSH_STATUS_DETAILS: Record<PushStatus, string> = {
  signed_out: "登录后注册当前设备。",
  registering: "正在向系统获取推送标识并绑定账号。",
  expo_go:
    "Expo Go 不支持真实远程推送。本地测试通知可用于检查系统权限，但新信与送达的后台提醒需要独立 App。",
  unsupported: "请使用 iOS 或 Android 独立 App。",
  permission_denied: "请在系统设置中允许驿书发送通知，然后重新打开应用。",
  project_missing: "构建时未提供 EAS project ID。",
  token_failed:
    "未能获取推送标识。Android 需要配置 Firebase / FCM；iOS 独立 App 需要 Apple 推送凭据。也请检查网络。",
  server_failed: "设备未绑定成功，请检查网络后重新打开应用。",
  ready: "设备已绑定账号。这不代表通知已实际送达；仍需平台凭据、服务回执和真机验收。",
};
