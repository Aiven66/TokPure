/**
 * 定价模块的默认数据与类型出口。
 *
 * 将 `../config/defaults` 中的默认套餐 / 积分包与相关类型统一转发，
 * 方便宿主直接引用，例如：
 *   import { DEFAULT_PLANS, DEFAULT_CREDIT_PACKS } from './public-pkg/pricing/plans';
 *   const config = { brand: {...}, pricing: { plans: DEFAULT_PLANS, creditPacks: DEFAULT_CREDIT_PACKS } };
 *
 * 注意：这些只是默认值，宿主可完全替换为自己的套餐 / 积分包。
 */

export { DEFAULT_PLANS, DEFAULT_CREDIT_PACKS } from '../config/defaults';

export type {
  PlanConfig,
  PlanPrice,
  CreditPack,
  PaymentMethodBadge,
  PricingConfig,
} from '../config/types';