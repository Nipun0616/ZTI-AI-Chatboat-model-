/* ZTI audio module — synthesized UI sounds (Web Audio API), speech-to-text and text-to-speech.
   No external audio files. Exposes a single global: window.ZTIAudio */
(function (global) {
  "use strict";

  const STORE_KEY = "zti.audio.v1";
  const settings = { muted: false, autoSpeak: false, volume: 0.5 };
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(STORE_KEY) || "{}"));
  } catch (_) {}
  const persist = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch (_) {}
  };

  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => { try { fn({ ...settings }); } catch (_) {} });

  /* ---------------------------------------------------------------- */
  /* Web Audio: synthesized sound effects                              */
  /* ---------------------------------------------------------------- */

  let ctx = null;
  let master = null;

  function ensureCtx() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = settings.volume;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp);
      comp.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  // Browsers only allow audio after a user gesture, so unlock on the first one.
  ["pointerdown", "keydown", "touchstart"].forEach((evt) =>
    global.addEventListener(evt, () => ensureCtx(), { once: true, passive: true })
  );

  function tone({ freq, endFreq, type = "sine", start = 0, dur = 0.2, gain = 0.15, attack = 0.01, lowpass }) {
    if (settings.muted) return;
    const c = ensureCtx();
    if (!c) return;
    const t0 = c.currentTime + start;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = osc;
    if (lowpass) {
      const f = c.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = lowpass;
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // Soft futuristic chime — message sent
  function playSend() {
    tone({ freq: 659.25, type: "sine", dur: 0.24, gain: 0.14 });
    tone({ freq: 987.77, type: "sine", start: 0.09, dur: 0.34, gain: 0.11 });
    tone({ freq: 1318.5, type: "triangle", start: 0.09, dur: 0.4, gain: 0.035 });
  }

  // Warm pop + low hum — response finished
  function playDone() {
    tone({ freq: 520, endFreq: 190, type: "sine", dur: 0.15, gain: 0.2, attack: 0.004 });
    tone({ freq: 196, type: "triangle", start: 0.02, dur: 0.5, gain: 0.08, lowpass: 600 });
    tone({ freq: 392, type: "sine", start: 0.08, dur: 0.32, gain: 0.045 });
  }

  // Crisp click — switching personalities, buttons
  function playClick() {
    tone({ freq: 1800, endFreq: 900, type: "square", dur: 0.035, gain: 0.04, attack: 0.002 });
    tone({ freq: 1250, type: "sine", dur: 0.07, gain: 0.07, attack: 0.002 });
  }

  // Activation tone — voice recording on/off
  function playToggle(on) {
    const a = on ? 640 : 960;
    const b = on ? 960 : 640;
    tone({ freq: a, type: "sine", dur: 0.1, gain: 0.12, attack: 0.005 });
    tone({ freq: b, type: "sine", start: 0.08, dur: 0.14, gain: 0.12, attack: 0.005 });
  }

  /* ---------------------------------------------------------------- */
  /* Text-to-speech                                                    */
  /* ---------------------------------------------------------------- */

  const synth = global.speechSynthesis || null;
  const ttsSupported = !!(synth && global.SpeechSynthesisUtterance);
  let voice = null;
  let current = null; // { id, onEnd }
  let speakId = 0;

  function scoreVoice(v) {
    const name = v.name || "";
    const lang = (v.lang || "").replace("_", "-");
    if (!/^en(-|$)/i.test(lang)) return -1;
    let s = 0;
    if (/natural/i.test(name)) s += 60;
    if (/neural/i.test(name)) s += 50;
    if (/online/i.test(name)) s += 25;
    if (/google/i.test(name)) s += 35;
    if (/\b(aria|jenny|ava|emma|libby|sonia|neerja|samantha|serena|karen|moira|zira|guy|daniel)\b/i.test(name)) s += 20;
    if (/siri|premium|enhanced/i.test(name)) s += 25;
    if (/^en-(US|GB|IN|AU)$/i.test(lang)) s += 8;
    if (/novelty|whisper|bells|boing|zarvox|trinoids|cellos|organ|bad news|good news|bubbles/i.test(name)) s -= 100;
    return s;
  }

  function refreshVoice() {
    if (!ttsSupported) return;
    const voices = synth.getVoices();
    if (!voices.length) return;
    let best = null;
    let bestScore = -1;
    for (const v of voices) {
      const sc = scoreVoice(v);
      if (sc > bestScore) {
        best = v;
        bestScore = sc;
      }
    }
    voice = best;
  }
  if (ttsSupported) {
    refreshVoice();
    if ("onvoiceschanged" in synth) synth.onvoiceschanged = refreshVoice;
  }

  // Remove markdown / code / links so speech sounds natural.
  function stripMarkdown(md) {
    let t = String(md || "");
    let hadCode = false;
    t = t.replace(/```[\s\S]*?(```|$)/g, () => {
      hadCode = true;
      return "\n";
    });
    t = t
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/^\s{0,3}#{1,6}\s*/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+[.)]\s+/gm, "")
      .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, "")
      .replace(/\|/g, ", ")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/[\p{Extended_Pictographic}️]/gu, "");
    t = t
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (/[.!?:;,]$/.test(l) ? l : l + "."))
      .join(" ");
    if (hadCode) t += " I've put the code on screen.";
    return t.replace(/\s{2,}/g, " ").trim();
  }

  // Chrome stops long utterances after ~15s, so speak in sentence-sized chunks.
  function chunkText(text, max = 200) {
    const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const chunks = [];
    let buf = "";
    const push = () => {
      if (buf.trim()) chunks.push(buf.trim());
      buf = "";
    };
    for (let s of sentences) {
      while (s.length > max) {
        let cut = s.lastIndexOf(",", max);
        if (cut < 40) cut = s.lastIndexOf(" ", max);
        if (cut < 1) cut = max;
        if (buf.length + cut > max) push();
        buf += s.slice(0, cut + 1);
        push();
        s = s.slice(cut + 1);
      }
      if (buf.length + s.length > max) push();
      buf += s;
    }
    push();
    return chunks;
  }

  function finishCurrent() {
    if (!current) return;
    const c = current;
    current = null;
    try {
      c.onEnd && c.onEnd();
    } catch (_) {}
  }

  function stopSpeaking() {
    if (!ttsSupported) return;
    speakId++;
    synth.cancel();
    finishCurrent();
  }

  /** speak(text, { force, onStart, onEnd }) — force=true speaks even when muted (explicit speaker click). */
  function speak(text, opts = {}) {
    if (!ttsSupported) return false;
    if (settings.muted && !opts.force) return false;
    const clean = stripMarkdown(text);
    if (!clean) return false;

    stopSpeaking();
    const id = ++speakId;
    current = { id, onEnd: opts.onEnd };
    if (!voice) refreshVoice();
    const chunks = chunkText(clean);

    setTimeout(() => {
      if (id !== speakId) return;
      opts.onStart && opts.onStart();
      chunks.forEach((chunk, i) => {
        const u = new global.SpeechSynthesisUtterance(chunk);
        if (voice) {
          u.voice = voice;
          u.lang = voice.lang;
        } else {
          u.lang = "en-US";
        }
        u.rate = 1.03; // slightly brisk, conversational
        u.pitch = 1.04; // a touch brighter
        u.volume = 1;
        const last = i === chunks.length - 1;
        u.onend = () => {
          if (last && current && current.id === id) finishCurrent();
        };
        u.onerror = () => {
          if (current && current.id === id && last) finishCurrent();
        };
        synth.speak(u);
      });
    }, 60);
    return true;
  }

  const isSpeaking = () => !!current;
  const getVoiceName = () => (voice ? voice.name : "");

  /* ---------------------------------------------------------------- */
  /* Speech-to-text                                                    */
  /* ---------------------------------------------------------------- */

  const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
  const voiceInputSupported = !!SR;
  let rec = null;
  let listening = false;

  function startListening({ lang, onTranscript, onStart, onEnd, onError } = {}) {
    if (!SR) return false;
    if (listening) return true;
    stopSpeaking();
    rec = new SR();
    rec.lang = lang || navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    let finalText = "";
    rec.onstart = () => {
      listening = true;
      onStart && onStart();
    };
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      onTranscript && onTranscript((finalText + interim).trim());
    };
    rec.onerror = (e) => {
      onError && onError(e.error || "unknown");
    };
    rec.onend = () => {
      listening = false;
      rec = null;
      onEnd && onEnd();
    };
    try {
      rec.start();
    } catch (err) {
      listening = false;
      rec = null;
      onError && onError(err.message || "start-failed");
      return false;
    }
    return true;
  }

  function stopListening() {
    if (rec) {
      try {
        rec.stop();
      } catch (_) {}
    }
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  function setMuted(v) {
    settings.muted = !!v;
    if (settings.muted) stopSpeaking();
    persist();
    emit();
  }

  function setAutoSpeak(v) {
    settings.autoSpeak = !!v;
    if (!settings.autoSpeak) stopSpeaking();
    persist();
    emit();
  }

  global.ZTIAudio = {
    // sound effects
    playSend,
    playDone,
    playClick,
    playToggle,
    // mute / settings
    isMuted: () => settings.muted,
    setMuted,
    toggleMute: () => {
      setMuted(!settings.muted);
      return settings.muted;
    },
    getAutoSpeak: () => settings.autoSpeak,
    setAutoSpeak,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // speech out
    ttsSupported,
    speak,
    stopSpeaking,
    isSpeaking,
    stripMarkdown,
    getVoiceName,
    // speech in
    voiceInputSupported,
    startListening,
    stopListening,
    isListening: () => listening,
  };
})(window);
