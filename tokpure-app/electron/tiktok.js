'use strict';

const { resolveUA, requestJSON, requestBuffer, requestStream } = require('./net');

const MOBILE_API_HOSTS = [
  'https://api22-normal-c-useast2a.tiktokv.com',
  'https://api16-normal-c-useast1a.tiktokv.com',
  'https://api-h2.tiktokv.com'
];

const MOBILE_UA =
  'com.ss.android.ugc.trill/300904 (Linux; U; Android 10; en_US; Pixel XL; Build/QP1A.191005.007.A3; Cronet/58.0.2991.0)';

/**
 * Short-lived parse cache.
 * The UI parses a link and the download engine then parses it again to resolve the
 * stream; without this the two requests land within milliseconds of each other and
 * TikTok answers the second burst with HTTP 429 (plus timeouts on the fallbacks).
 * Reusing the result for the same URL removes that redundant round-trip entirely.
 */
const PARSE_CACHE_TTL = 5 * 60 * 1000;
const parseCache = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableError(e) {
  const status = e && e.statusCode;
  if (status === 429 || status === 403 || (status >= 500 && status < 600)) return true;
  return /请求超时|ECONNRESET|socket hang up|ECONNREFUSED|EAI_AGAIN|连接被重置/i.test(
    (e && e.message) || ''
  );
}

function remember(canonical, meta) {
  try {
    parseCache.set(canonical, { at: Date.now(), meta: JSON.parse(JSON.stringify(meta)) });
    if (parseCache.size > 200) {
      [...parseCache.keys()].slice(0, 100).forEach((k) => parseCache.delete(k));
    }
  } catch (_) {
    /* caching is best-effort */
  }
  return meta;
}

function readCache(canonical) {
  const hit = parseCache.get(canonical);
  if (hit && Date.now() - hit.at < PARSE_CACHE_TTL) {
    return JSON.parse(JSON.stringify(hit.meta));
  }
  if (hit) parseCache.delete(canonical);
  return null;
}

/**
 * Extract the first tiktok URL found in arbitrary text (share copy, etc).
 */
function extractShareUrl(text) {
  if (!text) return null;
  const m = String(text).match(
    /https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[^\s"'<>]+/i
  );
  if (!m) return null;
  return m[0].replace(/[.,)\]】]+$/, '');
}

function extractAwemeId(url) {
  if (!url) return null;
  const patterns = [
    /\/video\/(\d{6,})/i,
    /\/photo\/(\d{6,})/i,
    /\/v\/(\d{6,})/i,
    /[?&]item_?id=(\d{6,})/i,
    /[?&]aweme_id=(\d{6,})/i,
    /(\d{17,21})/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function isShortLink(url) {
  return /https?:\/\/(?:vm|vt)\.tiktok\.com\//i.test(url);
}

async function normalizeUrl(url, opts) {
  if (isShortLink(url)) {
    try {
      const res = await requestStream(url, {
        headers: { 'User-Agent': resolveUA(opts.settings) },
        proxy: opts.settings && opts.settings.proxy
      });
      res.stream.resume();
      return res.url;
    } catch (e) {
      return url;
    }
  }
  // strip tracking params but keep the canonical path
  try {
    const u = new URL(url);
    u.hash = '';
    ['is_from_webapp', 'sender_device', 'web_id', 'lang', 'enter_from', 'share_app_id', 'source'].forEach(
      (k) => u.searchParams.delete(k)
    );
    return u.toString();
  } catch (_) {
    return url;
  }
}

function pickFirst(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list[0];
}

function normalizeMobile(aweme) {
  const video = aweme.video || {};
  const music = aweme.music || {};
  const author = aweme.author || {};
  const stats = aweme.statistics || {};

  const bitrates = Array.isArray(video.bit_rate) ? video.bit_rate : [];
  const sorted = bitrates
    .map((b) => ({
      bitrate: b.bit_rate || 0,
      gear: b.gear_name || '',
      quality: b.quality_type || 0,
      urls: (b.play_addr && b.play_addr.url_list) || []
    }))
    .sort((a, b) => b.bitrate - a.bitrate);

  const noWatermark = [];
  const watermarked = [];

  // Highest-bitrate stream first (play_addr is the no-watermark source in the app API)
  sorted.forEach((b) => {
    b.urls.forEach((u) => u && noWatermark.push(u));
  });
  (video.play_addr && video.play_addr.url_list || []).forEach((u) => u && noWatermark.push(u));
  (video.download_addr && video.download_addr.url_list || []).forEach((u) => u && watermarked.push(u));

  const images = [];
  if (aweme.image_post_info && Array.isArray(aweme.image_post_info.images)) {
    aweme.image_post_info.images.forEach((img) => {
      const u = img.display_image && pickFirst(img.display_image.url_list);
      if (u) images.push(u);
    });
  }

  const cover =
    pickFirst(video.cover && video.cover.url_list) ||
    pickFirst(video.origin_cover && video.origin_cover.url_list) ||
    pickFirst(video.dynamic_cover && video.dynamic_cover.url_list);

  return {
    id: aweme.aweme_id || '',
    desc: aweme.desc || '',
    createdAt: aweme.create_time ? aweme.create_time * 1000 : null,
    region: aweme.region || '',
    isPhoto: images.length > 0,
    author: {
      uniqueId: author.unique_id || '',
      nickname: author.nickname || '',
      avatar:
        pickFirst(author.avatar_larger && author.avatar_larger.url_list) ||
        pickFirst(author.avatar_thumb && author.avatar_thumb.url_list)
    },
    video: {
      noWatermark: dedupe(noWatermark),
      watermarked: dedupe(watermarked),
      cover,
      dynamicCover: pickFirst(video.dynamic_cover && video.dynamic_cover.url_list),
      duration: video.duration ? Math.round(video.duration / 1000) : 0,
      durationMs: video.duration || 0,
      width: video.width || 0,
      height: video.height || 0,
      ratio: video.ratio || '',
      bitrate: sorted[0] ? sorted[0].bitrate : 0,
      gear: sorted[0] ? sorted[0].gear : '',
      codec: video.video_quality || ''
    },
    music: {
      title: music.title || '',
      author: music.author || '',
      url: pickFirst(music.play_url && music.play_url.url_list),
      duration: music.duration ? Math.round(music.duration / 1000) : 0
    },
    stats: {
      play: stats.play_count || 0,
      digg: stats.digg_count || 0,
      comment: stats.comment_count || 0,
      share: stats.share_count || 0
    },
    images,
    source: 'mobile-api'
  };
}

function normalizeWeb(item) {
  const video = item.video || {};
  const music = item.music || {};
  const author = item.author || {};
  const stats = item.stats || item.statistics || {};

  const bitrates = Array.isArray(video.bitrateInfo) ? video.bitrateInfo : [];
  const sorted = bitrates
    .map((b) => ({
      bitrate: b.Bitrate || 0,
      gear: b.GearName || '',
      urls: (b.PlayAddr && b.PlayAddr.UrlList) || []
    }))
    .sort((a, b) => b.bitrate - a.bitrate);

  const noWatermark = [];
  const watermarked = [];
  sorted.forEach((b) => b.urls.forEach((u) => u && noWatermark.push(u)));
  if (video.playAddr) noWatermark.push(video.playAddr);
  if (video.downloadAddr) watermarked.push(video.downloadAddr);

  const images = [];
  if (item.imagePost && Array.isArray(item.imagePost.images)) {
    item.imagePost.images.forEach((img) => {
      const u =
        img.imageURL && img.imageURL.urlList && img.imageURL.urlList[0]
          ? img.imageURL.urlList[0]
          : null;
      if (u) images.push(u);
    });
  }

  return {
    id: item.id || '',
    desc: item.desc || '',
    createdAt: item.createTime ? item.createTime * 1000 : null,
    region: item.locationCreated || '',
    isPhoto: images.length > 0,
    author: {
      uniqueId: author.uniqueId || '',
      nickname: author.nickname || '',
      avatar: author.avatarLarger || author.avatarMedium || author.avatarThumb || ''
    },
    video: {
      noWatermark: dedupe(noWatermark),
      watermarked: dedupe(watermarked),
      cover: video.cover || video.originCover || '',
      dynamicCover: video.dynamicCover || '',
      duration: video.duration || 0,
      durationMs: (video.duration || 0) * 1000,
      width: video.width || 0,
      height: video.height || 0,
      ratio: video.ratio || '',
      bitrate: sorted[0] ? sorted[0].bitrate : 0,
      gear: sorted[0] ? sorted[0].gear : '',
      codec: video.codecType || ''
    },
    music: {
      title: music.title || '',
      author: music.authorName || '',
      url: music.playUrl || ''
    },
    stats: {
      play: stats.playCount || 0,
      digg: stats.diggCount || 0,
      comment: stats.commentCount || 0,
      share: stats.shareCount || 0
    },
    images,
    source: 'web-api'
  };
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

async function tryMobileApi(awemeId, settings) {
  const deviceId = String(Math.floor(7e17 + Math.random() * 1e17));
  const params = new URLSearchParams({
    aweme_id: awemeId,
    aid: '1988',
    app_name: 'musical_ly',
    app_version: '30.0.4',
    channel: 'googleplay',
    device_id: deviceId,
    device_platform: 'android',
    device_type: 'Pixel XL',
    os_version: '10',
    version_code: '300904'
  });
  let lastErr;
  // Two passes over the mirror hosts. The second pass only runs when the failure
  // looked transient (HTTP 429/403/5xx, timeout or reset) — e.g. TikTok throttling a
  // burst of requests — and backs off first so the retry actually has a chance.
  for (let pass = 0; pass < 2; pass++) {
    if (pass > 0) await sleep(1500);
    for (const host of MOBILE_API_HOSTS) {
      const url = `${host}/aweme/v1/feed/?${params.toString()}`;
      try {
        const { data, statusCode } = await requestJSON(url, {
          proxy: settings.proxy,
          headers: {
            'User-Agent': MOBILE_UA,
            Accept: 'application/json',
            'Accept-Encoding': 'identity'
          },
          timeout: pass === 0 ? 20000 : 12000
        });
        if (data && Array.isArray(data.aweme_list) && data.aweme_list.length) {
          return normalizeMobile(data.aweme_list[0]);
        }
        lastErr = new Error(`移动端接口无数据 (HTTP ${statusCode})`);
      } catch (e) {
        lastErr = e;
      }
    }
    if (!isRetryableError(lastErr)) break;
  }
  throw lastErr || new Error('移动端接口请求失败');
}

async function tryWebPage(canonicalUrl, settings) {
  const { body, statusCode } = await requestBuffer(canonicalUrl, {
    proxy: settings.proxy,
    headers: {
      'User-Agent': resolveUA(settings),
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.tiktok.com/'
    },
    timeout: 20000,
    limitBytes: 8 * 1024 * 1024
  });
  const html = body.toString('utf8');
  const m = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) throw new Error(`网页结构解析失败 (HTTP ${statusCode})`);
  const json = JSON.parse(m[1]);
  const scope = json.__DEFAULT_SCOPE__ || {};
  const detail = scope['webapp.video-detail'];
  const item = detail && detail.itemInfo && detail.itemInfo.itemStruct;
  if (!item) throw new Error('未找到视频详情数据');
  return normalizeWeb(item);
}

async function tryOembed(canonicalUrl, settings) {
  const { data } = await requestJSON(
    `https://www.tiktok.com/oembed?url=${encodeURIComponent(canonicalUrl)}`,
    {
      proxy: settings.proxy,
      headers: { 'User-Agent': resolveUA(settings), Accept: 'application/json' },
      timeout: 15000
    }
  );
  if (!data || (!data.title && !data.thumbnail_url)) throw new Error('oEmbed 无数据');
  return {
    id: extractAwemeId(canonicalUrl) || '',
    desc: data.title || '',
    createdAt: null,
    region: '',
    isPhoto: false,
    author: {
      uniqueId: (data.author_url || '').split('@')[1] || '',
      nickname: data.author_name || '',
      avatar: ''
    },
    video: {
      noWatermark: [],
      watermarked: [],
      cover: data.thumbnail_url || '',
      duration: 0,
      width: 0,
      height: 0,
      bitrate: 0,
      gear: ''
    },
    music: { title: '', author: '', url: '' },
    stats: {},
    images: [],
    source: 'oembed'
  };
}

/**
 * Optional custom parse API. Supports {url} placeholder, expects common JSON shapes.
 */
async function tryCustomApi(rawUrl, settings) {
  const tpl = settings.parseApi;
  if (!tpl) throw new Error('未配置自定义解析接口');
  const endpoint = tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(rawUrl)) : tpl;
  const { data } = await requestJSON(endpoint, {
    proxy: settings.proxy,
    headers: { 'User-Agent': resolveUA(settings), Accept: 'application/json' },
    timeout: 20000
  });
  const root = data && data.data && typeof data.data === 'object' ? data.data : data;
  const nw = root.nwm_video_url_HQ || root.nwm_video_url || root.video_url || root.play;
  if (!nw) throw new Error('自定义接口未返回无水印地址');
  return {
    id: extractAwemeId(rawUrl) || String(root.id || ''),
    desc: root.title || root.desc || '',
    createdAt: null,
    region: '',
    isPhoto: false,
    author: { uniqueId: root.author || '', nickname: root.author || '', avatar: root.cover || '' },
    video: {
      noWatermark: dedupe([nw, root.nwm_video_url]),
      watermarked: root.wm_video_url ? [root.wm_video_url] : [],
      cover: root.cover || root.origin_cover || '',
      duration: Number(root.duration) || 0,
      width: Number(root.width) || 0,
      height: Number(root.height) || 0,
      bitrate: 0,
      gear: ''
    },
    music: { title: root.music_info && root.music_info.title, author: root.music_info && root.music_info.author, url: root.music || '' },
    stats: {},
    images: [],
    source: 'custom-api'
  };
}

/**
 * Main entry: parse a share text / url into normalized metadata.
 */
async function parse(input, settings) {
  const raw = (input || '').trim();
  if (!raw) throw new Error('请输入 TikTok 链接');
  const url = extractShareUrl(raw) || raw;
  if (!/tiktok\.com/i.test(url)) throw new Error('不是有效的 TikTok 链接');

  const canonical = await normalizeUrl(url, { settings });
  const awemeId = extractAwemeId(canonical) || extractAwemeId(url);

  const cached = readCache(canonical);
  if (cached) return cached;

  const errors = [];

  if (settings.parseApi) {
    try {
      const r = await tryCustomApi(url, settings);
      return remember(canonical, finalize(r, canonical, awemeId));
    } catch (e) {
      errors.push(`自定义接口: ${e.message}`);
    }
  }

  if (awemeId) {
    try {
      const r = await tryMobileApi(awemeId, settings);
      return remember(canonical, finalize(r, canonical, awemeId));
    } catch (e) {
      errors.push(`移动端接口: ${e.message}`);
    }
  }

  try {
    const r = await tryWebPage(canonical, settings);
    return remember(canonical, finalize(r, canonical, awemeId));
  } catch (e) {
    errors.push(`网页解析: ${e.message}`);
  }

  try {
    const r = await tryOembed(canonical, settings);
    return remember(canonical, finalize(r, canonical, awemeId));
  } catch (e) {
    errors.push(`oEmbed: ${e.message}`);
  }

  const hint = settings.proxy && settings.proxy.enabled ? '' : '（提示：该网络环境可能需要配置代理）';
  const err = new Error(`解析失败${hint}\n${errors.join('\n')}`);
  err.details = errors;
  throw err;
}

function finalize(item, canonicalUrl, awemeId) {
  item.id = item.id || awemeId || '';
  item.canonicalUrl = canonicalUrl;
  return item;
}

module.exports = { parse, extractShareUrl, extractAwemeId, normalizeUrl, isShortLink };