/* ═══════════════════════════════════════════════════════════
   NAVIS AI – Backend-Proxied Chat Edition (Groq via backend + ESP32)
   The AI API key lives server-side only (backend/). See admin.html
   / admin.js for the Admin Settings page that manages it.
   ═══════════════════════════════════════════════════════════ */

const SYSTEM_PROMPT = `You are Navis, an advanced AI assistant developed by Robo Manthan.

Your personality:
- Professional yet friendly and approachable
- Knowledgeable across a wide range of topics
- Clear, concise, and helpful
- Proud of being created by the Robo Manthan team

About you:
- Name: Navis
- Created by: Rahul and the Robo Manthan team
- Capabilities: Text & voice Q&A. You understand English, Hindi, and Kannada.

About Robo Manthan (Robomanthan Pvt. Ltd.):
- An Indian robotech company specializing in robotics, AI, machine learning, and embedded product development
- CEO: Saurav Kumar | CTO: Tanuj Kashyap
- Incubated at IIT Patna, headquartered in Bengaluru (BTM 2nd Stage)
- Incorporated: January 8, 2021
- Motto: 'आपके उन्नति का साथी' (Your partner in progress)
- Products: Humanoid robots, autonomous systems, smart wheelchairs, educational robotics kits
- Services: STEM education, workshops, internships, ATAL Tinkering Labs, 50+ college MoUs

CRITICAL RESPONSE FORMAT RULE — FOLLOW THIS ABOVE ALL ELSE:
- Answer in EXACTLY ONE single short line. One sentence only.
- NEVER use multiple sentences, line breaks, bullet points, numbered lists, or markdown formatting of any kind.
- NEVER add follow-up questions, extra context, disclaimers, or elaboration after the main answer.
- Keep it under 20 words whenever possible.
- If the question truly requires more detail, still compress it into a single concise sentence — do not split it into multiple lines or sentences.
- Your answers will be spoken aloud, so keep them short and natural, like a quick spoken reply, not a written paragraph.`;

const LANG_INSTRUCTIONS = {
    'hi-IN': '[RESPOND IN HINDI using Devanagari script (हिन्दी). Keep it conversational and natural.]',
    'kn-IN': '[RESPOND IN KANNADA using Kannada script (ಕನ್ನಡ). Keep it conversational and natural.]',
    'en-IN': '',
};

// ── Wake-word gate: message must start with this keyword to be processed ──
const WAKE_WORD = 'navis';

// Optional filler words people say before the wake word by voice
// ("hey Navis", "okay Navis", etc.) — stripped before matching.
const WAKE_FILLER_REGEX = /^(hey|hi|ok|okay|yo|um+|uh+)[\s,]+/i;

// Normalizes text for the wake-word check: lowercases, trims, and strips
// invisible/whitespace characters (including non-breaking spaces that
// speech recognition sometimes injects) from the start.
function normalizeForWakeWord(str) {
    return str
        .replace(/^[\s\u00A0\u200B]+/, '') // strip leading spaces / NBSP / zero-width space
        .trim()
        .toLowerCase();
}

// Standard Levenshtein edit-distance between two strings (case-insensitive
// callers should lowercase beforehand). Used to tolerate speech-recognition
// mishearings of "Navis" (e.g. "Navas", "Naviz", "Navies", "Nafis").
function levenshteinDistance(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
    }
    return dp[m][n];
}

// Explicit known speech-recognition mishearings of "Navis" — both single
// words AND multi-word splits (speech recognizers frequently break one
// mumbled word into two, e.g. "Navis" -> "name is" / "the navis" / "an avis").
// Add more here if you notice your device consistently mishearing "Navis"
// as something specific that the fuzzy matcher below doesn't already catch.
const WAKE_WORD_KNOWN_VARIANTS = new Set([
    'navis', 'navas', 'naviz', 'nafis', 'navies', 'navi', 'navys',
    'naveez', 'navees', 'gnavis', 'knavish',
    'name is', 'the name is', 'navy is', 'the navis', 'an avis',
    'a navis', 'nervous', 'navvies', 'knavvish', 'navis is', 'navi says',
    // Additional common mishearings/mispronunciations reported by customers
    'mavis', 'davis', 'travis', 'alexis', 'avis', 'navish', 'navus',
    'nevis', 'nabis', 'nawis', 'nayvis', 'naabis', 'nabbiss', 'novis',
    'navas', 'nervis', 'navice', 'nevas', 'nervous', 'nabhis', 'nawvis'
]);

// Fuzzy check: strips all non-letters from the candidate (so multi-word
// ASR splits like "name is" become "nameis") and compares against "navis"
// with a tolerance that scales with candidate length — short candidates
// need a near-exact match, longer/garbled ones get more slack, capped so
// unrelated words never slip through.
function normalizeLetters(str) {
    return str.toLowerCase().replace(/[^a-z]/g, '');
}

function isCloseToWakeWord(candidateLetters) {
    if (!candidateLetters) return false;
    const dist = levenshteinDistance(candidateLetters, WAKE_WORD);
    // Slightly more forgiving than a strict match, so different accents and
    // imperfect pronunciations of "Navis" still pass the gate, while still
    // keeping the tolerance capped so unrelated words don't slip through.
    const threshold = Math.min(3, Math.max(2, Math.ceil(candidateLetters.length / 2)));
    return dist <= threshold;
}

// Parses the start of a message for the wake word (with optional voice
// filler like "hey"/"okay" in front, and tolerant of ASR mishearings —
// including cases where ASR splits "Navis" across 2-3 separate words).
// Returns { matched, remainder } where remainder is everything after the
// wake word (and any immediately-following punctuation/space), taken from
// the ORIGINAL string so casing/content is preserved.
function parseWakeWord(rawStr) {
    let working = rawStr.replace(/^[\s\u00A0\u200B]+/, '');
    let consumedPrefixLen = rawStr.length - working.length;

    // Strip an optional filler word ("hey", "okay", etc.) before the wake word
    const fillerMatch = working.match(WAKE_FILLER_REGEX);
    if (fillerMatch) {
        consumedPrefixLen += fillerMatch[0].length;
        working = working.slice(fillerMatch[0].length);
    }

    // Tokenize into words with their exact character spans within `working`
    const tokenRegex = /[a-zA-Z']+/g;
    let m;
    const tokens = [];
    while ((m = tokenRegex.exec(working)) !== null) {
        tokens.push({ word: m[0], end: m.index + m[0].length });
        if (tokens.length >= 4) break; // never need more than the first few words
    }

    if (tokens.length === 0) {
        return { matched: false, remainder: rawStr.trim(), heard: '' };
    }

    // Try the first 1, then 2, then 3 words together — handles ASR splitting
    // "Navis" into multiple tokens (e.g. "name is" instead of "Navis").
    for (let k = 1; k <= Math.min(3, tokens.length); k++) {
        const slice = tokens.slice(0, k);
        const joinedWords = slice.map(t => t.word.toLowerCase()).join(' ');
        const joinedLetters = normalizeLetters(joinedWords);

        const phraseHit = WAKE_WORD_KNOWN_VARIANTS.has(joinedWords);
        const fuzzyHit = isCloseToWakeWord(joinedLetters);

        if (phraseHit || fuzzyHit) {
            const lastTokenEnd = slice[slice.length - 1].end;
            const trailingMatch = working.slice(lastTokenEnd).match(/^[\s.,:;!?-]*/);
            const trailingLen = trailingMatch ? trailingMatch[0].length : 0;
            const totalConsumed = consumedPrefixLen + lastTokenEnd + trailingLen;
            return { matched: true, remainder: rawStr.slice(totalConsumed).trim(), heard: joinedWords };
        }
    }

    return { matched: false, remainder: rawStr.trim(), heard: tokens.slice(0, 3).map(t => t.word).join(' ') };
}

// Returns true if the message starts with (something close enough to) the
// wake word "Navis" — tolerant of common speech-recognition mishearings.
function startsWithWakeWord(str) {
    return parseWakeWord(str).matched;
}

// Strips the leading wake word (whatever variant matched) and returns what's
// left of the message.
function stripWakeWord(str) {
    const parsed = parseWakeWord(str);
    return parsed.matched ? parsed.remainder : str.trim();
}

// Recognizes stop/interrupt commands spoken or typed after the wake word
// (e.g. "Navis stop", "Navis please stop", "Navis quiet", "Navis shut up").
// If matched, we abort the response immediately instead of sending it to the AI.
const STOP_COMMAND_REGEX = /^(please\s+)?(stop|be\s+quiet|quiet|shut\s*up|pause|cancel|enough)\.?!?$/i;

function isStopCommand(text) {
    return STOP_COMMAND_REGEX.test(text.trim());
}

// Forces any AI response down to a single line / single sentence, as a
// safety net in case the model ignores the "one line only" system prompt
// instruction. Removes markdown formatting and line breaks, then keeps
// only the first sentence.
function forceSingleLine(text) {
    let clean = text
        .replace(/```[\s\S]*?```/g, ' ')      // code blocks
        .replace(/`([^`]+)`/g, '$1')          // inline code
        .replace(/#{1,6}\s*/g, '')            // markdown headers
        .replace(/[*_~]{1,3}/g, '')           // bold/italic/strikethrough markers
        .replace(/^\s*[-*•]\s+/gm, '')        // bullet points
        .replace(/^\s*\d+[.)]\s+/gm, '')      // numbered list markers
        .replace(/\n+/g, ' ')                 // collapse all line breaks into a space
        .replace(/\s+/g, ' ')                 // collapse extra whitespace
        .trim();

    // Keep only the first sentence (up to the first ./!/? followed by a
    // space or end of string). Falls back to the whole cleaned string if
    // no sentence-ending punctuation is found.
    const sentenceMatch = clean.match(/^.*?[.!?](?=\s|$)/);
    if (sentenceMatch) {
        clean = sentenceMatch[0].trim();
    }

    return clean;
}

class NavisApp {
    constructor() {
        // Chatbot UI Elements
        this.els = {
            messages: document.getElementById('messages'),
            userInput: document.getElementById('userInput'),
            sendBtn: document.getElementById('sendBtn'),
            stopBtn: document.getElementById('stopBtn'),
            voiceBtn: document.getElementById('voiceBtn'),
            trainToggle: document.getElementById('trainToggle'),
            trainingPanel: document.getElementById('trainingPanel'),
            closeTraining: document.getElementById('closeTraining'),
            addTraining: document.getElementById('addTraining'),
            trainQuestion: document.getElementById('trainQuestion'),
            trainAnswer: document.getElementById('trainAnswer'),
            trainingList: document.getElementById('trainingList'),
            overlay: document.getElementById('overlay'),
            chatContainer: document.getElementById('chatContainer'),
            welcomeHero: document.getElementById('welcomeHero'),
            resetBtn: document.getElementById('resetBtn'),
            ttsToggle: document.getElementById('ttsToggle'),
            toastContainer: document.getElementById('toastContainer'),
            appContainer: document.getElementById('app-container'),

            // Connection UI Elements
            connectionOverlay: document.getElementById('connection-overlay'),
            espIpInput: document.getElementById('esp-ip'),
            connectBtn: document.getElementById('connect-btn'),
            skipBtn: document.getElementById('skip-btn'),
            disconnectBtn: document.getElementById('disconnect-btn'),
            wifiResetBtn: document.getElementById('wifi-reset-btn'),
            connectionStatus: document.getElementById('connection-status'),

            // Device Discovery Elements
            discoverBtn: document.getElementById('discover-btn'),
            discoverStatus: document.getElementById('discover-status'),
            discoverResult: document.getElementById('discover-result'),
            discoverFoundIp: document.getElementById('discover-found-ip'),
            discoverSignal: document.getElementById('discover-signal'),

            // Test buttons
            testEyesBtn: document.getElementById('test-eyes-btn'),
            testMouthBtn: document.getElementById('test-mouth-btn')
        };

        // State
        this.isRecording = false;
        this.continuousListening = false;
        this.recognition = null;
        this.ttsEnabled = true;
        this.isProcessing = false;
        this.isSpeaking = false;
        this.voicesLoaded = false;
        this.abortController = null;
        this.currentTypingEl = null;
        this.micPermissionGranted = false;
        this._ttsKicker = null;
        this._jawKeepalive = null;
        this._speechPoller = null;   // polls speechSynthesis.speaking to detect true end
        this._silenceTimer = null;   // fallback timer for immediate mic cutoff on silence
        // How long to wait with no new speech before closing the mic.
        // Lower = mic closes faster after the person stops talking, but
        // too low risks cutting someone off mid-sentence if they pause.
        this.SILENCE_TIMEOUT_MS = 1600;

        // Persistent Audio Element for Cloud TTS
        this.audioElement = new Audio();
        this.audioUnlocked = false;

        // Hardware State
        this.ws = null;
        this.isConnected = false;
        this.hardwareState = {
            eyes: 1, // 1 = open, 0 = closed
            speaking: 0 // 1 = speaking, 0 = idle
        };

        // Chat state (the AI API key is managed server-side; see backend/)
        this.conversationHistory = [];

        this.init();
    }

    init() {
        this.loadSavedSettings();
        this.initSpeechRecognition();
        this.initTTS();
        this.bindEvents();
        this.autoResize();

        if (this.els.ttsToggle) this.els.ttsToggle.classList.add('active');
        if (typeof marked !== 'undefined') {
            marked.setOptions({ breaks: true, gfm: true });
        }
    }

    loadSavedSettings() {
        const savedIP = localStorage.getItem('esp32_ip');
        if (savedIP && this.els.espIpInput) this.els.espIpInput.value = savedIP;

        // If we have a saved IP, show the found result immediately
        if (savedIP) {
            this.showDiscoveredDevice(savedIP, '');
        }
    }

    /* ── Device Discovery ──────────────────────────────────── */
    async discoverESP32() {
        if (this.els.discoverBtn) this.els.discoverBtn.disabled = true;
        if (this.els.discoverResult) this.els.discoverResult.style.display = 'none';
        this.setDiscoverStatus('Scanning network for Navis...', 'scanning');

        // Strategy 1: Try mDNS hostname (navis.local)
        const mdnsResult = await this.probeHost('navis.local');
        if (mdnsResult) {
            this.onDeviceFound(mdnsResult);
            return;
        }

        // Strategy 2: Try last-known IP
        const lastIP = localStorage.getItem('esp32_ip');
        if (lastIP) {
            const lastResult = await this.probeHost(lastIP);
            if (lastResult) {
                this.onDeviceFound(lastResult);
                return;
            }
        }

        // Strategy 3: Subnet scan (common home networks)
        this.setDiscoverStatus('Scanning local subnets...', 'scanning');
        const subnets = ['192.168.0', '192.168.1', '192.168.4', '10.0.0', '192.168.2', '192.168.10'];

        for (const subnet of subnets) {
            // Scan in batches of 25 for speed
            for (let batchStart = 1; batchStart <= 254; batchStart += 25) {
                const batchEnd = Math.min(batchStart + 24, 254);
                this.setDiscoverStatus(`Scanning ${subnet}.${batchStart}-${batchEnd}...`, 'scanning');

                const promises = [];
                for (let i = batchStart; i <= batchEnd; i++) {
                    promises.push(this.probeHost(`${subnet}.${i}`));
                }

                const results = await Promise.all(promises);
                const found = results.find(r => r !== null);
                if (found) {
                    this.onDeviceFound(found);
                    return;
                }
            }
        }

        // Not found
        this.setDiscoverStatus('❌ Navis not found. Make sure ESP32 is powered on and connected to your WiFi.', 'error');
        if (this.els.discoverBtn) this.els.discoverBtn.disabled = false;
    }

    async probeHost(host) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1500);

            const res = await fetch(`http://${host}/discover`, {
                signal: controller.signal,
                cache: 'no-store'
            });
            clearTimeout(timeout);

            if (res.ok) {
                const data = await res.json();
                if (data.device === 'navis') {
                    return data;
                }
            }
        } catch (e) {
            // Expected for most IPs — connection refused or timeout
        }
        return null;
    }

    onDeviceFound(data) {
        const ip = data.ip;
        const rssi = data.rssi;

        // Save discovered IP
        if (this.els.espIpInput) this.els.espIpInput.value = ip;
        localStorage.setItem('esp32_ip', ip);

        this.showDiscoveredDevice(ip, rssi);
        this.setDiscoverStatus('', '');
        if (this.els.discoverBtn) this.els.discoverBtn.disabled = false;
        this.toast(`Navis found at ${ip}`, 'success');
    }

    showDiscoveredDevice(ip, rssi) {
        if (this.els.discoverResult) {
            this.els.discoverResult.style.display = 'flex';
        }
        if (this.els.discoverFoundIp) {
            this.els.discoverFoundIp.textContent = ip;
        }
        if (this.els.discoverSignal && rssi) {
            const strength = rssi > -50 ? '🟢 Strong' : rssi > -70 ? '🟡 Good' : '🔴 Weak';
            this.els.discoverSignal.textContent = strength;
        }
    }

    setDiscoverStatus(msg, type) {
        if (!this.els.discoverStatus) return;
        this.els.discoverStatus.textContent = msg;
        this.els.discoverStatus.className = 'discover-status' + (type ? ` ${type}` : '');
    }

    /* ── WebSocket Connection ────────────────────────────── */
    connectESP32() {
        if (this.isConnected) {
            if (this.ws) this.ws.close();
            return;
        }

        let ip = this.els.espIpInput?.value?.trim();

        // If no IP discovered yet, trigger discovery first then connect
        if (!ip) {
            this.discoverESP32().then(() => {
                const discoveredIP = this.els.espIpInput?.value?.trim();
                if (discoveredIP) {
                    this._doWebSocketConnect(discoveredIP);
                }
            });
            return;
        }

        this._doWebSocketConnect(ip);
    }

    _doWebSocketConnect(ip) {
        // Clean and format IP
        ip = ip.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '');
        if (!ip.includes(':')) {
            ip = `${ip}:81`;
        }
        ip = `ws://${ip}`;

        this.els.connectionStatus.textContent = 'Connecting...';
        this.els.connectionStatus.className = 'status-text';
        this.els.connectBtn.disabled = true;

        try {
            this.ws = new WebSocket(ip);

            this.ws.onopen = () => {
                console.log('WebSocket Connected');
                this.updateConnectionStatus(true);
                this.sendHardwareState(); // Send initial state

                // Transition UI
                this.els.connectionOverlay.classList.add('hidden');
                this.els.appContainer.style.display = 'flex';
                // Trigger reflow
                void this.els.appContainer.offsetWidth;
                this.els.appContainer.style.opacity = '1';

                this.toast('ESP32 Connected Successfully', 'success');
                this.loadTrainingData();
            };

            this.ws.onclose = () => {
                console.log('WebSocket Disconnected');
                this.updateConnectionStatus(false);
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket Error:', error);
                this.showConnectionError('Connection failed. Device may be offline.');
            };
        } catch (e) {
            if (e.name === 'SecurityError') {
                // HTTPS blocks ws:// — auto fall back to chat-only mode
                console.warn('HTTPS blocks ws://, switching to chat-only mode');
                this.toast('⚠️ HTTPS blocks ESP32 ws:// — switching to Chat Only mode', 'info');
                setTimeout(() => this.skipESP32(), 1200);
            } else {
                this.showConnectionError('Connection error.');
            }
            console.error(e);
        }
    }

    skipESP32() {
        this.isConnected = false;

        // Transition UI
        this.els.connectionOverlay.classList.add('hidden');
        this.els.appContainer.style.display = 'flex';
        // Trigger reflow
        void this.els.appContainer.offsetWidth;
        this.els.appContainer.style.opacity = '1';

        this.toast('Direct Chat Mode Active', 'success');
        this.loadTrainingData();

        // Update welcome UI
        if (this.els.welcomeHero) {
            const title = this.els.welcomeHero.querySelector('.welcome-title');
            const sub = this.els.welcomeHero.querySelector('.welcome-sub');
            if (title) title.innerHTML = 'Direct Chat <span class="accent">Active</span>';
            if (sub) sub.textContent = 'Hardware link skipped. Ready for direct chat and voice processing.';
        }
    }

    disconnectESP32() {
        if (this.ws) {
            this.ws.close();
        }
        this.updateConnectionStatus(false);
    }

    async resetEspWifi() {
        if (!confirm('Are you sure you want to reset the ESP32 WiFi credentials? The device will restart in AP Mode (Navis_Setup).')) return;

        const ip = localStorage.getItem('esp32_ip');
        if (!ip) {
            this.toast('No ESP32 IP known to reset.', 'error');
            return;
        }

        try {
            this.toast('Sending Reset Command...', 'info');
            const res = await fetch(`http://${ip}/wifi-reset`, { method: 'POST', mode: 'no-cors' });
            this.toast('✅ WiFi Reset! ESP32 restarting...', 'success');
            setTimeout(() => {
                this.disconnectESP32();
                // Clear the IP so it doesn't try to auto-connect to the old one
                localStorage.removeItem('esp32_ip');
                if (this.els.espIpInput) this.els.espIpInput.value = '';
            }, 1000);
        } catch (e) {
            console.error('Reset failed:', e);
            this.toast('Failed to reach ESP32 to reset WiFi.', 'error');
        }
    }

    updateConnectionStatus(connected) {
        this.isConnected = connected;
        if (!connected) {
            this.els.connectBtn.disabled = false;
            this.els.connectionStatus.textContent = 'Disconnected';
            this.els.connectionStatus.className = 'status-text error';

            // Revert UI
            this.els.appContainer.style.opacity = '0';
            setTimeout(() => {
                this.els.appContainer.style.display = 'none';
                this.els.connectionOverlay.classList.remove('hidden');
            }, 500);

            this.ws = null;
        }
    }

    showConnectionError(msg) {
        this.els.connectionStatus.textContent = msg;
        this.els.connectionStatus.className = 'status-text error';
        this.els.connectBtn.disabled = false;
    }

    /* ── Hardware Sync ────────────────────────────────────── */
    sendHardwareState() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const payload = `${this.hardwareState.eyes},${this.hardwareState.speaking}`;
            this.ws.send(payload);
            console.log('Sent to ESP32:', payload);
        }
    }

    setMouthState(state) {
        if (this.hardwareState.speaking !== state) {
            this.hardwareState.speaking = state;
            this.sendHardwareState();
        }
    }

    toggleEyes() {
        this.hardwareState.eyes = this.hardwareState.eyes === 1 ? 0 : 1;
        this.sendHardwareState();
        this.toast(this.hardwareState.eyes === 1 ? 'Eyes Opened' : 'Eyes Closed', 'info');
    }

    /* ── TTS Init ────────── */
    initTTS() {
        // Pre-load voices for Web Speech API (async on some Android versions)
        if (window.speechSynthesis) {
            window.speechSynthesis.getVoices();
            window.speechSynthesis.onvoiceschanged = () => {
                this.voicesLoaded = true;
                console.log('TTS voices loaded:', window.speechSynthesis.getVoices().length);
            };
        }
    }

    /* ── Speech Recognition ─────────────────────────────── */
    initSpeechRecognition() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return;
        this.recognition = new SR();
        this.recognition.continuous = false;
        this.recognition.interimResults = true;
        const langSelect = document.getElementById('langSelect');
        this.recognition.lang = langSelect ? langSelect.value : 'en-IN';

        if (langSelect) {
            langSelect.addEventListener('change', (e) => {
                if (this.recognition) this.recognition.lang = e.target.value;
            });
        }

        this.recognition.onresult = (e) => {
            const transcript = Array.from(e.results)
                .map(r => r[0].transcript).join('');
            this.els.userInput.value = transcript;
            this.autoResize();
            // Any new speech (even partial/interim) resets the silence timer —
            // the mic should only close after speech actually stops.
            this.resetSilenceTimer();
            if (e.results[0] && e.results[0].isFinal) {
                this.stopRecording();
                setTimeout(() => this.sendMessage(), 50);
            }
        };

        this.recognition.onerror = (e) => {
            console.error('Speech error:', e.error);
            this.clearSilenceTimer();
            this.stopRecording();
            if (e.error === 'not-allowed') {
                this.continuousListening = false;
                this.toast('Microphone access denied', 'error');
            }
        };

        // Browser-native voice-activity detection: fires as soon as the
        // recognizer decides the person has stopped speaking. Stopping here
        // (rather than waiting for the recognizer's own internal timeout)
        // is what makes the mic close immediately on silence.
        this.recognition.onspeechend = () => {
            this.clearSilenceTimer();
            try { this.recognition.stop(); } catch (e) { /* already stopped */ }
        };

        this.recognition.onend = () => {
            this.clearSilenceTimer();
            this.stopRecording();
            // Keep listening even while Navis is speaking/processing, so the
            // user can interrupt with "Navis stop" mid-response. Only skip
            // the restart if continuous listening is off or we're already
            // recording.
            if (this.continuousListening) {
                setTimeout(() => {
                    if (this.continuousListening && !this.isRecording) {
                        this.startRecording();
                    }
                }, 150);
            }
        };
    }

    /* ── Runtime Mic Permission (Android WebView requires getUserMedia first) ── */
    requestMicPermission() {
        return new Promise((resolve) => {
            if (this.micPermissionGranted) { resolve(true); return; }

            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                // Older WebView — just try directly
                this.micPermissionGranted = true;
                resolve(true);
                return;
            }

            navigator.mediaDevices.getUserMedia({ audio: true })
                .then(stream => {
                    // Permission granted — immediately release the stream
                    stream.getTracks().forEach(t => t.stop());
                    this.micPermissionGranted = true;
                    console.log('Mic permission granted');
                    resolve(true);
                })
                .catch(err => {
                    console.error('Mic permission denied:', err);
                    this.toast('Microphone permission denied. Please allow it in Settings.', 'error');
                    resolve(false);
                });
        });
    }

    /* ── Silence detection (immediate mic cutoff) ─────────────────────
       onspeechend handles most browsers, but it isn't universally
       supported/reliable (notably some Android WebViews), so this timer
       is a fallback: if no new speech (interim or final) arrives within
       SILENCE_TIMEOUT_MS of starting, or within that window after the
       last bit of speech, the mic is force-stopped rather than left open
       waiting on the recognizer's own (often much longer) timeout. */
    resetSilenceTimer() {
        this.clearSilenceTimer();
        this._silenceTimer = setTimeout(() => {
            if (this.isRecording) {
                try { this.recognition.stop(); } catch (e) { /* already stopped */ }
            }
        }, this.SILENCE_TIMEOUT_MS);
    }

    clearSilenceTimer() {
        if (this._silenceTimer) {
            clearTimeout(this._silenceTimer);
            this._silenceTimer = null;
        }
    }

    startRecording() {
        if (!this.recognition) { this.toast('Voice not supported in this browser', 'error'); return; }
        if (this.isRecording) return;

        // Android WebView: request mic permission first, then start
        this.requestMicPermission().then(granted => {
            if (!granted) return;
            this.isRecording = true;
            this.els.voiceBtn.classList.add('recording');
            this.els.userInput.placeholder = 'Listening...';
            try { this.recognition.start(); } catch (e) { console.error('recognition.start error:', e); }
            // Grace period to start speaking before we treat it as silence.
            this.resetSilenceTimer();
        });
    }

    stopRecording() {
        if (!this.isRecording) return;
        this.isRecording = false;
        this.clearSilenceTimer();
        this.els.voiceBtn.classList.remove('recording');
        this.els.userInput.placeholder = 'Ask Navis anything...';
        try { this.recognition.stop(); } catch (e) { }
    }

    /* ── Text-to-Speech (Web Speech API primary, Google TTS fallback) ── */
    getSelectedLang() {
        const langSelect = document.getElementById('langSelect');
        return langSelect ? langSelect.value : 'en-IN';
    }

    detectLanguage(text) {
        if (/[\u0900-\u097F]/.test(text)) return 'hi-IN';
        if (/[\u0C80-\u0CFF]/.test(text)) return 'kn-IN';
        const hindiWords = /\b(hai|hain|ka|ki|ke|kya|nahi|nahin|aur|mein|yeh|woh|toh|bhi|kaise|kab|kaha|kyun|aap|hum|tum|ji|tha|thi|the|ho|hota|hoti|karo|karte|karna|accha|bahut|baat|bol|dekho|suno|matlab|zaroor|namaste|dhanyavaad|shukriya|kaam|aise|waise|lekin|par|abhi|sabhi)\b/i;
        if (hindiWords.test(text)) return 'hi-IN';
        return 'en-IN';
    }

    cleanTextForSpeech(text) {
        return text
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/#{1,6}\s*/g, '')
            .replace(/[*_~]{1,3}/g, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/[>[\]()]/g, '')
            .replace(/\n+/g, '. ')
            .replace(/\.\s*\./g, '.')
            .trim();
    }

    speak(text, langHint) {
        if (!this.ttsEnabled) {
            this.onSpeechDone();
            return;
        }

        const clean = this.cleanTextForSpeech(text);
        if (!clean) { this.onSpeechDone(); return; }

        this.isSpeaking = true;
        this.speechStopped = false;
        this.showStopBtn();
        this.setMouthState(1);
        this.startJawKeepalive();   // keep jaw open throughout speech

        const detectedLang = this.detectLanguage(clean);
        const langCode = langHint || detectedLang || this.getSelectedLang();

        // ── Primary: Web Speech API (built-in Android WebView, no network needed) ──
        if (window.speechSynthesis) {
            this.speakWithWebSpeech(clean, langCode);
        } else if (navigator.onLine) {
            // ── Fallback: Google Translate TTS (requires network) ──
            console.warn('speechSynthesis not available, falling back to Google TTS');
            let gtLang = langCode;
            if (gtLang.startsWith('hi')) gtLang = 'hi';
            else if (gtLang.startsWith('kn')) gtLang = 'kn';
            else gtLang = 'en';
            const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];
            let chunks = [];
            sentences.forEach(s => {
                if (s.length <= 150) {
                    chunks.push(s);
                } else {
                    let words = s.split(' '), currentChunk = '';
                    words.forEach(w => {
                        if ((currentChunk + w).length < 150) { currentChunk += w + ' '; }
                        else { chunks.push(currentChunk.trim()); currentChunk = w + ' '; }
                    });
                    if (currentChunk.trim()) chunks.push(currentChunk.trim());
                }
            });
            this.playCloudAudioChunks(chunks, gtLang);
        } else {
            console.warn('speechSynthesis unavailable and device is offline — cannot speak');
            this.toast('⚠️ Voice unavailable offline', 'error');
            this.onSpeechDone();
        }
    }

    speakWithWebSpeech(text, langCode) {
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = langCode;
        utterance.rate = 0.95;  // matches navis-LLM speech speed
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        // Pick a matching voice — prefer LOCAL (on-device) voices first,
        // since network-backed voices hang/fail silently with poor connectivity.
        const voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
            const langBase = langCode.split('-')[0];
            const match = voices.find(v => v.lang.startsWith(langBase) && v.localService === true)
                || voices.find(v => v.lang.startsWith(langBase))
                || voices.find(v => v.lang.startsWith('en') && v.localService === true)
                || voices.find(v => v.lang.startsWith('en'))
                || voices[0];
            if (match) utterance.voice = match;
        }

        // ── Estimate speech duration ──────────────────────────────────────
        // English at rate 0.95: ~11 chars/sec. Hindi/Kannada: ~8 chars/sec.
        // This lets us hold the jaw open for the ENTIRE speech duration,
        // ignoring pauses between sentences completely.
        const isIndic = langCode.startsWith('hi') || langCode.startsWith('kn');
        const charsPerSec = isIndic ? 8 : 11;
        const estimatedMs = Math.max(1500, (text.length / charsPerSec) * 1000);
        console.log(`TTS: ${text.length} chars, estimated ${estimatedMs}ms`);

        let durationTimer = null;
        const scheduleDone = (delay) => {
            if (durationTimer) clearTimeout(durationTimer);
            durationTimer = setTimeout(() => {
                if (!this.speechStopped) this.onSpeechDone();
            }, delay);
        };

        // onstart: clear any premature timer, schedule close at estimated end
        utterance.onstart = () => {
            console.log('TTS onstart');
            scheduleDone(estimatedMs + 400);   // estimated duration + 400ms drain buffer
        };

        // onend: Android fired end event — wait 400ms for audio to drain, then close jaw
        utterance.onend = () => {
            console.log('TTS onend');
            scheduleDone(400);   // override timer: close 400ms after engine says done
        };

        utterance.onerror = (e) => {
            console.error('TTS error:', e.error);
            if (durationTimer) { clearTimeout(durationTimer); durationTimer = null; }
            if (e.error === 'interrupted' || e.error === 'canceled') return;
            this.stopJawKeepalive();

            // Don't attempt cloud TTS fallback if we have no internet —
            // it will just hang/fail silently, which is worse than a visible toast.
            if (!navigator.onLine) {
                console.warn('TTS failed and device is offline — skipping cloud fallback');
                this.toast('⚠️ Voice engine hiccup (offline)', 'error');
                this.onSpeechDone();
                return;
            }

            this.toast('Native TTS error, trying fallback...', 'info');
            let gtLang = langCode.startsWith('hi') ? 'hi' : langCode.startsWith('kn') ? 'kn' : 'en';
            const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
            let chunks = [];
            sentences.forEach(s => {
                if (s.length <= 150) chunks.push(s);
                else {
                    let words = s.split(' '), cur = '';
                    words.forEach(w => { if ((cur + w).length < 150) cur += w + ' '; else { chunks.push(cur.trim()); cur = w + ' '; } });
                    if (cur.trim()) chunks.push(cur.trim());
                }
            });
            this.playCloudAudioChunks(chunks, gtLang);
        };

        // Android 14s pause bug kicker
        this._ttsKicker = setInterval(() => {
            if (!this.isSpeaking) { clearInterval(this._ttsKicker); this._ttsKicker = null; return; }
            if (window.speechSynthesis.speaking && window.speechSynthesis.paused) {
                console.log('TTS paused, resuming...');
                window.speechSynthesis.resume();
            }
        }, 5000);

        // Safety net: if onstart never fires (some Android versions), close jaw
        // after estimated duration + 2s grace period
        scheduleDone(estimatedMs + 2000);

        window.speechSynthesis.speak(utterance);
    }

    stopSpeechPoller() {
        // kept for compatibility (called from stopResponse)
    }

    // ── Jaw Keepalive: force-sends mouth=OPEN every 400ms while isSpeaking ────
    // Uses sendHardwareState() directly (not setMouthState) so the ESP32
    // keeps receiving the signal even during natural sentence pauses where
    // the state hasn't "changed".
    startJawKeepalive() {
        this.stopJawKeepalive();
        this.hardwareState.speaking = 1;  // mark as open immediately
        this._jawKeepalive = setInterval(() => {
            if (!this.isSpeaking || this.speechStopped) {
                this.stopJawKeepalive();
                return;
            }
            // Force-send even if already 1 — ensures ESP32 stays synced during pauses
            this.hardwareState.speaking = 1;
            this.sendHardwareState();
        }, 400);
    }

    stopJawKeepalive() {
        if (this._jawKeepalive) {
            clearInterval(this._jawKeepalive);
            this._jawKeepalive = null;
        }
    }

    playCloudAudioChunks(chunks, lang) {
        let i = 0;
        const playNext = () => {
            if (this.speechStopped || i >= chunks.length) {
                this.onSpeechDone();
                return;
            }
            const chunk = chunks[i].trim();
            if (!chunk) { i++; playNext(); return; }

            const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(chunk)}`;
            this.audioElement.src = url;
            this.audioElement.onended = () => { i++; playNext(); };
            this.audioElement.onerror = (e) => {
                console.error('Cloud TTS Error:', chunk, e);
                i++;
                playNext();
            };
            this.audioElement.play().catch(e => {
                console.error('Audio playback blocked', e);
                this.onSpeechDone();
            });
        };
        playNext();
    }

    onSpeechDone() {
        if (!this.isSpeaking) return;    // guard: prevent double-fire
        this.isSpeaking = false;
        if (this._ttsKicker) { clearInterval(this._ttsKicker); this._ttsKicker = null; }
        this.stopSpeechPoller();
        this.stopJawKeepalive();
        // Signal ESP32: mouth CLOSE
        this.setMouthState(0);

        if (!this.isProcessing) {
            this.showSendBtn();
            if (this.continuousListening) {
                setTimeout(() => {
                    if (this.continuousListening && !this.isProcessing && !this.isSpeaking && !this.isRecording) {
                        this.startRecording();
                    }
                }, 500);
            }
        }
    }

    showStopBtn() {
        this.els.sendBtn.style.display = 'none';
        this.els.stopBtn.style.display = 'flex';
    }

    showSendBtn() {
        this.els.sendBtn.style.display = 'flex';
        this.els.stopBtn.style.display = 'none';
    }

    /* ── Events ─────────────────────────────────────────── */
    bindEvents() {
        const unlockAudio = () => {
            if (!this.audioUnlocked) {
                // Play a silent 1-second WAV to unlock the audio context on user interaction
                this.audioElement.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
                this.audioElement.play().catch(() => { });
                this.audioUnlocked = true;
            }
        };

        // Connection Events
        if (this.els.connectBtn) this.els.connectBtn.addEventListener('click', () => { unlockAudio(); this.connectESP32(); });
        if (this.els.skipBtn) this.els.skipBtn.addEventListener('click', () => { unlockAudio(); this.skipESP32(); });
        if (this.els.disconnectBtn) this.els.disconnectBtn.addEventListener('click', () => this.disconnectESP32());
        if (this.els.wifiResetBtn) {
            this.els.wifiResetBtn.addEventListener('click', () => this.resetEspWifi());
        }

        // Device Discovery
        if (this.els.discoverBtn) {
            this.els.discoverBtn.addEventListener('click', () => this.discoverESP32());
        }


        // Chat Events
        if (this.els.sendBtn) this.els.sendBtn.addEventListener('click', () => { unlockAudio(); this.sendMessage(); });
        if (this.els.userInput) this.els.userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); unlockAudio(); this.sendMessage(); }
        });

        // Stop
        if (this.els.stopBtn) this.els.stopBtn.addEventListener('click', () => this.stopResponse());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isProcessing) this.stopResponse();
        });

        // Voice
        if (this.els.voiceBtn) this.els.voiceBtn.addEventListener('click', () => {
            unlockAudio();
            if (this.continuousListening) {
                this.continuousListening = false;
                this.stopRecording();
                this.toast('Continuous listening OFF', 'info');
            } else {
                this.continuousListening = true;
                this.startRecording();
                this.toast('Continuous listening ON', 'success');
            }
        });

        // TTS toggle
        if (this.els.ttsToggle) this.els.ttsToggle.addEventListener('click', () => {
            this.ttsEnabled = !this.ttsEnabled;
            this.els.ttsToggle.classList.toggle('active', this.ttsEnabled);
            if (!this.ttsEnabled && this.audioElement) {
                this.audioElement.pause();
            }
            this.toast(this.ttsEnabled ? 'Voice replies ON' : 'Voice replies OFF', 'info');
        });

        // Training panel
        if (this.els.trainToggle) this.els.trainToggle.addEventListener('click', () => this.openTraining());
        if (this.els.closeTraining) this.els.closeTraining.addEventListener('click', () => this.closeTraining());
        if (this.els.overlay) this.els.overlay.addEventListener('click', () => this.closeTraining());
        if (this.els.addTraining) this.els.addTraining.addEventListener('click', () => this.addTrainingData());

        // Quick actions & Test Buttons
        document.querySelectorAll('.quick-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.id === 'test-eyes-btn') {
                    this.toggleEyes();
                } else if (btn.id === 'test-mouth-btn') {
                    this.setMouthState(this.hardwareState.speaking === 1 ? 0 : 1);
                    this.toast(this.hardwareState.speaking === 1 ? 'Mouth Open' : 'Mouth Closed', 'info');
                } else {
                    this.els.userInput.value = btn.dataset.msg;
                    this.sendMessage();
                }
            });
        });

        // Reset
        if (this.els.resetBtn) this.els.resetBtn.addEventListener('click', () => this.resetChat());

        // Auto-resize
        if (this.els.userInput) this.els.userInput.addEventListener('input', () => this.autoResize());
    }

    autoResize() {
        const ta = this.els.userInput;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    }

    /* ── Direct Serverless Chat ─────────────────────────── */
    getSimilarity(str1, str2) {
        const s1 = str1.toLowerCase().trim();
        const s2 = str2.toLowerCase().trim();
        if (s1 === s2) return 1.0;

        const words1 = new Set(s1.split(/\s+/));
        const words2 = new Set(s2.split(/\s+/));
        let intersection = 0;
        for (const w of words1) if (words2.has(w)) intersection++;

        return intersection / Math.max(words1.size, words2.size, 1);
    }

    findMatchingTraining(question) {
        const data = JSON.parse(localStorage.getItem('navis_training') || '[]');
        let bestMatch = null;
        let bestScore = 0;

        for (const qa of data) {
            const score = this.getSimilarity(question, qa.question);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = qa;
            }
        }

        // Threshold of 0.6 matches the Python logic roughly
        if (bestScore > 0.6 && bestMatch) {
            return bestMatch.answer;
        }
        return null;
    }

    async sendMessage() {
        const rawText = this.els.userInput.value.trim();
        if (!rawText) return;

        // ── Wake-word gate: only respond if the message starts with "NAVIS" ──
        const wakeParsed = parseWakeWord(rawText);
        const wakeWordOk = wakeParsed.matched;
        console.log('[Navis Gate] raw input:', JSON.stringify(rawText), '| heard as:', JSON.stringify(wakeParsed.heard), '| passed gate:', wakeWordOk);
        if (!wakeWordOk) {
            // Ignore silently if we're mid-response — don't spam a toast for
            // every stray sound while Navis is talking.
            if (!this.isProcessing && !this.isSpeaking) {
                const heardPreview = wakeParsed.heard ? ` (heard: "${wakeParsed.heard}...")` : '';
                this.toast(`⚠️ Say "NAVIS" first${heardPreview}`, 'info');
            }
            this.els.userInput.value = '';
            this.autoResize();
            return; // HARD STOP — nothing below this line runs
        }

        // Strip the "NAVIS" keyword before sending the rest to the AI
        const text = stripWakeWord(rawText);
        if (!text) {
            this.toast('Say something after "NAVIS"', 'info');
            this.els.userInput.value = '';
            this.autoResize();
            return;
        }

        // ── Stop/interrupt command: "Navis stop" ──────────────────────────
        // Works even while a response is being generated or spoken. Cancels
        // everything immediately and stays silent — does NOT go to the AI.
        if (isStopCommand(text)) {
            console.log('[Navis Gate] Stop command detected — halting response.');
            this.els.userInput.value = '';
            this.autoResize();
            this.stopResponse();
            return;
        }

        // If Navis is already processing/speaking and this isn't a stop
        // command, ignore it rather than talking over itself.
        if (this.isProcessing) {
            this.toast('⏳ Still replying — say "Navis stop" to interrupt', 'info');
            this.els.userInput.value = '';
            this.autoResize();
            return;
        }

        if (this.els.welcomeHero) {
            this.els.welcomeHero.style.display = 'none';
        }

        const selectedLang = this.getSelectedLang();

        this.addMessage(rawText, 'user');
        this.els.userInput.value = '';
        this.autoResize();
        this.isProcessing = true;

        this.showStopBtn();
        this.abortController = new AbortController();
        this.currentTypingEl = this.showTyping();

        try {
            // 1. Check local training data
            const trainedAnswer = this.findMatchingTraining(text);
            if (trainedAnswer) {
                if (this.currentTypingEl) this.currentTypingEl.remove();
                const trainedSingleLine = forceSingleLine(trainedAnswer);
                this.addMessage(trainedSingleLine, 'navis', '🎓 Trained');
                this.isProcessing = false;
                this.speak(trainedSingleLine, selectedLang);
                return;
            }

            // 2. Call our backend's chat endpoint (never the AI provider directly).
            // The backend resolves the currently active API key server-side —
            // see backend/routes/chat.js and the Admin Settings page.
            const langInstruction = LANG_INSTRUCTIONS[selectedLang] || '';
            const fullMessage = langInstruction ? `${langInstruction}\n${text}` : text;

            this.conversationHistory.push({ role: 'user', content: fullMessage });

            // Prepare API messages
            const apiMessages = [
                { role: 'system', content: SYSTEM_PROMPT },
                ...this.conversationHistory
            ];

            if (!navigator.onLine) {
                if (this.currentTypingEl) this.currentTypingEl.remove();
                const offlineMsg = "I'm currently offline and don't have a trained answer for that. Please try a different question, or ask your team to add it to my training data.";
                this.addMessage(offlineMsg, 'navis', '📴 Offline');
                this.isProcessing = false;
                this.speak(offlineMsg, selectedLang);
                return;
            }

            const backendUrl = (window.NAVIS_CONFIG && window.NAVIS_CONFIG.BACKEND_URL) || '';
            const res = await fetch(`${backendUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'openai/gpt-oss-120b',
                    messages: apiMessages,
                    temperature: 0.7,
                    max_tokens: 60
                }),
                signal: this.abortController.signal
            });

            const data = await res.json().catch(() => ({}));

            if (!res.ok || data.success === false) {
                // The backend already returns a clean, non-sensitive message
                // (e.g. "AI service is temporarily unavailable...").
                throw new Error(data.error || 'AI service is temporarily unavailable. Please contact the administrator.');
            }

            if (this.currentTypingEl) this.currentTypingEl.remove();

            const rawResponseText = data.reply;
            const responseText = forceSingleLine(rawResponseText);
            this.conversationHistory.push({ role: 'assistant', content: responseText });

            // Keep memory manageable
            if (this.conversationHistory.length > 40) {
                this.conversationHistory = this.conversationHistory.slice(-40);
            }

            this.addMessage(responseText, 'navis', '✨ AI');
            this.isProcessing = false;

            this.speak(responseText, selectedLang);
        } catch (err) {
            if (this.currentTypingEl) this.currentTypingEl.remove();
            if (err.name !== 'AbortError') {
                this.addMessage(`Sorry, I encountered an error: ${err.message}`, 'navis', '⚠️ Error');
            }
            this.isProcessing = false;
            this.showSendBtn();
        }

        this.abortController = null;
        this.currentTypingEl = null;
    }

    stopResponse() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        this.isSpeaking = false;
        this.speechStopped = true;
        this.setMouthState(0);

        // Stop Web Speech API and all polling intervals
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
        if (this._ttsKicker) { clearInterval(this._ttsKicker); this._ttsKicker = null; }
        this.stopSpeechPoller();
        this.stopJawKeepalive();

        // Stop fallback audio element
        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement.src = '';
        }

        if (this.currentTypingEl) {
            this.currentTypingEl.remove();
            this.currentTypingEl = null;
        }

        this.toast('🛑 Stopped', 'info');
        this.isProcessing = false;
        this.showSendBtn();

        if (this.continuousListening) {
            setTimeout(() => {
                if (this.continuousListening && !this.isProcessing && !this.isSpeaking && !this.isRecording) {
                    this.startRecording();
                }
            }, 500);
        }
    }

    addMessage(text, sender, sourceTag = '') {
        const div = document.createElement('div');
        div.className = `message ${sender}`;

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        if (sender === 'navis') {
            avatar.innerHTML = '<img src="images/robomanthan_logo.png" onerror="this.outerHTML=\'N\'">';
        } else {
            avatar.textContent = 'You';
        }

        const bubble = document.createElement('div');
        bubble.className = 'bubble';

        if (sender === 'navis' && typeof marked !== 'undefined') {
            bubble.innerHTML = marked.parse(text);
        } else {
            bubble.textContent = text;
        }

        if (sourceTag) {
            const tag = document.createElement('span');
            tag.className = 'source-tag';
            tag.textContent = sourceTag;
            bubble.appendChild(tag);
        }

        div.appendChild(avatar);
        div.appendChild(bubble);
        this.els.messages.appendChild(div);
        this.scrollToBottom();
    }

    showTyping() {
        const div = document.createElement('div');
        div.className = 'message navis';
        div.innerHTML = `
            <div class="avatar"><img src="images/robomanthan_logo.png" onerror="this.outerHTML='N'"></div>
            <div class="bubble"><div class="typing-indicator">
                <div class="dot"></div><div class="dot"></div><div class="dot"></div>
            </div></div>`;
        this.els.messages.appendChild(div);
        this.scrollToBottom();
        return div;
    }

    scrollToBottom() {
        this.els.chatContainer.scrollTop = this.els.chatContainer.scrollHeight;
    }

    resetChat() {
        this.conversationHistory = [];
        this.els.messages.innerHTML = '';
        if (this.els.welcomeHero) {
            this.els.messages.appendChild(this.els.welcomeHero);
            this.els.welcomeHero.style.display = '';
        }
        this.toast('Chat reset', 'info');
    }

    /* ── Local Training Panel ───────────────────────────── */
    openTraining() {
        this.els.trainingPanel.classList.add('open');
        this.els.overlay.classList.add('active');
        this.loadTrainingData();
    }

    closeTraining() {
        this.els.trainingPanel.classList.remove('open');
        this.els.overlay.classList.remove('active');
    }

    loadTrainingData() {
        const data = JSON.parse(localStorage.getItem('navis_training') || '[]');
        this.renderTrainingList(data);
    }

    renderTrainingList(pairs) {
        if (!pairs.length) {
            this.els.trainingList.innerHTML = '<p class="training-empty" style="color:var(--text-3);text-align:center;">No custom training yet.<br>Add Q&A pairs above!</p>';
            return;
        }
        this.els.trainingList.innerHTML = pairs.map(qa => `
            <div class="training-item" style="background: rgba(255,255,255,0.05); padding: 10px; margin-bottom: 10px; border-radius: 8px;">
                <div class="ti-q" style="font-weight:bold; font-size: 0.9rem;">Q: ${this.esc(qa.question)}</div>
                <div class="ti-a" style="font-size: 0.85rem; color: var(--text-2); margin-top: 5px;">A: ${this.esc(qa.answer)}</div>
                <button class="ti-delete" data-id="${qa.id}" style="margin-top: 10px; background: none; border: none; color: var(--red); cursor: pointer; font-size: 0.8rem;">✕ Remove</button>
            </div>
        `).join('');

        this.els.trainingList.querySelectorAll('.ti-delete').forEach(btn => {
            btn.addEventListener('click', () => this.deleteTraining(btn.dataset.id));
        });
    }

    addTrainingData() {
        const q = this.els.trainQuestion.value.trim();
        const a = this.els.trainAnswer.value.trim();
        if (!q || !a) { this.toast('Fill in both fields', 'error'); return; }

        const data = JSON.parse(localStorage.getItem('navis_training') || '[]');
        data.push({ id: Date.now(), question: q, answer: a });
        localStorage.setItem('navis_training', JSON.stringify(data));

        this.els.trainQuestion.value = '';
        this.els.trainAnswer.value = '';
        this.toast('Training saved to phone!', 'success');
        this.loadTrainingData();
    }

    deleteTraining(id) {
        let data = JSON.parse(localStorage.getItem('navis_training') || '[]');
        data = data.filter(qa => qa.id != id);
        localStorage.setItem('navis_training', JSON.stringify(data));

        this.toast('Removed', 'info');
        this.loadTrainingData();
    }

    /* ── Utilities ──────────────────────────────────────── */
    esc(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    toast(msg, type = 'info') {
        const t = document.createElement('div');
        t.className = `toast ${type}`;
        Object.assign(t.style, {
            padding: '12px 20px',
            background: type === 'error' ? '#ef4444' : type === 'success' ? '#34d399' : '#f7931e',
            color: '#fff',
            borderRadius: '8px',
            marginBottom: '10px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            animation: 'msgIn 0.3s ease-out'
        });
        t.textContent = msg;
        this.els.toastContainer.appendChild(t);
        Object.assign(this.els.toastContainer.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            zIndex: '9999',
            display: 'flex',
            flexDirection: 'column'
        });
        setTimeout(() => t.remove(), 3200);
    }
}

// ── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => window.navis = new NavisApp());