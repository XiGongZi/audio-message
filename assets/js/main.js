import { SimpleAudioModem } from "./audio-modem.js";

const statusEl = document.getElementById("status");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const clearButton = document.getElementById("clearButton");
const logList = document.getElementById("messageLog");

const modem = new SimpleAudioModem({
  sampleRate: 48000,
  bitsPerSymbol: 4,
  symbolDuration: 0.035,
  baseFrequency: 1500,
  frequencyStep: 130,
  guardDuration: 0.1,
  amplitude: 0.22,
});

let isListening = false;

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
    setStatus("监听中，可发送消息。");
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

bindUi();
bindModemEvents();
updateControls();
