// Звуковой тракт караоке: музыка, голос-подсказка и микрофоны с эхом и реверберацией.
//
//   minus  → music ┐
//   vocals → guide ┼→ master → выход
//   микрофоны → micBus → срез НЧ → компрессор ┬→ dry ──────────┘
//                                             ├→ эхо (задержка с обратной связью)
//                                             └→ реверберация (свёртка)
import { create } from 'zustand';
import { getSettings, useSettings, type Settings } from '../settings';
import { MicPitch } from './pitch';

interface DeviceState {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  active: [boolean, boolean];
  error: string | null;
  canChooseOutput: boolean;
}

export const useDevices = create<DeviceState>(() => ({
  inputs: [],
  outputs: [],
  active: [false, false],
  error: null,
  canChooseOutput: typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype,
}));

const SMOOTH = 0.03;

function impulse(ctx: AudioContext, seconds: number) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3.2;
  }
  return buffer;
}

class Engine {
  private context: AudioContext | null = null;
  private nodes: ReturnType<Engine['build']> | null = null;
  private reverbSize = 0;
  private sink = '';
  readonly mics: (MicPitch | null)[] = [null, null];
  private micGains: (GainNode | null)[] = [null, null];
  private opened: (string | null)[] = [null, null];
  private pending: Promise<void> = Promise.resolve();

  get ctx(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.nodes = this.build(this.context);
      this.apply(getSettings());
    }
    return this.context;
  }

  // Браузер запускает звук только после действия пользователя: вызывать из обработчиков кликов
  // и клавиш. Сам геттер ctx звук не будит — иначе пауза игры (suspend) снималась бы в следующем кадре.
  wake() {
    const ctx = this.ctx;
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }

  get music() {
    return this.ensure().music;
  }

  get guide() {
    return this.ensure().guide;
  }

  get master() {
    return this.ensure().master;
  }

  private ensure() {
    void this.ctx;
    return this.nodes!;
  }

  private build(ctx: AudioContext) {
    const master = ctx.createGain();
    master.connect(ctx.destination);
    const music = ctx.createGain();
    const guide = ctx.createGain();
    music.connect(master);
    guide.connect(master);

    const micBus = ctx.createGain();
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 110;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
    micBus.connect(highpass).connect(comp);

    const dry = ctx.createGain();
    comp.connect(dry).connect(master);

    const delay = ctx.createDelay(1.5);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3200;
    const feedback = ctx.createGain();
    const echoWet = ctx.createGain();
    comp.connect(delay);
    delay.connect(tone);
    tone.connect(feedback).connect(delay);
    tone.connect(echoWet).connect(master);

    const convolver = ctx.createConvolver();
    const reverbWet = ctx.createGain();
    comp.connect(convolver).connect(reverbWet).connect(master);

    return { master, music, guide, micBus, dry, delay, feedback, echoWet, convolver, reverbWet };
  }

  apply(s: Settings) {
    if (!this.context || !this.nodes) return;
    const n = this.nodes;
    const now = this.context.currentTime;
    const to = (param: AudioParam, value: number) => param.setTargetAtTime(value, now, SMOOTH);
    to(n.master.gain, s.master);
    to(n.music.gain, s.music);
    to(n.guide.gain, s.guide);
    to(n.micBus.gain, s.monitor ? s.micVolume : 0);
    to(n.dry.gain, 1);
    to(n.delay.delayTime, s.echoTime);
    to(n.feedback.gain, Math.min(0.85, s.echoFeedback));
    to(n.echoWet.gain, s.echo);
    to(n.reverbWet.gain, s.reverb * 1.6);
    if (Math.abs(s.reverbSize - this.reverbSize) > 0.05) {
      this.reverbSize = s.reverbSize;
      n.convolver.buffer = impulse(this.context, s.reverbSize);
    }
    if (s.output !== this.sink) void this.setOutput(s.output);
  }

  private async setOutput(id: string) {
    const ctx = this.context as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!ctx?.setSinkId) return;
    this.sink = id;
    try {
      await ctx.setSinkId(id);
    } catch (e) {
      useDevices.setState({ error: `Устройство вывода недоступно: ${(e as Error).message}` });
    }
  }

  // ---------- устройства ----------

  async refreshDevices() {
    if (!navigator.mediaDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter((d) => d.kind === 'audioinput' && d.label);
    const outputs = all.filter((d) => d.kind === 'audiooutput' && d.label && d.deviceId !== 'default');
    useDevices.setState({ inputs, outputs });
    return inputs;
  }

  // Включить микрофоны по просьбе пользователя.
  connectMics(): Promise<boolean> {
    if (!getSettings().micOn) useSettings.getState().set({ micOn: true });
    return this.queue(() => this.connectNow());
  }

  // Подключить, только если пользователь их не выключал (перед песней, при смене устройства).
  ensureMics(): Promise<boolean> {
    return getSettings().micOn ? this.queue(() => this.connectNow()) : Promise.resolve(false);
  }

  disconnectMics(): Promise<void> {
    if (getSettings().micOn) useSettings.getState().set({ micOn: false });
    return this.queue(async () => {
      for (const i of [0, 1]) this.closeMic(i);
      useDevices.setState({ active: [false, false] });
    });
  }

  // Подключения идут по очереди: смена настроек во время открытия не откроет устройство дважды.
  private queue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.pending.then(task);
    this.pending = run.then(() => undefined, () => undefined);
    return run;
  }

  private closeMic(i: number) {
    this.mics[i]?.stop();
    this.micGains[i]?.disconnect();
    this.mics[i] = this.micGains[i] = null;
    this.opened[i] = null;
  }

  private async connectNow(): Promise<boolean> {
    this.wake();
    try {
      await this.openMics();
      useDevices.setState({ error: null });
      return true;
    } catch (e) {
      useDevices.setState({ error: `Микрофон недоступен: ${(e as Error).message}` });
      return false;
    } finally {
      useDevices.setState({ active: [!!this.mics[0], !!this.mics[1]] });
    }
  }

  private async openMics() {
    if (!navigator.mediaDevices) throw new Error('браузер не даёт доступа к микрофону (нужен localhost или https)');
    let inputs = await this.refreshDevices();
    if (!inputs.length) {
      // названия устройств браузер отдаёт только после разрешения
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      inputs = await this.refreshDevices();
    }
    const s = getSettings();
    const known = (id: string) => inputs.some((d) => d.deviceId === id);
    let ids = [known(s.mic0) ? s.mic0 : '', known(s.mic1) ? s.mic1 : ''];
    if (!ids[0] && !ids[1] && inputs.length) {
      ids = [inputs[0].deviceId, ''];
    }
    if (ids[0] !== s.mic0 || ids[1] !== s.mic1) useSettings.getState().set({ mic0: ids[0], mic1: ids[1] });

    const ctx = this.ctx;
    for (const i of [0, 1]) {
      const id = ids[i];
      const key = id && `${id}|${s.aec}`;
      if (this.opened[i] === key) continue;
      this.closeMic(i);
      if (!id) continue;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: id }, echoCancellation: s.aec, noiseSuppression: false, autoGainControl: false },
      });
      const mic = new MicPitch(ctx, stream);
      const gain = ctx.createGain();
      mic.source.connect(gain).connect(this.nodes!.micBus);
      this.mics[i] = mic;
      this.micGains[i] = gain;
      this.opened[i] = key;
    }
  }
}

export const engine = new Engine();

useSettings.subscribe((s, prev) => {
  engine.apply(s);
  if (s.mic0 !== prev.mic0 || s.mic1 !== prev.mic1 || s.aec !== prev.aec) {
    if (engine.mics.some(Boolean) || s.mic0 || s.mic1) void engine.ensureMics();
  }
});

navigator.mediaDevices?.addEventListener('devicechange', () => void engine.refreshDevices());

export async function loadBuffer(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`не загрузился ${url}`);
  return engine.ctx.decodeAudioData(await response.arrayBuffer());
}
