import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeviceStripView, DevicesKeyView, type DevicesKeyViewProps } from './DevicesKey';
import { defaultDeviceName, deviceName, resetDeviceIdentity, setDeviceName } from '../../player/deviceIdentity';

describe('device names', () => {
  it('names a device after its browser and system', () => {
    const nav = (userAgent: string, platform = '', maxTouchPoints = 0) => ({ userAgent, platform, maxTouchPoints });
    expect(defaultDeviceName(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'MacIntel'))).toBe('Chrome on Mac');
    expect(defaultDeviceName(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'))).toBe('Safari on iPhone');
    expect(defaultDeviceName(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'MacIntel', 5))).toBe('Safari on iPad');
    expect(defaultDeviceName(nav('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'))).toBe('Chrome on Android');
    expect(defaultDeviceName(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'))).toBe('Edge on Windows');
    expect(defaultDeviceName(nav('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'))).toBe('Firefox on Linux');
    expect(defaultDeviceName(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1'))).toBe('Chrome on iPhone');
  });

  afterEach(() => { vi.unstubAllGlobals(); resetDeviceIdentity(); });

  it('keeps the name the person gave this browser; a blank one goes back to the default', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', platform: 'Linux', maxTouchPoints: 0 });
    expect(setDeviceName('  Kitchen   laptop ')).toBe('Kitchen laptop');
    expect(deviceName()).toBe('Kitchen laptop');
    expect(setDeviceName('   ')).toBe('Firefox on Linux');
    expect(store.size).toBe(0);
    expect(setDeviceName('x'.repeat(80))).toHaveLength(60);
  });
});

describe('the device key and strip', () => {
  const base: DevicesKeyViewProps = {
    devices: [
      { id: 'mac', name: 'Chrome on Mac', here: true, playing: false },
      { id: 'phone', name: 'Safari on iPhone', here: false, playing: true },
    ],
    onChoose: () => undefined,
  };

  it('is an embossed menu key named Devices, the accent while another device plays', () => {
    const html = renderToStaticMarkup(<DevicesKeyView {...base} />);
    expect(html).toContain('aria-label="Devices"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(renderToStaticMarkup(<DevicesKeyView {...base} lit />)).not.toBe(html);
  });

  it('says where it plays, or asks for a tap, and nothing when this device plays on its own', () => {
    expect(renderToStaticMarkup(<DeviceStripView playingOn="Safari on iPhone" />)).toContain('Playing on Safari on iPhone');
    const tap = renderToStaticMarkup(<DeviceStripView needsTap onTap={() => undefined} />);
    expect(tap).toContain('<button');
    expect(tap).toContain('Tap to play here');
    expect(renderToStaticMarkup(<DeviceStripView />)).toBe('');
  });

  it('opens the devices menu from the strip', () => {
    const html = renderToStaticMarkup(<DeviceStripView playingOn="Safari on iPhone" menu={base} />);
    expect(html).toContain('aria-label="Playing on Safari on iPhone"');
    expect(html).toContain('aria-haspopup="menu"');
  });
});
