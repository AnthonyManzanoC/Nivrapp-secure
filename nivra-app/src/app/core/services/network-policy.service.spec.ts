import { TestBed } from '@angular/core/testing';
import { NETWORK_POLICY_RUNTIME, NetworkHints, NetworkPolicyService } from './network-policy.service';

describe('bounded network policy', () => {
  let network: NetworkPolicyService;
  let hints: NetworkHints;
  let online: boolean;
  let now: number;
  let random: number;
  beforeEach(() => {
    hints = {}; online = true; now = 100000; random = .5;
    TestBed.configureTestingModule({ providers: [{ provide: NETWORK_POLICY_RUNTIME, useValue: {
      hints: () => hints, onlineHint: () => online, now: () => now, random: () => random,
    } }] });
    network = TestBed.inject(NetworkPolicyService);
  });
  afterEach(() => TestBed.resetTestingModule());
  it('extends slow link deadlines without interpreting online as a fast connection', () => {
    hints = { effectiveType: '2g' };
    expect(network.readTimeoutMs()).toBe(90000);
    online = false;
    expect(network.onlineHint()).toBeFalse();
    expect(network.readTimeoutMs()).toBe(90000);
    online = true;
    expect(network.readTimeoutMs()).toBe(90000);
    hints = { effectiveType: 'slow-2g' };
    expect(network.readTimeoutMs()).toBe(120000);
  });
  it('adapts when NetworkInformation is absent and expires the observed penalty', () => {
    expect(network.readTimeoutMs()).toBe(30000);
    network.recordTimeout();
    expect(network.readTimeoutMs()).toBe(90000);
    now += 120001;
    expect(network.readTimeoutMs()).toBe(30000);
    network.recordResponse(22000);
    expect(network.readTimeoutMs()).toBe(66000);
  });
  it('bounds extreme hints and uses exponential delays with jitter rather than a fixed loop', () => {
    hints = { rtt: 100000 };
    expect(network.readTimeoutMs()).toBe(120000);
    expect(network.retryDelayMs(0)).toBe(2500);
    expect(network.retryDelayMs(1)).toBe(5000);
    expect(network.retryDelayMs(2)).toBe(10000);
    expect(network.retryDelayMs(500)).toBe(120000);
    random = 0; const low = network.retryDelayMs(2);
    random = 1; const high = network.retryDelayMs(2);
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(7500);
    expect(high).toBeLessThanOrEqual(12500);
  });
});
