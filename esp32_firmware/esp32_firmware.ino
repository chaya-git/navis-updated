/*
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          NAVIS — Direct ESP32 WebSocket Controller           ║
 * ║          Robo Manthan Pvt. Ltd.                              ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  Receives commands from Web App via WebSockets (Port 81)     ║
 * ║  Format:  eyes,speaking                                      ║
 * ║  Each value is 0 (closed/idle) or 1 (open/active)            ║
 * ║                                                              ║
 * ║  WiFi Provisioning:                                          ║
 * ║    - On first boot (no saved creds) → AP mode "Navis_Setup" ║
 * ║    - Captive portal at 192.168.4.1 for SSID/Password entry  ║
 * ║    - Credentials saved to NVS (Preferences library)         ║
 * ║    - /wifi-reset endpoint to clear creds and re-provision   ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

#include <DNSServer.h>
#include <ESP32Servo.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WebSocketsServer.h> // Install via Library Manager: "WebSockets" by Markus Sattler
#include <WiFi.h>

// ── Linker Fix for ESP32 Core 3.x ─────────────────────────────
extern "C" bool btInUse() { return false; }

// ── AP Configuration ──────────────────────────────────────────
const char *AP_SSID = "Navis_Setup";
// Open network — no password for easy customer provisioning
const int STA_CONNECT_TIMEOUT = 15000; // 15 seconds to connect to saved WiFi

// ── NVS Storage ───────────────────────────────────────────────
Preferences preferences;
String savedSSID = "";
String savedPassword = "";

// ── Servers ───────────────────────────────────────────────────
WebServer httpServer(80); // Captive portal + REST endpoints
WebSocketsServer webSocket = WebSocketsServer(81);
DNSServer dnsServer;

// ── Pin Definitions ───────────────────────────────────────────
#define PIN_MOUTH 18
#define PIN_EYES 12
#define PIN_LED 2

// ── Servo Angle Config ────────────────────────────────────────
#define MOUTH_OPEN 50  // degrees — jaw down
#define MOUTH_CLOSED 0 // degrees — jaw up / resting
#define EYES_OPEN 90   // degrees — eyelids raised
#define EYES_CLOSED 40 // degrees — eyelids lowered (blink/idle)

#define TIMEOUT_MS 5000

Servo mouthServo;
Servo eyesServo;

int lastEyes = -1;
int lastSpeaking = -1;
unsigned long lastPacketTime = 0;
bool wsConnected = false;

// ── Mode Tracking ─────────────────────────────────────────────
bool isAPMode = false;

// ── Animation Variables ───────────────────────────────────────
unsigned long talkStartTime = 0;
unsigned long lastMouthUpdate = 0;
bool mouthIsOpen = false;

// ── LED Blink for AP Mode ─────────────────────────────────────
unsigned long lastLedBlink = 0;
bool ledState = false;

// ══════════════════════════════════════════════════════════════
//  CAPTIVE PORTAL HTML
// ══════════════════════════════════════════════════════════════

const char PORTAL_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Navis WiFi Setup</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      font-family:'Segoe UI',system-ui,sans-serif;
      background:linear-gradient(145deg,#080b1a,#0f1535,#1a1040);
      color:#e8eaf6;min-height:100vh;
      display:flex;align-items:center;justify-content:center;
      padding:20px;
    }
    .card{
      background:rgba(255,255,255,0.04);
      border:1px solid rgba(255,255,255,0.08);
      border-radius:14px;padding:40px;
      max-width:420px;width:100%;
      box-shadow:0 20px 60px rgba(0,0,0,0.5);
      text-align:center;
    }
    h1{
      font-size:1.6rem;margin-bottom:8px;
      background:linear-gradient(135deg,#f7931e,#ffb347);
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;
      letter-spacing:2px;font-weight:700;
    }
    p{color:rgba(255,255,255,0.6);font-size:0.9rem;margin-bottom:28px}
    .form-group{text-align:left;margin-bottom:18px}
    label{
      display:block;font-size:0.8rem;
      color:rgba(255,255,255,0.6);margin-bottom:6px;
      text-transform:uppercase;letter-spacing:1px;
    }
    input{
      width:100%;padding:14px 16px;
      background:rgba(255,255,255,0.05);
      border:1px solid rgba(255,255,255,0.08);
      border-radius:8px;color:#e8eaf6;
      font-size:1rem;transition:all 0.25s;
    }
    input:focus{
      outline:none;border-color:#f7931e;
      box-shadow:0 0 0 3px rgba(247,147,30,0.25);
      background:rgba(255,255,255,0.08);
    }
    button{
      width:100%;padding:16px;margin-top:10px;
      background:linear-gradient(135deg,#f7931e,#e6700a);
      color:#fff;border:none;border-radius:8px;
      font-size:1.1rem;font-weight:600;cursor:pointer;
      box-shadow:0 4px 15px rgba(247,147,30,0.25);
      transition:all 0.25s;
    }
    button:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(247,147,30,0.35)}
    button:active{transform:translateY(0)}
    .status{margin-top:16px;font-size:0.85rem;color:rgba(255,255,255,0.35)}
    .success{color:#34d399}
    .error{color:#ef4444}
    .icon{font-size:3rem;margin-bottom:16px}
    select {
      width:100%;padding:14px 16px;
      background:rgba(255,255,255,0.05);
      border:1px solid rgba(255,255,255,0.08);
      border-radius:8px;color:#e8eaf6;
      font-size:1rem;transition:all 0.25s;
      appearance:none;
      cursor:pointer;
    }
    select:focus {
      outline:none;border-color:#f7931e;
      box-shadow:0 0 0 3px rgba(247,147,30,0.25);
    }
    option { background:#0f1535; color:#fff; }
    .hidden { display:none !important; }
    .scan-btn {
      width:auto; padding:6px 12px; margin:0;
      font-size:0.8rem; background:rgba(255,255,255,0.1);
      box-shadow:none; float:right; border-radius:4px;
    }
    .scan-btn:hover { background:rgba(255,255,255,0.2); transform:none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📶</div>
    <h1>NAVIS SETUP</h1>
    <p>Select your WiFi network to connect Navis.</p>
    <form action="/setup" method="POST" id="setupForm">
      <div class="form-group">
        <label for="ssid_select">WiFi Network <button type="button" class="scan-btn" id="rescanBtn">Rescan</button></label>
        <select id="ssid_select">
          <option value="">Scanning networks...</option>
        </select>
        <input type="text" id="ssid" name="ssid" placeholder="Enter WiFi name" class="hidden" autocomplete="off">
      </div>
      <div class="form-group">
        <label for="pass">WiFi Password</label>
        <input type="password" id="pass" name="pass" placeholder="Your WiFi password" autocomplete="off">
      </div>
      <button type="submit">Save & Connect</button>
    </form>
    <div class="status" id="status"></div>
  </div>
  <script>
    const select = document.getElementById('ssid_select');
    const ssidInput = document.getElementById('ssid');
    const rescanBtn = document.getElementById('rescanBtn');
    const form = document.getElementById('setupForm');
    const status = document.getElementById('status');

    async function loadNetworks() {
      select.innerHTML = '<option value="">Scanning networks...</option>';
      rescanBtn.disabled = true;
      try {
        const res = await fetch('/scan');
        const networks = await res.json();
        select.innerHTML = '<option value="" disabled selected>Select a network</option>';
        if (networks.length === 0) {
            select.innerHTML += '<option value="" disabled>No networks found</option>';
        } else {
            networks.forEach(n => {
                select.innerHTML += `<option value="${n.ssid}">${n.ssid} (${n.rssi} dBm)</option>`;
            });
        }
        select.innerHTML += '<option value="__MANUAL__">Enter Manually...</option>';
      } catch (e) {
        select.innerHTML = '<option value="__MANUAL__">Scan failed. Enter Manually...</option>';
      }
      rescanBtn.disabled = false;
    }

    select.addEventListener('change', (e) => {
      if (e.target.value === '__MANUAL__') {
        ssidInput.classList.remove('hidden');
        ssidInput.required = true;
        ssidInput.value = '';
        ssidInput.focus();
      } else {
        ssidInput.classList.add('hidden');
        ssidInput.required = false;
        ssidInput.value = e.target.value;
      }
    });

    rescanBtn.addEventListener('click', loadNetworks);

    form.addEventListener('submit', (e) => {
      if (select.value === '' || (select.value === '__MANUAL__' && !ssidInput.value.trim())) {
        e.preventDefault();
        status.textContent = 'Please select or enter a WiFi network.';
        status.className = 'status error';
        return;
      }
      if (select.value !== '__MANUAL__') {
        ssidInput.value = select.value;
      }
    });

    loadNetworks();
  </script>
</body>
</html>
)rawliteral";

const char PORTAL_SUCCESS_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Navis — WiFi Saved</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      font-family:'Segoe UI',system-ui,sans-serif;
      background:linear-gradient(145deg,#080b1a,#0f1535,#1a1040);
      color:#e8eaf6;min-height:100vh;
      display:flex;align-items:center;justify-content:center;
      padding:20px;
    }
    .card{
      background:rgba(255,255,255,0.04);
      border:1px solid rgba(255,255,255,0.08);
      border-radius:14px;padding:40px;
      max-width:420px;width:100%;
      box-shadow:0 20px 60px rgba(0,0,0,0.5);
      text-align:center;
    }
    h1{color:#34d399;font-size:1.5rem;margin-bottom:12px}
    p{color:rgba(255,255,255,0.6);font-size:0.95rem;line-height:1.6}
    .icon{font-size:3.5rem;margin-bottom:16px}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>WiFi Credentials Saved!</h1>
    <p>Navis will restart and connect to your WiFi network.<br>
    Please reconnect your phone to your home WiFi, then open the Navis app.</p>
  </div>
</body>
</html>
)rawliteral";

// ══════════════════════════════════════════════════════════════
//  SERVO STATE MANAGEMENT (unchanged)
// ══════════════════════════════════════════════════════════════

void applyState(int eyes, int speaking) {
  if (speaking != lastSpeaking) {
    if (speaking == 1) {
      talkStartTime = millis();
    } else {
      mouthServo.write(MOUTH_CLOSED);
    }
    lastSpeaking = speaking;
  }
  if (eyes != lastEyes) {
    eyesServo.write(eyes ? EYES_OPEN : EYES_CLOSED);
    lastEyes = eyes;
  }
}

void resetServos() {
  mouthServo.write(MOUTH_CLOSED);
  eyesServo.write(EYES_OPEN);
  lastEyes = 1;
  lastSpeaking = 0;
}

int parseField(const String &str, int fieldIndex) {
  int commaCount = 0;
  int start = 0;
  for (int i = 0; i <= str.length(); i++) {
    if (i == str.length() || str[i] == ',') {
      if (commaCount == fieldIndex) {
        return str.substring(start, i).toInt();
      }
      commaCount++;
      start = i + 1;
    }
  }
  return -1;
}

// ══════════════════════════════════════════════════════════════
//  WEBSOCKET EVENT HANDLER (unchanged)
// ══════════════════════════════════════════════════════════════

void webSocketEvent(uint8_t num, WStype_t type, uint8_t *payload,
                    size_t length) {
  switch (type) {
  case WStype_DISCONNECTED:
    Serial.printf("[%u] Disconnected!\n", num);
    break;
  case WStype_CONNECTED: {
    IPAddress ip = webSocket.remoteIP(num);
    Serial.printf("[%u] Connected from %d.%d.%d.%d\n", num, ip[0], ip[1], ip[2],
                  ip[3]);
    wsConnected = true;
    digitalWrite(PIN_LED, HIGH);
  } break;
  case WStype_TEXT: {
    String line = String((char *)payload);
    line.trim();
    Serial.printf("[%u] Received text: %s\n", num, line.c_str());

    int eyes = parseField(line, 0);
    int speaking = parseField(line, 1);

    if ((eyes == 0 || eyes == 1) && (speaking == 0 || speaking == 1)) {
      applyState(eyes, speaking);
      lastPacketTime = millis();
      if (!wsConnected) {
        wsConnected = true;
        digitalWrite(PIN_LED, HIGH);
      }
    }
  } break;
  case WStype_BIN:
  case WStype_ERROR:
  case WStype_FRAGMENT_TEXT_START:
  case WStype_FRAGMENT_BIN_START:
  case WStype_FRAGMENT:
  case WStype_FRAGMENT_FIN:
    break;
  }
}

// ══════════════════════════════════════════════════════════════
//  NVS CREDENTIAL MANAGEMENT
// ══════════════════════════════════════════════════════════════

void loadCredentials() {
  preferences.begin("wifi", true); // read-only
  savedSSID = preferences.getString("ssid", "");
  savedPassword = preferences.getString("pass", "");
  preferences.end();

  if (savedSSID.length() > 0) {
    Serial.printf("Loaded saved WiFi: %s\n", savedSSID.c_str());
  } else {
    Serial.println("No saved WiFi credentials found.");
  }
}

void saveCredentials(const String &ssid, const String &pass) {
  preferences.begin("wifi", false); // read-write
  preferences.putString("ssid", ssid);
  preferences.putString("pass", pass);
  preferences.end();
  Serial.printf("Saved WiFi credentials for: %s\n", ssid.c_str());
}

void clearCredentials() {
  preferences.begin("wifi", false);
  preferences.clear();
  preferences.end();
  Serial.println("WiFi credentials cleared.");
}

// ══════════════════════════════════════════════════════════════
//  AP MODE — CAPTIVE PORTAL
// ══════════════════════════════════════════════════════════════

void startAPMode() {
  isAPMode = true;

  WiFi.disconnect(true, true); // Disconnect and erase STA config
  delay(100);
  WiFi.mode(WIFI_AP);
  delay(100);

  IPAddress apIP(192, 168, 4, 1);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
  WiFi.softAP(AP_SSID); // Open network
  delay(200);

  Serial.println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  Serial.println("  AP MODE ACTIVE");
  Serial.printf("  SSID: %s\n", AP_SSID);
  Serial.printf("  Portal: http://%s\n", WiFi.softAPIP().toString().c_str());
  Serial.println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // DNS server — redirect ALL domains to the captive portal
  dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
  dnsServer.start(53, "*", apIP);

  // Serve the captive portal page
  httpServer.on("/", HTTP_GET,
                []() { httpServer.send_P(200, "text/html", PORTAL_HTML); });

  // WiFi Scanning endpoint
  httpServer.on("/scan", HTTP_GET, []() {
    Serial.println("Starting WiFi scan...");
    int n = WiFi.scanNetworks(false, true); // sync scan, show hidden

    String json = "[";
    for (int i = 0; i < n; ++i) {
      if (i > 0)
        json += ",";
      json += "{";
      json += "\"ssid\":\"" + WiFi.SSID(i) + "\",";
      json += "\"rssi\":" + String(WiFi.RSSI(i));
      json += "}";
    }
    json += "]";

    httpServer.sendHeader("Access-Control-Allow-Origin", "*");
    httpServer.send(200, "application/json", json);
    Serial.printf("Scan complete: found %d networks\n", n);
  });

  // Handle form submission
  httpServer.on("/setup", HTTP_POST, []() {
    String ssid = httpServer.arg("ssid");
    String pass = httpServer.arg("pass");

    if (ssid.length() == 0) {
      httpServer.send(400, "text/plain", "SSID cannot be empty");
      return;
    }

    saveCredentials(ssid, pass);
    httpServer.send_P(200, "text/html", PORTAL_SUCCESS_HTML);

    Serial.println("Credentials received. Restarting in 2 seconds...");
    delay(2000);
    ESP.restart();
  });

  // Handle API-based setup (from the Navis mobile app)
  httpServer.on("/setup", HTTP_GET, []() {
    String ssid = httpServer.arg("ssid");
    String pass = httpServer.arg("pass");

    if (ssid.length() == 0) {
      httpServer.send(400, "application/json", "{\"error\":\"SSID required\"}");
      return;
    }

    saveCredentials(ssid, pass);
    httpServer.send(
        200, "application/json",
        "{\"success\":true,\"message\":\"Credentials saved. Restarting...\"}");

    delay(2000);
    ESP.restart();
  });

  // Captive portal detection endpoints (Android/iOS auto-detect)
  httpServer.on("/generate_204", HTTP_GET, []() {
    httpServer.sendHeader("Location", "http://192.168.4.1/");
    httpServer.send(302, "text/plain", "");
  });
  httpServer.on("/hotspot-detect.html", HTTP_GET, []() {
    httpServer.sendHeader("Location", "http://192.168.4.1/");
    httpServer.send(302, "text/plain", "");
  });
  httpServer.on("/connecttest.txt", HTTP_GET, []() {
    httpServer.sendHeader("Location", "http://192.168.4.1/");
    httpServer.send(302, "text/plain", "");
  });
  httpServer.on("/ncsi.txt", HTTP_GET, []() {
    httpServer.sendHeader("Location", "http://192.168.4.1/");
    httpServer.send(302, "text/plain", "");
  });

  // Catch-all: redirect everything to the portal
  httpServer.onNotFound([]() {
    httpServer.sendHeader("Location", "http://192.168.4.1/");
    httpServer.send(302, "text/plain", "");
  });

  httpServer.begin();
  Serial.println("Captive portal HTTP server started.");
}

// ══════════════════════════════════════════════════════════════
//  STA MODE — NORMAL OPERATION
// ══════════════════════════════════════════════════════════════

bool connectToWiFi() {
  Serial.printf("Connecting to WiFi: %s", savedSSID.c_str());

  WiFi.mode(WIFI_STA);
  WiFi.begin(savedSSID.c_str(), savedPassword.c_str());

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED &&
         millis() - startAttempt < STA_CONNECT_TIMEOUT) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    Serial.println("  CONNECTED TO WIFI");
    Serial.printf("  SSID: %s\n", savedSSID.c_str());
    Serial.printf("  IP:   %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("  RSSI: %d dBm\n", WiFi.RSSI());
    Serial.println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    return true;
  }

  Serial.println("\nFailed to connect to WiFi.");
  return false;
}

void startSTAMode() {
  isAPMode = false;

  // ── mDNS: register as "navis.local" for auto-discovery ──────
  if (MDNS.begin("navis")) {
    MDNS.addService("http", "tcp", 80);
    MDNS.addService("ws", "tcp", 81);
    Serial.println("mDNS started: http://navis.local");
  } else {
    Serial.println("mDNS failed to start");
  }

  // Start WebSocket server
  webSocket.begin();
  webSocket.onEvent(webSocketEvent);
  Serial.println("WebSocket server started on port 81");

  // Start HTTP server for utility endpoints

  // Lightweight discovery endpoint — app pings this to find the ESP32
  httpServer.on("/discover", HTTP_GET, []() {
    String json = "{";
    json += "\"device\":\"navis\",";
    json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
    json += "\"ws_port\":81,";
    json += "\"rssi\":" + String(WiFi.RSSI());
    json += "}";
    httpServer.sendHeader("Access-Control-Allow-Origin", "*");
    httpServer.send(200, "application/json", json);
  });

  httpServer.on("/wifi-status", HTTP_GET, []() {
    String json = "{";
    json += "\"ssid\":\"" + savedSSID + "\",";
    json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
    json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
    json += "\"mode\":\"STA\"";
    json += "}";
    httpServer.sendHeader("Access-Control-Allow-Origin", "*");
    httpServer.send(200, "application/json", json);
  });

  httpServer.on("/wifi-reset", HTTP_GET, []() {
    httpServer.sendHeader("Access-Control-Allow-Origin", "*");
    httpServer.send(200, "application/json",
                    "{\"success\":true,\"message\":\"Credentials cleared. "
                    "Restarting into AP mode...\"}");
    Serial.println("WiFi reset requested. Clearing credentials...");
    delay(500);
    clearCredentials();
    delay(500);
    ESP.restart();
  });

  httpServer.on("/wifi-reset", HTTP_POST, []() {
    httpServer.sendHeader("Access-Control-Allow-Origin", "*");
    httpServer.send(200, "application/json",
                    "{\"success\":true,\"message\":\"Credentials cleared. "
                    "Restarting into AP mode...\"}");
    Serial.println("WiFi reset requested (POST). Clearing credentials...");
    delay(500);
    clearCredentials();
    delay(500);
    ESP.restart();
  });

  httpServer.onNotFound([]() {
    httpServer.sendHeader("Access-Control-Allow-Origin", "*");
    httpServer.send(404, "text/plain", "Route not found");
  });

  httpServer.begin();
  Serial.println("HTTP server started on port 80");

  // Solid LED = connected
  digitalWrite(PIN_LED, HIGH);
}

// ══════════════════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);

  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);

  mouthServo.attach(PIN_MOUTH, 500, 2400);
  eyesServo.attach(PIN_EYES, 500, 2400);
  resetServos();

  // Load saved WiFi credentials from NVS
  loadCredentials();

  if (savedSSID.length() > 0) {
    // Try connecting to saved WiFi
    if (connectToWiFi()) {
      startSTAMode();
    } else {
      // Saved creds failed — fall back to AP mode
      Serial.println("Saved WiFi credentials failed. Starting AP mode...");
      startAPMode();
    }
  } else {
    // No saved credentials — start AP mode
    startAPMode();
  }

  Serial.println("NAVIS ESP32 Ready.");
}

// ══════════════════════════════════════════════════════════════
//  LOOP
// ══════════════════════════════════════════════════════════════

void loop() {
  httpServer.handleClient();

  if (isAPMode) {
    // DNS server for captive portal redirect
    dnsServer.processNextRequest();

    // Blink LED in AP mode (500ms interval)
    if (millis() - lastLedBlink > 500) {
      lastLedBlink = millis();
      ledState = !ledState;
      digitalWrite(PIN_LED, ledState ? HIGH : LOW);
    }
    return; // Skip WebSocket + servo logic in AP mode
  }

  // ── STA MODE: Normal operation ──────────────────────────────
  webSocket.loop();

  if (wsConnected && (millis() - lastPacketTime > TIMEOUT_MS)) {
    wsConnected = false;
    digitalWrite(PIN_LED, LOW);
    resetServos();
    Serial.println("📡 Timeout: No commands received. Resetting to idle.");
  }

  // ── Mouth Animation Logic ─────────────────────────────────────
  if (lastSpeaking == 1) {
    if (millis() - lastMouthUpdate > 200) { // Toggle every 200ms
      lastMouthUpdate = millis();
      mouthIsOpen = !mouthIsOpen;
      mouthServo.write(mouthIsOpen ? MOUTH_OPEN : MOUTH_CLOSED);
    }
  }
}