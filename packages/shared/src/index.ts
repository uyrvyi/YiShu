/**
 * 驿书 V1 共享基础设施（前后端共用）。
 *
 * Phase 1 仅保留最基础的基础设施常量。
 * 业务领域类型（TransportType / LetterStatus / RecipientReadState 等）
 * 将在对应 Phase（Phase 2/3）引入，不提前冻结公共接口。
 */

/** API 统一前缀（对应开发规范 §71）。 */
export const API_PREFIX = "/api/v1";
