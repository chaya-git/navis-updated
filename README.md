# 🤖 Navis AI Assistant

Navis is a powerful, multi-lingual AI assistant developed by **Robo Manthan**. It combines cutting-edge Large Language Models (Groq AI) with native hardware control for real-time lip-sync and interaction.

## 🌟 Key Features

- **🧠 Brain powered by Groq**: Ultra-fast AI responses using Groq LPU™ technology.
- **🗣️ Multi-lingual Voice**: Full support for **English**, **Hindi**, and **Kannada** using the native Web Speech API.
- **👄 Hardware Lip-Sync**: Direct WebSocket connection to ESP32 for low-latency servo control (jaw movement).
- **📱 PWA & Native APK**: Installable as a Progressive Web App or a native Android application.
- **🔒 Privacy First**: API keys and connection settings are stored locally on your device (`localStorage`).

---

## 🚀 Getting the App

### 1. Progressive Web App (PWA)
Access the hosted version directly at:
**[https://karankpatel05-bit.github.io/navisapp/](https://karankpatel05-bit.github.io/navisapp/)**
*Note: Due to browser security policies, insecure WebSocket (`ws://`) connections to local ESP32 units are blocked on the HTTPS version. Use the Native APK for full hardware sync.*

### 2. Native Android APK (Recommended for Hardware)
This project uses GitHub Actions to automatically build a native Android APK on every push.
1. Go to the **[Actions](/../../actions)** tab of this repository.
2. Select the most recent successful workflow run.
3. Download the **Navis-Android-APK** from the *Artifacts* section at the bottom.
4. Extract the zip and install `app-debug.apk` on your phone.

---

## 🛠️ Setup & Configuration

### Groq API Key
1. Get a free API key from the [Groq Cloud Console](https://console.groq.com/keys).
2. Open the Navis app.
3. Enter your key in the **Groq API Key** field on the connection screen. It will be saved securely to your device's local storage.

### Hardware Connection (Optional)
Navis can control a physical robot via an ESP32:
1. Ensure your ESP32 is running the provided firmware in the `esp32_firmware/` directory.
2. Connect your phone to the same Wi-Fi network as the ESP32.
3. Enter the **ESP32 IP Address** on the connection screen.
4. Tap **Connect**.

---

## 🏗️ Technical Architecture

- **Frontend**: Vanilla HTML5, CSS3, and JavaScript.
- **TTS Engine**: native `window.speechSynthesis` (Web Speech API).
- **Communication**: WebSockets (Port 81) for direct hardware control.
- **Native Wrapper**: Android WebView project (located in the `android/` directory).

## 📄 License

Developed by **Robo Manthan Team**. All rights reserved.
[https://robomanthan.com](https://robomanthan.com)
