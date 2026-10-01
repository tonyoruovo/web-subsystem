import { UserAgentKind } from '@/enums/user-agent.enum';

import type { IBrowserInfo, BrowserName, RenderingEngine } from '@/types/user-agent.types';

/* ─── Main (async) entry point ───────────────────────── */

/**
 * detectBrowser - fully async to support Brave detection.
 *
 * Brave deliberately omits any unique UA token and clones
 * Chrome's UA string. The only reliable signal is the
 * `navigator.brave.isBrave()` Promise exposed by the browser.
 * Everything else is synchronous regex on the UA string.
 *
 * @example
 * Usage:
 * ```ts
 *   const browser = await detectBrowser();
 *   console.log(browser.toString());
 * ```
 */
export async function detectBrowser(ua: string = navigator.userAgent): Promise<IBrowserInfo> {
  const info = detectFromUA(ua);

  // Only attempt the Brave check when we'd otherwise call
  // this browser "Chrome" - Brave's UA is indistinguishable
  // from Chrome via regex alone.
  if (info.name === 'Chrome' && typeof navigator !== 'undefined') {
    const brave = await checkBrave();
    if (brave) {
      return build('Brave', info.version, 'Blink', ua, UserAgentKind.BRAVE, true);
    }
  }

  return info;
}

/* ─── Brave async probe ──────────────────────────────── */

async function checkBrave(): Promise<boolean> {
  try {
    if (navigator.brave?.isBrave) {
      return await navigator.brave.isBrave();
    }
  } catch {
    // navigator.brave exists but threw - not Brave
  }
  return false;
}

/* ─── Synchronous UA-string detection ───────────────── */

function detectFromUA(ua: string): IBrowserInfo {
  function ver(pattern: RegExp): string {
    const m = ua.match(pattern);
    return m ? m[1] : 'unknown';
  }

  // 1. Internet Explorer - MSIE or Trident (IE 11 uses rv:)
  if (/MSIE |Trident\//.test(ua)) {
    const v = /MSIE ([\d.]+)/.test(ua) ? RegExp.$1 : /rv:([\d.]+)/.test(ua) ? RegExp.$1 : 'unknown';
    return build('Internet Explorer', v, 'Trident', ua, UserAgentKind.IE);
  }

  // 2. Edge Legacy (EdgeHTML engine, pre-Chromium)
  if (/Edge\//.test(ua))
    return build('Edge (Legacy)', ver(/Edge\/([\d.]+)/), 'EdgeHTML', ua, UserAgentKind.EDGE_LEGACY);

  // 3. Edge Chromium - token is "Edg/" (no trailing 'e')
  if (/Edg\//.test(ua)) return build('Edge', ver(/Edg\/([\d.]+)/), 'Blink', ua, UserAgentKind.EDGE);

  // 4. Opera (Chromium-based, OPR token)
  if (/OPR\//.test(ua))
    return build('Opera', ver(/OPR\/([\d.]+)/), 'Blink', ua, UserAgentKind.OPERA);

  // 5. Opera (legacy Presto engine)
  if (/Opera\/|Opera\s/.test(ua))
    return build('Opera', ver(/Opera[\/\s]([\d.]+)/), 'Presto', ua, UserAgentKind.OPERA);

  // 6. Samsung Internet - must precede Chrome
  if (/SamsungBrowser\//.test(ua))
    return build(
      'Samsung Internet',
      ver(/SamsungBrowser\/([\d.]+)/),
      'Blink',
      ua,
      UserAgentKind.SAMSUNG,
    );

  // 7. UC Browser
  if (/UCBrowser\//.test(ua))
    return build('UC Browser', ver(/UCBrowser\/([\d.]+)/), 'WebKit', ua, UserAgentKind.UC);

  // 8. Chrome / Chromium - NOTE: Brave hits this branch;
  //    the async detectBrowser() caller upgrades it if needed.
  if (/Chrome\//.test(ua) && !/Chromium\//.test(ua))
    return build('Chrome', ver(/Chrome\/([\d.]+)/), 'Blink', ua, UserAgentKind.CHROME);

  if (/Chromium\//.test(ua))
    return build('Chromium', ver(/Chromium\/([\d.]+)/), 'Blink', ua, UserAgentKind.CHROMIUM);

  // 9. Firefox desktop
  if (/Firefox\//.test(ua))
    return build('Firefox', ver(/Firefox\/([\d.]+)/), 'Gecko', ua, UserAgentKind.FIREFOX);

  // 10. Firefox on iOS (forced WebKit by Apple)
  if (/FxiOS\//.test(ua))
    return build('Firefox iOS', ver(/FxiOS\/([\d.]+)/), 'WebKit', ua, UserAgentKind.FIREFOX_IOS);

  // 11. Safari - must come after all Chrome/Edge/Opera checks
  if (/Safari\//.test(ua) && /Version\//.test(ua))
    return build('Safari', ver(/Version\/([\d.]+)/), 'WebKit', ua, UserAgentKind.SAFARI);

  return build('Unknown', 'unknown', 'unknown', ua);
}

/* ─── Helpers ────────────────────────────────────────── */

function build(
  name: BrowserName,
  version: string,
  engine: RenderingEngine,
  ua: string,
  kind: UserAgentKind = UserAgentKind.UNKNOWN,
  isBrave = false,
): IBrowserInfo {
  return {
    name,
    kind,
    version,
    engine,
    mobile: isMobile(ua),
    os: detectOS(ua),
    isBrave,
    toString() {
      return `${name} ${version} (${engine}) on ${this.os}`;
    },
  };
}

function isMobile(ua: string): boolean {
  return /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

function detectOS(ua: string): string {
  if (/Windows NT 10/.test(ua)) return 'Windows 10/11';
  if (/Windows NT 6\.3/.test(ua)) return 'Windows 8.1';
  if (/Windows NT 6\.1/.test(ua)) return 'Windows 7';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Android ([\d.]+)/.test(ua)) return `Android ${RegExp.$1}`;
  if (/iPhone OS ([\d_]+)/.test(ua)) return `iOS ${RegExp.$1.replace(/_/g, '.')}`;
  if (/iPad.*OS ([\d_]+)/.test(ua)) return `iPadOS ${RegExp.$1.replace(/_/g, '.')}`;
  if (/Mac OS X ([\d_]+)/.test(ua)) return `macOS ${RegExp.$1.replace(/_/g, '.')}`;
  if (/Linux/.test(ua)) return 'Linux';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  return 'Unknown OS';
}
