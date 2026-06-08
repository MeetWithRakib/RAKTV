/**
 * RAK TV — Cloudflare Worker
 * Handles: stream proxy, channel list API, token refresh
 * URLs are never exposed to the frontend
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Rate limiting store (in-memory, resets per worker instance)
const rateMap = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const key = `${ip}:${Math.floor(now / 60000)}`; // per minute
  const count = (rateMap.get(key) || 0) + 1;
  rateMap.set(key, count);
  // cleanup old keys
  if (rateMap.size > 1000) {
    const oldKey = `${ip}:${Math.floor(now / 60000) - 2}`;
    rateMap.delete(oldKey);
  }
  return count > 60; // max 60 req/min per IP
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    // Rate limit check
    if (rateLimit(ip)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const path = url.pathname;

    // ── GET /api/channels — public channel list (no URLs) ──
    if (path === '/api/channels') {
      return handleChannels(env);
    }

    // ── GET /api/stream?id=ch_001 — get stream (proxied) ──
    if (path === '/api/stream') {
      const id = url.searchParams.get('id');
      if (!id) return err('Missing id', 400);
      return handleStream(id, env, request);
    }

    // ── GET /api/proxy — proxy the actual .ts/.m3u8 segment ──
    if (path === '/api/proxy') {
      const streamUrl = url.searchParams.get('url');
      if (!streamUrl) return err('Missing url', 400);
      return handleProxy(streamUrl, request);
    }

    return err('Not found', 404);
  }
};

// ── Channel list (logo + name only, no stream URLs) ──
async function handleChannels(env) {
  try {
    // Try KV cache first
    const cached = await env.RAK_KV.get('__channel_list__');
    if (cached) {
      return new Response(cached, {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
      });
    }

    // Build list from KV keys
    const list = await env.RAK_KV.list();
    const channels = [];
    for (const key of list.keys) {
      if (key.name.startsWith('ch_')) {
        const val = await env.RAK_KV.get(key.name, { type: 'json' });
        if (val) {
          channels.push({
            id: key.name,
            name: val.name,
            group: val.group,
            logo: val.logo
            // url intentionally omitted
          });
        }
      }
    }

    const json = JSON.stringify(channels);
    // Cache for 5 minutes
    await env.RAK_KV.put('__channel_list__', json, { expirationTtl: 300 });

    return new Response(json, {
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
    });
  } catch (e) {
    return err('Failed to load channels: ' + e.message, 500);
  }
}

// ── Stream handler — returns m3u8 with rewritten segment URLs ──
async function handleStream(id, env, request) {
  try {
    const ch = await env.RAK_KV.get(id, { type: 'json' });
    if (!ch) return err('Channel not found', 404);

    const streamUrl = ch.url;
    const workerBase = new URL(request.url).origin;

    // Fetch the m3u8 playlist
    const res = await fetch(streamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36',
        'Referer': new URL(streamUrl).origin + '/',
      },
      cf: { cacheEverything: false }
    });

    if (!res.ok) {
      return err(`Stream fetch failed: ${res.status}`, 502);
    }

    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();

    // If it's an m3u8, rewrite segment/sub-playlist URLs through our proxy
    if (contentType.includes('mpegurl') || text.includes('#EXTM3U')) {
      const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
      const rewritten = rewriteM3U8(text, baseUrl, workerBase);
      return new Response(rewritten, {
        headers: {
          ...CORS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache',
        }
      });
    }

    // Binary segment — pass through
    return new Response(res.body, {
      headers: {
        ...CORS,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=10',
      }
    });
  } catch (e) {
    return err('Stream error: ' + e.message, 500);
  }
}

// ── Proxy handler — fetches and forwards .ts segments etc ──
async function handleProxy(targetUrl, request) {
  try {
    // Security: only allow known CDN patterns
    const allowed = [
      'aynaott.com', 'roarzone.net', 'yuppcdn.net', 'akamaized.net',
      'cloudfront.net', 'amagi.tv', 'wurl.com', 'pishow.tv',
      'gpcdn.net', 'ncare.live', 'shariarsuvo.com', 'sonarbanglatv.com',
      'deshitv24.net', 'erbvr.com', 'streamlock.net', 'presstv.ir',
      'trt.com.tr', 'getaj.net', 'kwtsplta.cdn.mangomolo.com',
      'frequency.stream', 'sofast.tv', 'wowza.com', 'uplynk.com',
      'foxweather.com', 'nbcuni.com', 'roku.wurl.tv', 'livestreaming247.com',
      'live247stream.com', 'klowdtv.com', 'persiana.live', 'mediatailor',
      'intoday.in', 'mjunoon.tv', 'awaazindia.livebox.co.in',
    ];
    const host = new URL(targetUrl).hostname;
    const isAllowed = allowed.some(d => host.endsWith(d));
    if (!isAllowed) {
      return err('Blocked domain', 403);
    }

    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36',
        'Origin': new URL(targetUrl).origin,
        'Referer': new URL(targetUrl).origin + '/',
      },
      cf: { cacheEverything: true, cacheTtl: 10 }
    });

    const headers = {
      ...CORS,
      'Content-Type': res.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'public, max-age=10',
    };

    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    return err('Proxy error: ' + e.message, 500);
  }
}

// ── Rewrite m3u8 — replace segment/playlist URLs with proxy URLs ──
function rewriteM3U8(text, baseUrl, workerBase) {
  return text.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;

    // Build absolute URL for the segment/sub-playlist
    let absUrl;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      absUrl = trimmed;
    } else if (trimmed.startsWith('/')) {
      absUrl = new URL(trimmed, baseUrl).href;
    } else {
      absUrl = baseUrl + trimmed;
    }

    // Rewrite through our proxy
    return `${workerBase}/api/proxy?url=${encodeURIComponent(absUrl)}`;
  }).join('\n');
}

function err(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
