// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openShipmentWindow } from './open-window';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openShipmentWindow', () => {
  it('opens the standalone page as a sized popup named after the shipment, and focuses it', () => {
    const focus = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue({ focus } as unknown as Window);
    openShipmentWindow('ar', 'shp-1');
    expect(open).toHaveBeenCalledWith(
      '/ar/standalone/shipments/shp-1',
      'nolon-shipment-shp-1',
      'popup,width=1200,height=860',
    );
    expect(focus).toHaveBeenCalled();
  });

  it('keeps the window name safe and the id encoded in the URL', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openShipmentWindow('en', 'a/b c');
    expect(open).toHaveBeenCalledWith(
      '/en/standalone/shipments/a%2Fb%20c',
      'nolon-shipment-abc',
      'popup,width=1200,height=860',
    );
  });
});
