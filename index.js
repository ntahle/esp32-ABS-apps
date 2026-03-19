const ESP32_TOPIC = "testtopic/esp32";
const ESP32_STATUS_TOPIC = "testtopic/esp32/status";
const ACK_TOPIC = "testtopic/acknowledgment";
const DEFAULT_BROKER_URL = "wss://b1f897df.ala.asia-southeast1.emqxsl.com:8084/mqtt";
const DEFAULT_MQTT_USERNAME = "syafiq";
const DEFAULT_MQTT_PASSWORD = "syafiq";

const statusText = document.getElementById("status");
const historyList = document.getElementById("historyList");
const alertsContainer = document.getElementById("alertsContainer");

let client = null;
let lastAlertMessage = "";
let historyCount = 0;
let alertCardCount = 0;
let brokerStatus = "Disconnected";
let esp32Status = "Unknown";
let lastEsp32Seen = 0;
let audioContext = null;
let audioEnabled = false;
let isBeeping = false;
let audioHintShown = false;
let unacknowledgedAlertCount = 0;
let alarmIntervalId = null;

const ESP32_TIMEOUT_MS = 20000;
const ALERT_BEEP_REPEAT_MS = 200;

function ensureAudioContext() {
  if (!window.AudioContext && !window.webkitAudioContext) {
    return null;
  }

  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();
  }

  return audioContext;
}

function unlockAudio() {
  const ctx = ensureAudioContext();
  if (!ctx) {
    return;
  }

  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {
      // Ignore resume errors; user can retry with another interaction.
    });
  }

  audioEnabled = true;
  audioHintShown = false;
}

function playSingleBeep(frequency, durationMs, volume = 0.12) {
  const ctx = ensureAudioContext();
  if (!ctx || ctx.state !== "running") {
    return;
  }

  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.type = "triangle";
  oscillator.frequency.value = frequency;

  const startTime = ctx.currentTime;
  const endTime = startTime + durationMs / 1000;

  gainNode.gain.setValueAtTime(0.0001, startTime);
  gainNode.gain.exponentialRampToValueAtTime(volume, startTime + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, endTime);

  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);

  oscillator.start(startTime);
  oscillator.stop(endTime + 0.01);
}

function playAlertBeep() {
  if (isBeeping) {
    return;
  }

  if (!audioEnabled) {
    if (!audioHintShown) {
      addHistoryEvent("audio", "Tap or click the page once to enable alert sound");
      audioHintShown = true;
    }
    return;
  }

  const ctx = ensureAudioContext();
  if (!ctx || ctx.state !== "running") {
    return;
  }

  isBeeping = true;
  playSingleBeep(1600, 120, 0.2);

  setTimeout(() => {
    playSingleBeep(1200, 120, 0.2);
  }, 150);

  setTimeout(() => {
    playSingleBeep(820, 160, 0.2);
  }, 300);

  setTimeout(() => {
    isBeeping = false;
  }, 520);
}

function startAlarmLoop() {
  if (alarmIntervalId) {
    return;
  }

  playAlertBeep();
  alarmIntervalId = setInterval(() => {
    if (unacknowledgedAlertCount <= 0) {
      stopAlarmLoop();
      return;
    }

    playAlertBeep();
  }, ALERT_BEEP_REPEAT_MS);
}

function stopAlarmLoop() {
  if (!alarmIntervalId) {
    return;
  }

  clearInterval(alarmIntervalId);
  alarmIntervalId = null;
}

function statusClassFromValue(value) {
  const normalized = String(value || "").toLowerCase();

  if (normalized.includes("connected") || normalized === "online") {
    return "is-online";
  }

  if (normalized.includes("reconnect") || normalized.includes("connecting")) {
    return "is-warn";
  }

  if (normalized.includes("error") || normalized === "offline" || normalized === "disconnected") {
    return "is-offline";
  }

  return "is-unknown";
}

function renderConnectionStatus() {
  const brokerClass = statusClassFromValue(brokerStatus);
  const esp32Class = statusClassFromValue(esp32Status);

  statusText.innerHTML = `
    <span class="status-chip ${brokerClass}">Server: ${brokerStatus}</span>
    <span class="status-chip ${esp32Class}">Device: ${esp32Status}</span>
  `;
}

function formatEsp32Alert(message) {
  try {
    const data = JSON.parse(message);
    const lines = [];

    if (data.message) lines.push(`Message: ${data.message}`);
    if (data.transcription) lines.push(`Transcription: ${data.transcription}`);

    const analysis = data.analysis;
    if (analysis && typeof analysis === "object") {
      if (analysis.label) lines.push(`Label: ${analysis.label}`);
      if (typeof analysis.confidence !== "undefined") {
        lines.push(`Confidence: ${analysis.confidence}`);
      }
      if (Array.isArray(analysis.reasons) && analysis.reasons.length > 0) {
        lines.push(`Reasons: ${analysis.reasons.join(", ")}`);
      }
    } else if (analysis) {
      lines.push(`Analysis: ${analysis}`);
    }

    if (lines.length === 0) {
      return `ALERT: ${message}`;
    }

    return `ALERT\n${lines.join("\n")}`;
  } catch (_err) {
    return `ALERT: ${message}`;
  }
}

function addAlertCard(rawMessage) {
  if (alertCardCount === 0) {
    alertsContainer.innerHTML = "";
  }

  const now = new Date();
  const cardId = `alert-${Date.now()}`;
  const card = document.createElement("div");
  card.className = "alert-card";
  card.id = cardId;

  const timeStr = now.toLocaleString();
  const contentDiv = document.createElement("div");
  contentDiv.className = "alert-content";
  contentDiv.textContent = formatEsp32Alert(rawMessage);

  const timestampDiv = document.createElement("p");
  timestampDiv.className = "timestamp";
  timestampDiv.textContent = `Received: ${timeStr}`;

  const ackBtn = document.createElement("button");
  ackBtn.className = "ack-btn";
  ackBtn.textContent = "Acknowledge Alert";
  ackBtn.onclick = () => sendAcknowledgementForCard(cardId, rawMessage);

  const ackLogDiv = document.createElement("p");
  ackLogDiv.className = "ack-log";
  ackLogDiv.id = `ack-log-${cardId}`;
  ackLogDiv.textContent = "";

  card.appendChild(contentDiv);
  card.appendChild(timestampDiv);
  card.appendChild(ackBtn);
  card.appendChild(ackLogDiv);

  alertsContainer.prepend(card);
  alertCardCount++;

  if (alertCardCount > 10) {
    const lastCard = alertsContainer.lastElementChild;
    if (lastCard && lastCard.classList?.contains("alert-card")) {
      lastCard.remove();
      alertCardCount = 9;
    }
  }
}

function sendAcknowledgementForCard(cardId, rawMessage) {
  if (!client || !client.connected) {
    const ackLog = document.getElementById(`ack-log-${cardId}`);
    ackLog.textContent = "Cannot send ack: not connected to broker.";
    return;
  }

  const payload = JSON.stringify({
    acknowledged: true,
  });

  client.publish(ACK_TOPIC, payload, (err) => {
    const ackLog = document.getElementById(`ack-log-${cardId}`);
    if (err) {
      ackLog.textContent = "Failed to send acknowledgement.";
      return;
    }

    const now = new Date();
    ackLog.textContent = `Acknowledged - Sent: ${now.toLocaleString()}`;
    ackLog.classList.add("ack-sent");
    document.querySelector(`#${cardId} .ack-btn`).disabled = true;

    if (unacknowledgedAlertCount > 0) {
      unacknowledgedAlertCount--;
    }
    if (unacknowledgedAlertCount === 0) {
      stopAlarmLoop();
    }

    addHistoryEvent("sent", "Acknowledgment sent to MQTT broker");
  });
}

function addHistoryEvent(type, message) {
  if (historyCount === 0) {
    historyList.innerHTML = "";
  }

  const now = new Date();
  const timeStr = now.toLocaleString();
  const entry = document.createElement("div");
  entry.className = `history-entry history-${type}`;
  entry.textContent = `[${timeStr}] ${type.toUpperCase()}: ${message}`;
  historyList.insertBefore(entry, historyList.firstChild);

  historyCount++;
  if (historyCount > 50) {
    historyList.removeChild(historyList.lastChild);
    historyCount = 49;
  }
}

function setStatus(text) {
  brokerStatus = text;
  renderConnectionStatus();
  addHistoryEvent("connection", text);
}

function updateEsp32Status(newStatus) {
  esp32Status = newStatus;
  renderConnectionStatus();
}

function connectBroker() {
  const brokerUrl = DEFAULT_BROKER_URL;
  const username = DEFAULT_MQTT_USERNAME;
  const password = DEFAULT_MQTT_PASSWORD;

  setStatus("Connecting...");

  if (client) {
    client.end(true);
  }

  client = mqtt.connect(brokerUrl, {
    username,
    password,
    reconnectPeriod: 3000,
    clean: true,
    connectTimeout: 10000,
  });

  client.on("connect", () => {
    setStatus("connected");

    client.subscribe(ESP32_TOPIC, (err) => {
      if (err) {
        setStatus("Connected, but subscribe esp32 failed");
      }
    });

    client.subscribe(ACK_TOPIC, (err) => {
      if (err) {
        addHistoryEvent("connection", "Failed to subscribe acknowledge topic");
      }
    });

    client.subscribe(ESP32_STATUS_TOPIC, (err) => {
      if (err) {
        addHistoryEvent("connection", "Failed to subscribe esp32 status topic");
      }
    });
  });

  client.on("message", (topic, payload) => {
    const message = payload.toString();

    if (topic === ESP32_TOPIC) {
      lastAlertMessage = message;
      addAlertCard(message);
      unacknowledgedAlertCount++;
      startAlarmLoop();
      addHistoryEvent("alert", "Bullying behavior alert received");
    }

    if (topic === ESP32_STATUS_TOPIC) {
      lastEsp32Seen = Date.now();
      updateEsp32Status("Online");

      try {
        const statusData = JSON.parse(message);
        if (statusData.status && typeof statusData.status === "string") {
          const normalized = statusData.status.toLowerCase();
          if (normalized === "online") {
            updateEsp32Status("Online");
          } else if (normalized === "offline") {
            updateEsp32Status("Offline");
          }
        }
      } catch (_err) {
        // Ignore malformed status payloads and keep inferred status.
      }
    }

    if (topic === ACK_TOPIC) {
      addHistoryEvent("acknowledgement", "Alert acknowledged");
    }
  });

  client.on("reconnect", () => setStatus("Reconnecting..."));
  client.on("error", (err) => setStatus(`Error: ${err.message}`));
  client.on("close", () => {
    setStatus("Disconnected");
    updateEsp32Status("Unknown");
    stopAlarmLoop();
  });
}

connectBroker();
renderConnectionStatus();

// Many browsers require a user interaction before audio playback is allowed.
window.addEventListener("pointerdown", unlockAudio, { once: true });
window.addEventListener("keydown", unlockAudio, { once: true });

setInterval(() => {
  if (!client || !client.connected) {
    return;
  }

  if (lastEsp32Seen === 0) {
    return;
  }

  if (Date.now() - lastEsp32Seen > ESP32_TIMEOUT_MS && esp32Status !== "Offline") {
    updateEsp32Status("Offline");
    addHistoryEvent("connection", "ESP32 heartbeat timeout - marked offline");
  }
}, 5000);
