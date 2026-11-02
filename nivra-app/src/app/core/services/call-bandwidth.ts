/** Conservative uplink ceilings; WebRTC congestion control can go lower. */
export function callBandwidth(hints: { effectiveType?: string; saveData?: boolean } | null) {
  if (hints?.saveData || ['slow-2g', '2g'].includes(hints?.effectiveType ?? '')) {
    return { camera: 180_000, screen: 350_000, audio: 24_000, cameraFps: 12, screenFps: 10 };
  }
  if (hints?.effectiveType === '3g') {
    return { camera: 600_000, screen: 900_000, audio: 40_000, cameraFps: 24, screenFps: 15 };
  }
  return { camera: 2_500_000, screen: 3_000_000, audio: 128_000, cameraFps: 30, screenFps: 30 };
}
