import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';
import tls from 'tls';
import { promisify } from 'util';
import { AppEnv } from '../../config/env';
import { TtsAdapter, TtsSynthesisRequest, TtsSynthesisResult } from '../interfaces';
import { logger } from '../../utils/logger';

const execFileAsync = promisify(execFile);

async function synthesizeWithInstalledEdgeTtsCli(
  text: string,
  voiceName: string,
  outFilePath: string
): Promise<boolean> {
  const voice =
    voiceName.includes('Neural') && voiceName.startsWith('bn-')
      ? voiceName
      : 'bn-BD-PradeepNeural';
  const pyScript =
    'import sys, asyncio, edge_tts; ' +
    'asyncio.run(edge_tts.Communicate(text=sys.argv[1], voice=sys.argv[2], rate="+0%").save(sys.argv[3]))';

  for (const pyBin of [
    path.resolve(process.cwd(), '../../flowmind/python.exe'),
    path.resolve(process.cwd(), 'flowmind/python.exe'),
    'C:\\anaconda3\\python.exe',
    'python',
    'py',
  ]) {
    try {
      await execFileAsync(pyBin, ['-c', pyScript, text, voice, outFilePath], {
        timeout: 12000,
      });
      if (fs.existsSync(outFilePath) && fs.statSync(outFilePath).size > 256) {
        return true;
      }
    } catch {
      // try next python binary
    }
  }
  return false;
}

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = '143';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WINDOWS_EPOCH_OFFSET = 11644473600;
let cachedServerDateOffsetMs = 0;

async function syncServerClockIfNeeded(): Promise<void> {
  if (cachedServerDateOffsetMs !== 0) return;
  return new Promise<void>((resolve) => {
    const req = https.request(
      { hostname: 'speech.platform.bing.com', port: 443, path: '/', method: 'HEAD', timeout: 3000 },
      (res) => {
        const dateHeader = res.headers.date;
        if (dateHeader) {
          const serverMs = new Date(dateHeader).getTime();
          if (!Number.isNaN(serverMs)) {
            cachedServerDateOffsetMs = serverMs - Date.now();
          }
        }
        resolve();
      }
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end();
  });
}

function generateSecMsGec(): string {
  const realUtcNowMs = Date.now() + cachedServerDateOffsetMs;
  const nowSec = Math.floor(realUtcNowMs / 1000);
  let ticks = nowSec + WINDOWS_EPOCH_OFFSET;
  ticks -= ticks % 300;
  ticks *= 1e7;
  const strToHash = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createWsTextFrame(payloadStr: string): Buffer {
  const payload = Buffer.from(payloadStr, 'utf8');
  const maskKey = crypto.randomBytes(4);
  const len = payload.length;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text frame
    header[1] = 0x80 | len; // MASK bit set
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  const maskedPayload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    maskedPayload[i] = payload[i] ^ maskKey[i % 4];
  }
  return Buffer.concat([header, maskKey, maskedPayload]);
}

/**
 * Pure Node.js (zero external npm packages!) Microsoft Edge Neural Bangladeshi Bangla TTS client
 * supporting `bn-BD-PradeepNeural` (Male, exact video voice) and `bn-BD-NabanitaNeural` (Female).
 */
export async function synthesizeEdgeNeuralBanglaMp3(
  text: string,
  voiceName = 'bn-BD-PradeepNeural',
  rate = '+0%'
): Promise<Buffer> {
  await syncServerClockIfNeeded();
  const voice =
    voiceName.includes('Neural') && voiceName.startsWith('bn-')
      ? voiceName
      : 'bn-BD-PradeepNeural';
  const lang = voice.startsWith('bn-IN') ? 'bn-IN' : 'bn-BD';
  const reqId = crypto.randomUUID().replace(/-/g, '');
  const secMsGec = generateSecMsGec();
  const pathUrl =
    `/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${reqId}`;

  return new Promise<Buffer>((resolve, reject) => {
    const audioChunks: Buffer[] = [];
    let rxBuffer = Buffer.alloc(0);
    let settled = false;

    const finish = (err?: Error, result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result || Buffer.alloc(0));
    };

    const timer = setTimeout(() => {
      req.destroy();
      finish(new Error('Edge Neural TTS WebSocket timed out'));
    }, 10000);

    const wsKey = crypto.randomBytes(16).toString('base64');
    const req = https.request({
      hostname: 'speech.platform.bing.com',
      port: 443,
      path: pathUrl,
      method: 'GET',
      headers: {
        Host: 'speech.platform.bing.com',
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': wsKey,
        'Sec-WebSocket-Version': '13',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent':
          `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
          `Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
        Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
      },
    });

    req.on('error', (err) => finish(err));

    req.on('response', (res) => {
      finish(new Error(`Edge TTS WebSocket upgrade rejected with HTTP ${res.statusCode}`));
    });

    req.on('upgrade', (_res, socket: tls.TLSSocket, head: Buffer) => {
      if (head && head.length > 0) {
        rxBuffer = Buffer.concat([rxBuffer, head]);
      }

      const configMsg =
        `X-Timestamp:${new Date().toString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: 'false',
                  wordBoundaryEnabled: 'false',
                },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        });
      socket.write(createWsTextFrame(configMsg));

      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
        `<voice name='${voice}'>` +
        `<prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${escapeSsml(text)}</prosody>` +
        `</voice></speak>`;

      const ssmlMsg =
        `X-RequestId:${reqId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${new Date().toString()}Z\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml;
      socket.write(createWsTextFrame(ssmlMsg));

      socket.on('data', (chunk: Buffer) => {
        rxBuffer = Buffer.concat([rxBuffer, chunk]);

        while (rxBuffer.length >= 2) {
          const byte0 = rxBuffer[0];
          const byte1 = rxBuffer[1];
          const opcode = byte0 & 0x0f;
          const isMasked = (byte1 & 0x80) !== 0;
          let payloadLen = byte1 & 0x7f;
          let offset = 2;

          if (payloadLen === 126) {
            if (rxBuffer.length < 4) return;
            payloadLen = rxBuffer.readUInt16BE(2);
            offset = 4;
          } else if (payloadLen === 127) {
            if (rxBuffer.length < 10) return;
            payloadLen = Number(rxBuffer.readBigUInt64BE(2));
            offset = 10;
          }

          if (isMasked) offset += 4;
          if (rxBuffer.length < offset + payloadLen) return;

          const frameData = rxBuffer.subarray(offset, offset + payloadLen);
          rxBuffer = rxBuffer.subarray(offset + payloadLen);

          if (opcode === 0x02) {
            // Binary frame: 2-byte header length + header + MP3 audio chunk
            if (frameData.length >= 2) {
              const headerLen = frameData.readUInt16BE(0);
              const headerStr = frameData.subarray(2, 2 + headerLen).toString('utf8');
              if (headerStr.includes('Path:audio')) {
                const audioPart = frameData.subarray(2 + headerLen);
                if (audioPart.length > 0) {
                  audioChunks.push(Buffer.from(audioPart));
                }
              }
            }
          } else if (opcode === 0x01) {
            // Text frame
            const textStr = frameData.toString('utf8');
            if (textStr.includes('Path:turn.end')) {
              socket.end();
              const combined = Buffer.concat(audioChunks);
              if (combined.length > 0) {
                finish(undefined, combined);
              } else {
                finish(new Error('Edge TTS stream ended with 0 bytes'));
              }
              return;
            }
          } else if (opcode === 0x08) {
            // Close frame
            socket.end();
            const combined = Buffer.concat(audioChunks);
            if (combined.length > 0) {
              finish(undefined, combined);
            } else {
              finish(new Error('Edge TTS WebSocket closed before sending audio'));
            }
            return;
          }
        }
      });

      socket.on('error', (err) => finish(err));
      socket.on('close', () => {
        const combined = Buffer.concat(audioChunks);
        if (combined.length > 0) {
          finish(undefined, combined);
        } else {
          finish(new Error('Edge TTS socket closed without audio'));
        }
      });
    });

    req.end();
  });
}

/**
 * Fallback 2: Google Translate Natural Bangla TTS stream in pure Node.js
 * (Handles long multi-sentence Bangla responses by splitting on danda/punctuation `।?!` and concatenating the MP3 frames).
 */
export async function synthesizeGoogleTranslateBanglaMp3(text: string): Promise<Buffer> {
  const sentences = text
    .split(/(?<=[।?!.])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const s of sentences) {
    if (s.length <= 180) {
      chunks.push(s);
    } else {
      const words = s.split(/\s+/);
      let current = '';
      for (const w of words) {
        if ((current + ' ' + w).trim().length > 175) {
          if (current) chunks.push(current);
          current = w;
        } else {
          current = (current + ' ' + w).trim();
        }
      }
      if (current) chunks.push(current);
    }
  }

  const buffers: Buffer[] = [];
  for (const chunk of chunks) {
    const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=bn&q=${encodeURIComponent(chunk)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) {
      throw new Error(`Google Bangla TTS fallback failed (${res.status})`);
    }
    const arr = await res.arrayBuffer();
    buffers.push(Buffer.from(arr));
  }

  return Buffer.concat(buffers);
}

export class LocalHttpTtsAdapter implements TtsAdapter {
  /**
   * ============================================================================
   * CLASS DESCRIPTION: LocalHttpTtsAdapter (With Built-in Node.js Neural Bangla TTS & Disk Cache!)
   * - MEANING: Generates clear Bangladeshi Bangla MP3 audio directly inside the Node.js backend (`bn-BD-PradeepNeural` / `bn-BD-NabanitaNeural` + Google Bangla TTS fallback) and caches it on disk by SHA-256 hash.
   * - WHY WE USE IT: Ensures the AI always speaks fluent, natural Bangla without requiring a separate Python server or relying on Windows' English browser voice.
   * ============================================================================
   */
  readonly name = 'local_http';
  public readonly cacheDir: string;
  private ttsServiceBackoffUntil = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly publicApiBaseUrl = 'http://localhost:4000'
  ) {
    this.cacheDir = path.resolve(process.cwd(), '.tts-cache');
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  async synthesize(req: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
    const voice = req.voice || 'bn-BD-PradeepNeural';
    const format = req.format ?? 'mp3';
    const cacheKey = crypto
      .createHash('sha256')
      .update(`${voice}:${req.language}:${format}:${req.text.trim()}`)
      .digest('hex');

    const filename = `${cacheKey}.${format}`;
    const filePath = path.join(this.cacheDir, filename);
    const nodeServedAudioUrl = `${this.publicApiBaseUrl.replace(/\/$/, '')}/api/tts/audio/${filename}`;

    // 1. Check local SHA-256 disk cache first (~1ms)
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 256) {
      return {
        audioUrl: nodeServedAudioUrl,
        cacheKey,
        cached: true,
        provider: 'bangla-neural-cache',
      };
    }

    // 2. Primary (Fastest): Persistent Python FastAPI TTS Microservice on port 8000 (stays warm in RAM, zero Python boot delay!)
    const normalizedTtsBaseUrl = this.baseUrl
      .replace(/\/$/, '')
      .replace('://localhost:', '://127.0.0.1:');
    if (Date.now() >= this.ttsServiceBackoffUntil) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${normalizedTtsBaseUrl}/synthesize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: req.text,
            voice,
            language: req.language,
            format,
          }),
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as {
            audio_url: string;
            cache_key: string;
            cached: boolean;
            engine: string;
          };
          return {
            audioUrl: data.audio_url.startsWith('http')
              ? data.audio_url
              : `${normalizedTtsBaseUrl}${data.audio_url}`,
            cacheKey: data.cache_key,
            cached: data.cached,
            provider: `persistent-tts:${data.engine || this.name}`,
          };
        }
      } catch {
        // Back off probing port 8000 for 30s if the persistent TTS service is not running
        this.ttsServiceBackoffUntil = Date.now() + 30_000;
      } finally {
        clearTimeout(timer);
      }
    }

    // 3. Secondary: Built-in Node.js Microsoft Edge Neural Bangladeshi Bangla TTS WebSocket (zero Python boot delay!)
    try {
      const mp3Buf = await synthesizeEdgeNeuralBanglaMp3(req.text, voice);
      fs.writeFileSync(filePath, mp3Buf);
      return {
        audioUrl: nodeServedAudioUrl,
        cacheKey,
        cached: false,
        provider: 'edge-neural-bn-BD',
      };
    } catch (edgeErr) {
      logger.warn(
        { err: edgeErr instanceof Error ? edgeErr.message : String(edgeErr) },
        'Edge Neural WebSocket unavailable; trying local edge-tts CLI fallback'
      );
    }

    // 4. Tertiary: Local `edge-tts` CLI fallback
    const cliOk = await synthesizeWithInstalledEdgeTtsCli(req.text, voice, filePath);
    if (cliOk) {
      return {
        audioUrl: nodeServedAudioUrl,
        cacheKey,
        cached: false,
        provider: `edge-neural-${voice}`,
      };
    }

    // 5. Final fallback: Built-in Google Bangla TTS stream in Node.js
    const gBuf = await synthesizeGoogleTranslateBanglaMp3(req.text);
    fs.writeFileSync(filePath, gBuf);
    return {
      audioUrl: nodeServedAudioUrl,
      cacheKey,
      cached: false,
      provider: 'google-bangla-tts',
    };
  }
}

export class MockTtsAdapter implements TtsAdapter {
  readonly name = 'mock';
  private cache = new Map<string, string>();

  async synthesize(req: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
    const cacheKey = crypto
      .createHash('sha256')
      .update(`${req.voice}:${req.language}:${req.format ?? 'mp3'}:${req.text}`)
      .digest('hex');
    const cached = this.cache.has(cacheKey);
    const audioUrl = `http://localhost:8000/audio/${cacheKey}.${req.format ?? 'mp3'}`;
    if (!cached) {
      this.cache.set(cacheKey, audioUrl);
    }
    return { audioUrl, cacheKey, cached, provider: this.name };
  }
}

export function createTtsAdapter(env: AppEnv): TtsAdapter {
  if (env.TTS_PROVIDER === 'mock' || env.NODE_ENV === 'test') {
    return new MockTtsAdapter();
  }
  return new LocalHttpTtsAdapter(env.TTS_SERVICE_URL, env.PUBLIC_CALLBACK_BASE_URL);
}
