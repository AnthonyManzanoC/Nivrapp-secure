import { callBandwidth } from './call-bandwidth';

describe('call uplink adaptation', () => {
  it('reduces camera, screen and audio budgets on weak links and restores normal capacity', () => {
    const weak = callBandwidth({ effectiveType: '2g' });
    const medium = callBandwidth({ effectiveType: '3g' });
    const fast = callBandwidth({ effectiveType: '4g' });
    expect(weak.camera).toBeLessThan(medium.camera);
    expect(medium.camera).toBeLessThan(fast.camera);
    expect(weak.audio).toBeGreaterThanOrEqual(24000);
    expect(weak.screenFps).toBeLessThan(fast.screenFps);
    expect(callBandwidth({ saveData: true, effectiveType: '4g' })).toEqual(weak);
    expect(callBandwidth(null)).toEqual(fast);
  });
});
