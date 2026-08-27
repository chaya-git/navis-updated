package com.robomanthan.navis;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        WebSettings settings = webView.getSettings();

        // Core JS support
        settings.setJavaScriptEnabled(true);

        // Allow ws:// from file:// context (needed for ESP32 WebSocket)
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // Allow TTS / audio autoplay without user gesture
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Enable localStorage
        settings.setDomStorageEnabled(true);

        // Allow loading files from assets
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        // Grant microphone permission to WebView automatically
        // This allows SpeechRecognition (Web Speech API) to work
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Grant all WebView permission requests (mic, camera, etc.)
                request.grant(request.getResources());
            }
        });

        webView.setWebViewClient(new WebViewClient());

        // Load the app from bundled assets
        webView.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }
}
