'use strict';

/**
 * Waffo Pancake MoR 客户端封装（Vercel Node Function · CommonJS）。
 *
 * RSA 私钥只来自服务端环境变量，绝不写入源码或下发前端。
 * SDK 自带密钥格式归一化（PEM / PKCS#1 / 环境变量里的字面 \n / 裸 base64），
 * 因此单行环境变量即可。
 *
 * 环境变量：
 *   WAFFO_MERCHANT_ID  MER_{base62}
 *   WAFFO_PRIVATE_KEY  RSA 私钥（PEM）
 *   WAFFO_BASE_URL     可选，API 基址（默认 https://api.waffo.ai）
 *   WAFFO_PRODUCT_IDS  可选，JSON 映射 { "tokpure-pro": "PROD_xxx", ... }
 */

let cachedClient = null;

/** 懒加载 SDK，避免未安装依赖时整个函数文件加载失败。 */
function sdk() {
  // eslint-disable-next-line global-require
  return require('@waffo/pancake-ts');
}

function isConfigured() {
  return Boolean(process.env.WAFFO_MERCHANT_ID && process.env.WAFFO_PRIVATE_KEY);
}

function getClient() {
  if (cachedClient) return cachedClient;
  const merchantId = process.env.WAFFO_MERCHANT_ID;
  const privateKey = process.env.WAFFO_PRIVATE_KEY;
  if (!merchantId || !privateKey) {
    throw new Error('Waffo 未配置：缺少 WAFFO_MERCHANT_ID / WAFFO_PRIVATE_KEY');
  }
  const { WaffoPancake } = sdk();
  cachedClient = new WaffoPancake({
    merchantId,
    privateKey,
    baseUrl: process.env.WAFFO_BASE_URL || undefined,
  });
  return cachedClient;
}

/** 解析套餐 → Waffo 商品 ID。 */
function getProductId(planId) {
  const raw = process.env.WAFFO_PRODUCT_IDS;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw)[planId];
  } catch {
    console.warn('[Waffo] WAFFO_PRODUCT_IDS 不是合法 JSON');
    return undefined;
  }
}

module.exports = { sdk, isConfigured, getClient, getProductId };
