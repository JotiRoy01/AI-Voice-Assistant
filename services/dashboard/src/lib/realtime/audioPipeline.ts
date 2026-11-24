/**
 * Full-Duplex Browser Audio Pipeline (WebAudio AEC + 16kHz PCM Streaming + <20ms Barge-In Playback Flush).
 * - Keeps Microphone ALWAYS ON with hardware Echo Cancellation (`echoCancellation: true`),
 *   Noise Suppression (`noiseSuppression: true`), and Auto Gain Control (`autoGainControl: true`).
 * - Streams 16kHz Int16 PCM frames to the Python Real-Time Voice Server for server-side VAD.
 * - Plays clause-by-clause Bangla Neural Audio chunks seamlessly via WebAudio `AudioBufferSourceNode`
 *   and flushes playback in <20ms the instant the customer interrupts!
 */

interface QueuedAudioClause {
  turnId: string;
  clauseIndex: number;
  totalClauses: number;
  buffer: AudioBuffer;
}

export interface AudioPipelineCallbacks {
  onPcmFrame: (pcmInt16Buffer: ArrayBuffer) => void;
  onLocalBargeInDetected: (playedClauseIndex: number) => void;
  onClausePlayed: (turnId: string, clauseIndex: number, turnCompleted: boolean) => void;
  onLevels: (micLevel: number, speakerLevel: number) => void;
}

function downsampleFloat32ToInt16(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000
): ArrayBuffer {
  if (inputSampleRate === targetSampleRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < out.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i];
      count++;
    }
    const sample = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return out.buffer;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export class FullDuplexAudioPipeline {
  private audioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micProcessor: ScriptProcessorNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private speakerAnalyser: AnalyserNode | null = null;
  private rafId: number | null = null;

  private playbackQueue: QueuedAudioClause[] = [];
  private activeSource: AudioBufferSourceNode | null = null;
  private currentTurnId: string | null = null;
  private currentClauseIndex = -1;
  private isPlaying = false;
  private isMuted = false;
  private bargeInEnabled = true;
  private vadThreshold = 0.055;
  private consecutiveSpeechFrames = 0;

  constructor(private readonly callbacks: AudioPipelineCallbacks) {}

  setMuted(muted: boolean) {
    this.isMuted = muted;
  }

  setBargeInConfig(enabled: boolean, vadThreshold: number) {
    this.bargeInEnabled = enabled;
    this.vadThreshold = vadThreshold;
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  getCurrentClauseIndex(): number {
    return this.currentClauseIndex;
  }

  async start(): Promise<void> {
    if (typeof window === 'undefined') return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioCtx = new AudioCtx();
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    // Request always-on microphone with hardware Echo Cancellation (AEC), Noise Suppression, and AGC
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });

    this.micSource = this.audioCtx.createMediaStreamSource(this.mediaStream);
    this.micAnalyser = this.audioCtx.createAnalyser();
    this.micAnalyser.fftSize = 256;

    this.speakerAnalyser = this.audioCtx.createAnalyser();
    this.speakerAnalyser.fftSize = 256;
    this.speakerAnalyser.connect(this.audioCtx.destination);

    // Stream 16kHz PCM frames + instant local barge-in RMS detector
    const bufferSize = 2048;
    this.micProcessor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);
    const silentGain = this.audioCtx.createGain();
    silentGain.gain.value = 0;

    this.micProcessor.onaudioprocess = (event) => {
      if (this.isMuted || !this.audioCtx) return;
      const inputData = event.inputBuffer.getChannelData(0);

      // Compute frame RMS energy for instant local barge-in detection
      let sumSq = 0;
      for (let i = 0; i < inputData.length; i++) {
        sumSq += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sumSq / inputData.length);

      if (this.isPlaying && this.bargeInEnabled) {
        if (rms >= this.vadThreshold) {
          this.consecutiveSpeechFrames += 1;
          // ~3 frames (~130-180ms of continuous speech) triggers instant <20ms local audio flush!
          if (this.consecutiveSpeechFrames >= 3) {
            this.consecutiveSpeechFrames = 0;
            const playedIdx = this.currentClauseIndex;
            this.flushPlayback();
            this.callbacks.onLocalBargeInDetected(playedIdx);
          }
        } else {
          this.consecutiveSpeechFrames = Math.max(0, this.consecutiveSpeechFrames - 1);
        }
      } else {
        this.consecutiveSpeechFrames = 0;
      }

      const pcm16 = downsampleFloat32ToInt16(inputData, this.audioCtx.sampleRate, 16000);
      this.callbacks.onPcmFrame(pcm16);
    };

    this.micSource.connect(this.micAnalyser);
    this.micSource.connect(this.micProcessor);
    this.micProcessor.connect(silentGain);
    silentGain.connect(this.audioCtx.destination);

    this.startLevelAnimationLoop();
  }

  private startLevelAnimationLoop() {
    const micData = new Uint8Array(128);
    const spkData = new Uint8Array(128);

    const tick = () => {
      let micLevel = 0;
      let spkLevel = 0;
      if (this.micAnalyser && !this.isMuted) {
        this.micAnalyser.getByteFrequencyData(micData);
        const avg = micData.reduce((a, b) => a + b, 0) / micData.length;
        micLevel = Math.min(1, avg / 90);
      }
      if (this.speakerAnalyser && this.isPlaying) {
        this.speakerAnalyser.getByteFrequencyData(spkData);
        const avg = spkData.reduce((a, b) => a + b, 0) / spkData.length;
        spkLevel = Math.min(1, avg / 90);
      }
      this.callbacks.onLevels(micLevel, spkLevel);
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  async enqueueClauseAudio(params: {
    turnId: string;
    clauseIndex: number;
    totalClauses: number;
    audioBase64: string;
  }): Promise<void> {
    if (!this.audioCtx) return;
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
    try {
      const rawBuf = base64ToArrayBuffer(params.audioBase64);
      const decoded = await this.audioCtx.decodeAudioData(rawBuf.slice(0));
      this.playbackQueue.push({
        turnId: params.turnId,
        clauseIndex: params.clauseIndex,
        totalClauses: params.totalClauses,
        buffer: decoded,
      });
      if (!this.isPlaying) {
        this.playNextInQueue();
      }
    } catch {
      // ignore corrupted chunk
    }
  }

  private playNextInQueue() {
    if (!this.audioCtx || !this.speakerAnalyser) return;
    const next = this.playbackQueue.shift();
    if (!next) {
      this.isPlaying = false;
      this.activeSource = null;
      return;
    }

    this.isPlaying = true;
    this.currentTurnId = next.turnId;
    this.currentClauseIndex = next.clauseIndex;

    const src = this.audioCtx.createBufferSource();
    src.buffer = next.buffer;
    src.connect(this.speakerAnalyser);
    this.activeSource = src;

    src.onended = () => {
      if (this.activeSource !== src) return;
      this.activeSource = null;
      const isLast = next.clauseIndex + 1 >= next.totalClauses && this.playbackQueue.length === 0;
      this.callbacks.onClausePlayed(next.turnId, next.clauseIndex, isLast);
      this.playNextInQueue();
    };

    src.start(0);
  }

  /**
   * Instant <20ms playback flush triggered whenever the customer speaks while the AI is talking!
   */
  flushPlayback(): void {
    this.playbackQueue = [];
    this.isPlaying = false;
    if (this.activeSource) {
      try {
        this.activeSource.onended = null;
        this.activeSource.stop();
        this.activeSource.disconnect();
      } catch {
        // ignore
      }
      this.activeSource = null;
    }
  }

  stop(): void {
    this.flushPlayback();
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    try {
      this.micProcessor?.disconnect();
      this.micSource?.disconnect();
      this.mediaStream?.getTracks().forEach((t) => t.stop());
      this.audioCtx?.close();
    } catch {
      // ignore
    }
    this.micProcessor = null;
    this.micSource = null;
    this.mediaStream = null;
    this.audioCtx = null;
  }
}
