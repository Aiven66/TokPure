'use strict';

/**
 * GET /api/payment/channels
 *
 * 返回当前环境里真正可用的支付渠道。前端据此隐藏未配置的渠道，
 * 避免用户点到「必然失败」的按钮——这是此前没有付费用户之外最容易掉单的断点。
 */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const creem = Boolean(process.env.CREEM_API_KEY && process.env.CREEM_PRODUCT_IDS);
  const waffo = Boolean(
    process.env.WAFFO_MERCHANT_ID && process.env.WAFFO_PRIVATE_KEY && process.env.WAFFO_PRODUCT_IDS,
  );

  res.status(200).json({
    channels: [
      { id: 'creem', ready: creem },
      { id: 'waffo', ready: waffo },
    ],
  });
};
