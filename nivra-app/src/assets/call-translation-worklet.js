/* Remote audio only. Output is silent; the original call's playback is untouched. */
class NivraCallPcm extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new ArrayBuffer(6400); this.view = new DataView(this.buffer); this.offset = 0; }
  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] / channels.length;
      sample = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(this.offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      this.offset += 2;
      if (this.offset === 6400) {
        this.port.postMessage(this.buffer, [this.buffer]);
        this.buffer = new ArrayBuffer(6400); this.view = new DataView(this.buffer); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('nivra-call-pcm', NivraCallPcm);
