import { describe, expect, it } from 'vitest';

import { deviceContextOptions } from './run-cases.js';

describe('deviceContextOptions', () => {
  it('returns the Playwright descriptor without the default browser type', () => {
    const options = deviceContextOptions('iPhone 13', 'webkit');
    expect(options.viewport).toEqual({ width: 390, height: 664 });
    expect(options.isMobile).toBe(true);
    expect(options.hasTouch).toBe(true);
    expect(options).not.toHaveProperty('defaultBrowserType');
  });

  it('drops isMobile for Firefox, which does not support it', () => {
    expect(deviceContextOptions('Pixel 5', 'firefox')).not.toHaveProperty('isMobile');
    expect(deviceContextOptions('Pixel 5', 'chromium').isMobile).toBe(true);
  });

  it('rejects unknown devices', () => {
    expect(() => deviceContextOptions('Nokia 3310', 'chromium')).toThrow(/Unknown device/);
  });
});
