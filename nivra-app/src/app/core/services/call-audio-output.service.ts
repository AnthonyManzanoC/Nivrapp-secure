import { Injectable, OnDestroy, signal } from '@angular/core';

/** Audio belongs to the call lifetime, independently of routed video views. */
@Injectable({ providedIn: 'root' })
export class CallAudioOutputService implements OnDestroy {
  private readonly outputs = new Map<string, HTMLAudioElement>();
  private readonly blocked = new Set<string>();
  readonly playbackBlocked = signal(false);
  private readonly resumeHandler = () => { void this.resume(); };
  private readonly visibilityHandler = () => {
    if (document.visibilityState === 'visible') { void this.resume(); }
  };

  constructor() {
    document.addEventListener('pointerdown', this.resumeHandler);
    document.addEventListener('keydown', this.resumeHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  sync(streams: Record<string, MediaStream>, muted: boolean): void {
    const active = new Set<string>();
    for (const [id, stream] of Object.entries(streams)) {
      const tracks = stream.getAudioTracks().filter((track) => track.readyState !== 'ended');
      if (!tracks.length) { continue; }
      active.add(id);
      let output = this.outputs.get(id);
      if (!output) {
        output = document.createElement('audio');
        output.autoplay = true;
        output.setAttribute('playsinline', '');
        output.setAttribute('aria-hidden', 'true');
        output.hidden = true;
        document.body.appendChild(output);
        this.outputs.set(id, output);
      }
      output.muted = muted;
      const previous = output.srcObject as MediaStream | null;
      if (!previous || tracks.length !== previous.getAudioTracks().length ||
          tracks.some((track, index) => track !== previous.getAudioTracks()[index])) {
        output.srcObject = new MediaStream(tracks);
      }
      void this.play(id, output);
    }
    for (const [id, output] of this.outputs) {
      if (active.has(id)) { continue; }
      output.pause();
      output.srcObject = null;
      output.remove();
      this.outputs.delete(id);
      this.blocked.delete(id);
    }
    this.playbackBlocked.set(!muted && this.blocked.size > 0);
  }

  async resume(): Promise<void> {
    await Promise.all([...this.outputs].map(([id, output]) => this.play(id, output)));
  }

  ngOnDestroy(): void {
    document.removeEventListener('pointerdown', this.resumeHandler);
    document.removeEventListener('keydown', this.resumeHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.sync({}, false);
  }

  private async play(id: string, output: HTMLAudioElement): Promise<void> {
    if (!output.paused && !this.blocked.has(id)) { return; }
    try {
      await output.play();
      if (this.outputs.get(id) !== output) { return; }
      this.blocked.delete(id);
    } catch (error) {
      // Stream replacement can abort play; only user activation needs a prompt.
      if (error instanceof DOMException && error.name === 'NotAllowedError' && this.outputs.get(id) === output) {
        this.blocked.add(id);
      }
    }
    if (this.outputs.get(id) === output) {
      this.playbackBlocked.set([...this.blocked].some((key) => this.outputs.get(key)?.muted === false));
    }
  }
}
