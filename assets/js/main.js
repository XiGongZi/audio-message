import { SimpleAudioModem } from "./audio-modem.js";

const statusEl = document.getElementById("status");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const clearButton = document.getElementById("clearButton");
const logList = document.getElementById("messageLog");
const channelSelect = document.getElementById("channelSelect");
const channelHint = document.getElementById("channelHint");

const BASE_MODEM_CONFIG = {
  sampleRate: 48000,
  bitsPerSymbol: 4,
  symbolDuration: 0.035,
  guardDuration: 0.1,
};

const CHANNEL_PRESETS = {
  audible: {
    label: "标准（1.5–2.8 kHz）",
    hint: "标准频段最稳定，适合初次测试。",
    config: {
      baseFrequency: 1500,
      frequencyStep: 130,
      amplitude: 0.22,
      minEnergy: 0.006,
    },
  },
  high: {
    label: "高频（8–10 kHz）",
    hint: "较安静，但部分设备会衰减高频，请适当调高音量并保持靠近。",
    config: {
      baseFrequency: 8200,
      frequencyStep: 180,
      amplitude: 0.18,
      minEnergy: 0.004,
    },
  },
  ultrasonic: {
    label: "近超声（17–19 kHz）",
    hint: "接近静音，对降噪/硬件要求高；请降低音量并缩短消息。",
    config: {
      baseFrequency: 17500,
      frequencyStep: 180,
      amplitude: 0.12,
      minEnergy: 0.003,
    },
  },
};

const DEFAULT_CHANNEL = "audible";

const modem = new SimpleAudioModem({
  ...BASE_MODEM_CONFIG,
  ...CHANNEL_PRESETS[DEFAULT_CHANNEL].config,
});

let isListening = false;
let currentChannelKey = DEFAULT_CHANNEL;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("status--error", isError);
}

function appendLog(direction, message) {
  const item = document.createElement("li");
  item.className = `log__item log__item--${direction}`;

  const meta = document.createElement("div");
  meta.className = "log__meta";
  const time = new Date().toLocaleTimeString();
  meta.innerHTML = `
    <span>${direction === "outgoing" ? "已发送" : "已接收"}</span>
    <time datetime="${new Date().toISOString()}">${time}</time>
  `;

  const body = document.createElement("p");
  body.textContent = message;

  item.append(meta, body);
  logList.prepend(item);
}

function clearLog() {
  logList.innerHTML = "";
}

function updateControls() {
  sendButton.disabled = !isListening;
  stopButton.disabled = !isListening;
  startButton.disabled = isListening;
}

async function handleStart() {
  setStatus("正在申请麦克风权限...请保持设备安静。");
  startButton.disabled = true;

  try {
    await modem.startListening();
    isListening = true;
    updateControls();
    const preset = CHANNEL_PRESETS[currentChannelKey];
    setStatus(`监听中，可发送消息。（当前频段：${preset.label}）`);
  } catch (error) {
    console.error(error);
    isListening = false;
    updateControls();
    setStatus(error.message ?? "启动监听失败", true);
  }
}

function handleStop() {
  modem.stopListening();
  isListening = false;
  updateControls();
  setStatus('监听已停止，可点击"启用音频"重新开始。');
}

async function handleSend() {
  const message = messageInput.value.trim();
  if (!message) {
    messageInput.focus();
    return;
  }

  try {
    await modem.send(message);
    appendLog("outgoing", message);
    messageInput.value = "";
    messageInput.focus();
    setStatus("已发送声波，请等待对端解码。");
  } catch (error) {
    console.error(error);
    setStatus(`发送失败：${error.message ?? error}`, true);
  }
}

function bindUi() {
  startButton.addEventListener("click", handleStart);
  stopButton.addEventListener("click", handleStop);
  sendButton.addEventListener("click", handleSend);
  clearButton.addEventListener("click", clearLog);

  messageInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      handleSend();
    }
  });

  if (channelSelect) {
    channelSelect.addEventListener("change", () => {
      applyChannel(channelSelect.value);
    });
  }
}

function bindModemEvents() {
  modem.on("message", (message) => {
    appendLog("incoming", message);
    setStatus("收到新消息，继续监听中。");
  });

  modem.on("status", (statusMessage) => {
    setStatus(statusMessage);
  });

  modem.on("error", (error) => {
    console.error(error);
    setStatus(error.message ?? "发生未知错误", true);
  });
}

function applyChannel(channelKey, options = {}) {
  const preset = CHANNEL_PRESETS[channelKey] ?? CHANNEL_PRESETS[DEFAULT_CHANNEL];
  currentChannelKey = channelKey in CHANNEL_PRESETS ? channelKey : DEFAULT_CHANNEL;

  modem.updateConfig({ ...preset.config });

  if (channelHint) {
    channelHint.textContent = preset.hint;
  }

  if (!options.silent) {
    const suffix = isListening ? "监听已自动适配新频段。" : "可随时点击\"启用音频\"测试。";
    setStatus(`频段已切换：${preset.label}，${suffix}`);
  }
}

bindUi();
bindModemEvents();
updateControls();
if (channelSelect) {
  channelSelect.value = currentChannelKey;
}
applyChannel(currentChannelKey, { silent: true });
