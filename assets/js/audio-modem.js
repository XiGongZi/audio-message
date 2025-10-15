const DEFAULT_CONFIG = {
  sampleRate: 48000,
  bitsPerSymbol: 4,
  symbolDuration: 0.04,
  baseFrequency: 1200,
  frequencyStep: 120,
  guardDuration: 0.12,
  amplitude: 0.3,
};

const CONTROL_BYTES = {
  START: 0x02,
  END: 0x03,
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function asciiBytes(message) {
  return textEncoder.encode(message);
}

function bytesToString(bytes) {
  return textDecoder.decode(bytes);
}

function buildPacket(payloadBytes) {
  const data = new Uint8Array(2 + payloadBytes.length + 1);
  data[0] = CONTROL_BYTES.START;
  data.set(payloadBytes, 1);
  data[data.length - 1] = CONTROL_BYTES.END;
  return data;
}

function extractFrames(buffer) {
  const frames = [];
  let collecting = false;
  let current = [];

  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    if (!collecting) {
      if (byte === CONTROL_BYTES.START) {
        collecting = true;
        current = [];
      }
      continue;
    }

    if (byte === CONTROL_BYTES.END) {
      frames.push(new Uint8Array(current));
      collecting = false;
      current = [];
      continue;
    }

    current.push(byte);
  }

  return frames;
}

function hammingWeight(byte) {
  let x = byte;
  let count = 0;
  while (x) {
    count += x & 1;
    x >>= 1;
  }
  return count;
}

export class SimpleAudioModem {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.audioContext = null;
    this.microphoneStream = null;
    this.isListening = false;
    this.analysisNode = null;
    this.timeDomainBuffer = new Float32Array(0);
    this.ringBuffer = new Float32Array(0);
    this.symbolSamples = 0;
    this.callbacks = {
      message: new Set(),
      status: new Set(),
      error: new Set(),
    };
  }

  on(event, handler) {
    if (this.callbacks[event]) {
      this.callbacks[event].add(handler);
    }
  }

  off(event, handler) {
    if (this.callbacks[event]) {
      this.callbacks[event].delete(handler);
    }
  }

  emit(event, payload) {
    if (!this.callbacks[event]) return;
    this.callbacks[event].forEach((handler) => handler(payload));
  }

  async init() {
    if (this.audioContext) {
      return this.audioContext;
    }

    this.audioContext = new AudioContext({ sampleRate: this.config.sampleRate });
    this.symbolSamples = Math.round(
      this.audioContext.sampleRate * this.config.symbolDuration
    );
    this.timeDomainBuffer = new Float32Array(this.symbolSamples);
    this.ringBuffer = new Float32Array(this.symbolSamples);
    return this.audioContext;
  }

  async startListening() {
    const context = await this.init();

    if (this.isListening) {
      return;
    }

    try {
      this.microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
        video: false,
      });
    } catch (error) {
      this.emit("error", new Error(`麦克风权限被拒绝：${error.message}`));
      throw error;
    }

    const source = context.createMediaStreamSource(this.microphoneStream);
    this.analysisNode = context.createAnalyser();
    this.analysisNode.fftSize = 2048;
    source.connect(this.analysisNode);

    this.isListening = true;
    this.emit("status", "监听已开启");

    this._loopDecode();
  }

  stopListening() {
    if (!this.isListening) return;

    if (this.microphoneStream) {
      this.microphoneStream.getTracks().forEach((track) => track.stop());
    }

    if (this.analysisNode) {
      this.analysisNode.disconnect();
      this.analysisNode = null;
    }

    this.microphoneStream = null;
    this.isListening = false;
    this.emit("status", "监听已停止");
  }

  async send(message) {
    const context = await this.init();
    if (context.state === "suspended") {
      await context.resume();
    }

    const bytes = asciiBytes(message);
    const packet = buildPacket(bytes);
    const waveform = this._packetToSamples(packet);

    const buffer = context.createBuffer(1, waveform.length, context.sampleRate);
    buffer.copyToChannel(waveform, 0, 0);

    const bufferSource = context.createBufferSource();
    bufferSource.buffer = buffer;

    const gainNode = context.createGain();
    gainNode.gain.value = this.config.amplitude;

    bufferSource.connect(gainNode).connect(context.destination);
    bufferSource.start();
  }

  _packetToSamples(packet) {
    const { symbolDuration, guardDuration } = this.config;
    const context = this.audioContext;
    const guardSamples = Math.round(context.sampleRate * guardDuration);
    const totalSymbols = packet.length * (8 / this.config.bitsPerSymbol);
    const totalSamples =
      totalSymbols * this.symbolSamples + guardSamples * 2;

    const samples = new Float32Array(totalSamples);
    let offset = 0;

    this._generateGuardTone(samples, offset, guardSamples);
    offset += guardSamples;

    let bitBuffer = 0;
    let bitCount = 0;

    for (let i = 0; i < packet.length; i += 1) {
      bitBuffer |= packet[i] << bitCount;
      bitCount += 8;

      while (bitCount >= this.config.bitsPerSymbol) {
        const symbol = bitBuffer & ((1 << this.config.bitsPerSymbol) - 1);
        bitBuffer >>= this.config.bitsPerSymbol;
        bitCount -= this.config.bitsPerSymbol;

        this._synthesizeSymbol(samples, offset, symbol);
        offset += this.symbolSamples;
      }
    }

    this._generateGuardTone(samples, offset, guardSamples);
    return samples;
  }

  _synthesizeSymbol(samples, offset, symbolValue) {
    const { baseFrequency, frequencyStep } = this.config;
    const frequency = baseFrequency + symbolValue * frequencyStep;
    const dt = 1 / this.audioContext.sampleRate;
    let phase = 0;

    for (let i = 0; i < this.symbolSamples; i += 1) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.symbolSamples - 1));
      samples[offset + i] = Math.sin(phase) * window;
      phase += 2 * Math.PI * frequency * dt;
    }
  }

  _generateGuardTone(samples, offset, guardSamples) {
    const guardFrequency = this.config.baseFrequency / 2;
    const dt = 1 / this.audioContext.sampleRate;
    let phase = 0;

    for (let i = 0; i < guardSamples; i += 1) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (guardSamples - 1));
      samples[offset + i] = Math.sin(phase) * window;
      phase += 2 * Math.PI * guardFrequency * dt;
    }
  }

  _loopDecode() {
    if (!this.isListening || !this.analysisNode) {
      return;
    }

    const { symbolDuration, bitsPerSymbol } = this.config;
    const symbolSamples = this.symbolSamples;
    const timeDomain = new Float32Array(this.analysisNode.fftSize);
    this.analysisNode.getFloatTimeDomainData(timeDomain);

    this._addToRingBuffer(timeDomain);

    const minEnergy = 0.01;
    for (let offset = 0; offset + symbolSamples <= this.ringBuffer.length; offset += symbolSamples) {
      const slice = this.ringBuffer.subarray(offset, offset + symbolSamples);
      const energy = this._computeEnergy(slice);
      if (energy < minEnergy) {
        continue;
      }

      const symbolValue = this._detectSymbol(slice);
      if (symbolValue === null) {
        continue;
      }

      this._handleDetectedSymbol(symbolValue);
    }

    requestAnimationFrame(() => this._loopDecode());
  }

  _addToRingBuffer(newChunk) {
    const totalLength = this.ringBuffer.length + newChunk.length;
    const extended = new Float32Array(totalLength);
    extended.set(this.ringBuffer);
    extended.set(newChunk, this.ringBuffer.length);

    const maxLength = this.symbolSamples * 64;
    if (extended.length > maxLength) {
      this.ringBuffer = extended.subarray(extended.length - maxLength);
    } else {
      this.ringBuffer = extended;
    }
  }

  _computeEnergy(slice) {
    let sum = 0;
    for (let i = 0; i < slice.length; i += 1) {
      sum += slice[i] * slice[i];
    }
    return Math.sqrt(sum / slice.length);
  }

  _detectSymbol(slice) {
    const { baseFrequency, frequencyStep, bitsPerSymbol } = this.config;
    const binCount = 1 << bitsPerSymbol;
    let bestIndex = -1;
    let bestEnergy = 0;

    for (let i = 0; i < binCount; i += 1) {
      const freq = baseFrequency + i * frequencyStep;
      const energy = this._goertzel(slice, freq);

      if (energy > bestEnergy) {
        bestEnergy = energy;
        bestIndex = i;
      }
    }

    if (bestEnergy < 0.001) {
      return null;
    }

    return bestIndex;
  }

  _handleDetectedSymbol(symbol) {
    if (!this._bitQueue) {
      this._bitQueue = [];
    }

    this._bitQueue.push(symbol);
    if (this._bitQueue.length >= 8 / this.config.bitsPerSymbol) {
      let byte = 0;
      let shift = 0;
      while (this._bitQueue.length && shift < 8) {
        const value = this._bitQueue.shift();
        byte |= value << shift;
        shift += this.config.bitsPerSymbol;
      }
      this._collectByte(byte & 0xff);
    }
  }

  _collectByte(byte) {
    if (!this._byteBuffer) {
      this._byteBuffer = [];
    }

    this._byteBuffer.push(byte);
    if (this._byteBuffer.length > 512) {
      this._byteBuffer.shift();
    }

    const frames = extractFrames(this._byteBuffer);
    if (!frames.length) {
      return;
    }

    const lastFrame = frames[frames.length - 1];
    const message = bytesToString(lastFrame);
    this.emit("message", message);
    this._byteBuffer = [];
    this._bitQueue = [];
  }

  _goertzel(buffer, targetFrequency) {
    const sampleRate = this.audioContext.sampleRate;
    const k = Math.round((buffer.length * targetFrequency) / sampleRate);
    const omega = (2 * Math.PI * k) / buffer.length;
    const sine = Math.sin(omega);
    const cosine = Math.cos(omega);
    const coeff = 2 * cosine;

    let q0 = 0;
    let q1 = 0;
    let q2 = 0;

    for (let i = 0; i < buffer.length; i += 1) {
      q0 = coeff * q1 - q2 + buffer[i];
      q2 = q1;
      q1 = q0;
    }

    const real = q1 - q2 * cosine;
    const imag = q2 * sine;
    return real * real + imag * imag;
  }
}

globalThis.SimpleAudioModem = SimpleAudioModem;