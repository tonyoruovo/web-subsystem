import type { UserAgentKind } from '@/enums/user-agent.enum';

export type BrowserName =
  | 'Internet Explorer'
  | 'Edge (Legacy)'
  | 'Edge'
  | 'Opera'
  | 'Samsung Internet'
  | 'UC Browser'
  | 'Brave'
  | 'Chrome'
  | 'Chromium'
  | 'Firefox'
  | 'Firefox iOS'
  | 'Safari'
  | 'Unknown';

export type RenderingEngine =
  'Trident' | 'EdgeHTML' | 'Presto' | 'Blink' | 'Gecko' | 'WebKit' | 'unknown';

export type IBrowserInfo = {
  name: BrowserName;
  kind: UserAgentKind;
  version: string;
  engine: RenderingEngine;
  mobile: boolean;
  os: string;
  isBrave: boolean; // true only after async check resolves
  toString(): string;
};
