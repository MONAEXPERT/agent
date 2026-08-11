// Network tools — HTTP fetch and DNS lookup.
// No arbitrary outbound connections; only HTTP(S) GET/POST.

const UA = 'mona-agent/1.0.0';
const MAX_BODY = 50_000;  // 50 KB response cap
const TIMEOUT  = 15_000;  // 15s

export const net = {
  name: 'net',
  description: 'HTTP fetch (GET/POST) and basic network operations',
  args: {
    action:  'string — fetch | ping',
    url:     'string — full URL (for fetch)',
    method:  'string — GET or POST (default GET)',
    body:    'string — request body (for POST)',
    host:    'string — hostname (for ping)',
  },

  async run(args) {
    const action = String(args.action || 'fetch').toLowerCase();

    switch (action) {
      case 'fetch': {
        const url = args.url;
        if (!url) return { error: 'url required' };
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return { error: 'URL must start with http:// or https://' };
        }

        const method = (args.method || 'GET').toUpperCase();
        if (!['GET', 'POST', 'HEAD'].includes(method)) {
          return { error: `Method ${method} not supported`, allowed: ['GET', 'POST', 'HEAD'] };
        }

        const res = await fetch(url, {
          method,
          headers: { 'User-Agent': UA },
          body: method === 'POST' ? args.body : undefined,
          signal: AbortSignal.timeout(TIMEOUT),
        });

        const contentType = res.headers.get('content-type') || '';
        let body;

        if (contentType.includes('text/html')) {
          const html = await res.text();
          body = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_BODY);
        } else {
          body = (await res.text()).slice(0, MAX_BODY);
        }

        return {
          status:      res.status,
          contentType,
          body,
          truncated:   body.length >= MAX_BODY,
        };
      }

      case 'ping': {
        const host = args.host || args.url;
        if (!host) return { error: 'host required' };
        // Simple connectivity check — HEAD request
        const target = host.startsWith('http') ? host : `https://${host}`;
        const start = performance.now();
        try {
          const res = await fetch(target, {
            method: 'HEAD',
            signal: AbortSignal.timeout(5000),
            headers: { 'User-Agent': UA },
          });
          return {
            reachable: true,
            status:    res.status,
            ms:        Math.round(performance.now() - start),
          };
        } catch (err) {
          return {
            reachable: false,
            error:     err.message,
            ms:        Math.round(performance.now() - start),
          };
        }
      }

      default:
        return { error: `Unknown net action: ${action}`, available: ['fetch', 'ping'] };
    }
  },
};
