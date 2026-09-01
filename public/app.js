const connectBtn = document.getElementById('connectBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const transcriptEl = document.getElementById('transcript');
const toolLogEl = document.getElementById('toolLog');
const memoryViewEl = document.getElementById('memoryView');

let ws = null;
let voiceReady = false;
let micStream = null;
let micContext = null;
let micNode = null;
let playbackContext = null;
let playbackCursor = 0;
let memoryPollTimer = null;
let activeSources = [];

const bubbleByItemId = new Map();

function setStatus(status, label) {
  statusDot.className = `status-dot ${status}`;
  statusText.textContent = label;
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

function appendTranscript({ text, role, response_id }) {
  if (text === '\n') {
    bubbleByItemId.delete(response_id);
    return;
  }
  let bubble = bubbleByItemId.get(response_id);
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = `bubble ${role}`;
    const roleLabel = document.createElement('span');
    roleLabel.className = 'role';
    roleLabel.textContent = role === 'user' ? 'Caller' : 'Scheduling Agent';
    const body = document.createElement('span');
    body.className = 'body';
    bubble.appendChild(roleLabel);
    bubble.appendChild(body);
    transcriptEl.appendChild(bubble);
    bubbleByItemId.set(response_id, bubble);
  }
  bubble.querySelector('.body').textContent += text;
  scrollToBottom(transcriptEl);
}

function appendToolLog(entry) {
  if (toolLogEl.querySelector('.empty')) toolLogEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = `<span class="name">${entry.toolName}</span>`;
  if (entry.args) {
    const pre = document.createElement('pre');
    pre.textContent = `args: ${JSON.stringify(entry.args)}`;
    div.appendChild(pre);
  }
  if (entry.result !== undefined) {
    const pre = document.createElement('pre');
    pre.textContent = `result: ${JSON.stringify(entry.result)}`;
    div.appendChild(pre);
  }
  if (entry.result?.bookingUrl) {
    const link = document.createElement('a');
    link.href = entry.result.bookingUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'booking-link';
    link.textContent = 'Open confirmation link →';
    div.appendChild(link);
  }
  toolLogEl.prepend(div);
  if ((entry.toolName === 'saveLeadInfo' || entry.toolName === 'scheduleEstimate') && entry.result) refreshMemory();
}

async function refreshMemory() {
  try {
    const res = await fetch('/api/memory');
    const data = await res.json();
    memoryViewEl.textContent = data.workingMemory || '— empty —';
  } catch {
    // best-effort UI polling; ignore transient failures
  }
}

function initPlayback() {
  playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  playbackCursor = playbackContext.currentTime;
}

function playPcm16(arrayBuffer) {
  if (!playbackContext) return;
  const int16 = new Int16Array(arrayBuffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;

  const buffer = playbackContext.createBuffer(1, float32.length, 24000);
  buffer.copyToChannel(float32, 0);

  const source = playbackContext.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackContext.destination);

  const startAt = Math.max(playbackContext.currentTime, playbackCursor);
  source.start(startAt);
  activeSources.push(source);
  source.onended = () => {
    activeSources = activeSources.filter((s) => s !== source);
  };
  playbackCursor = startAt + buffer.duration;
}

// Barge-in: Deepgram tells us the user started talking over the agent - stop whatever
// agent audio is currently playing/queued so playback doesn't lag behind the live turn.
function flushPlayback() {
  activeSources.forEach((s) => {
    try {
      s.stop();
    } catch {
      // already stopped/ended - fine to ignore
    }
  });
  activeSources = [];
  if (playbackContext) playbackCursor = playbackContext.currentTime;
}

async function initMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  micContext = new (window.AudioContext || window.webkitAudioContext)();
  await micContext.audioWorklet.addModule('/pcm-worklet.js');
  const source = micContext.createMediaStreamSource(micStream);
  micNode = new AudioWorkletNode(micContext, 'pcm-capture-processor');
  micNode.port.onmessage = (event) => {
    if (voiceReady && ws && ws.readyState === WebSocket.OPEN) ws.send(event.data);
  };
  source.connect(micNode);
}

function teardownAudio() {
  micNode?.port.close();
  micStream?.getTracks().forEach((t) => t.stop());
  micContext?.close();
  playbackContext?.close();
  micStream = null;
  micContext = null;
  micNode = null;
  playbackContext = null;
  activeSources = [];
}

async function connect() {
  setStatus('connecting', 'Connecting…');
  connectBtn.disabled = true;

  try {
    await initMic();
    initPlayback();
  } catch (err) {
    setStatus('error', 'Mic permission denied');
    connectBtn.disabled = false;
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    connectBtn.disabled = false;
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);
      switch (msg.channel) {
        case 'status':
          if (msg.status === 'connected') {
            voiceReady = true;
            setStatus('connected', 'Live');
            connectBtn.textContent = 'Disconnect';
            connectBtn.classList.add('connected');
            refreshMemory();
            memoryPollTimer = setInterval(refreshMemory, 4000);
          }
          break;
        case 'transcript':
          appendTranscript(msg);
          break;
        case 'user-speaking':
          flushPlayback();
          break;
        case 'tool-start':
          appendToolLog({ toolName: msg.toolName, args: msg.args });
          break;
        case 'tool-result':
          appendToolLog({ toolName: msg.toolName, args: msg.args, result: msg.result });
          break;
        case 'error':
          console.error('[server]', msg.message);
          setStatus('error', msg.message.slice(0, 40));
          break;
      }
    } else {
      playPcm16(event.data);
    }
  };

  ws.onclose = () => {
    disconnect();
  };
  ws.onerror = () => {
    setStatus('error', 'Connection error');
  };
}

function disconnect() {
  voiceReady = false;
  clearInterval(memoryPollTimer);
  memoryPollTimer = null;
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  teardownAudio();
  setStatus('disconnected', 'Disconnected');
  connectBtn.textContent = 'Connect';
  connectBtn.classList.remove('connected');
  connectBtn.disabled = false;
}

connectBtn.addEventListener('click', () => {
  if (ws) disconnect();
  else connect();
});
