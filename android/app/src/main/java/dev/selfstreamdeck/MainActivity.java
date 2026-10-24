package dev.selfstreamdeck;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * Thin shell around the web UI served by the PC (server/). All the deck logic lives on the
 * server; this app only stores the pairing addresses, keeps the screen on and renders the page.
 *
 * It knows up to two addresses for the same PC: the USB tunnel (http://127.0.0.1:PORT, tried first because it fails at once
 * when no cable is plugged in) and the home network (https://IP:PORT). The home-network server uses a self-signed
 * certificate: the app trusts it only when its SHA-256 fingerprint is the one it was paired with.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "deck";
    private static final String KEY_URL = "url";   // this PC / USB tunnel
    private static final String KEY_WIFI = "wifi"; // home network (https)
    private static final String KEY_FP = "fp";     // the certificate's SHA-256, lower-case hex
    private static final int USB_PORT = 7878;
    private static final int REQUEST_CAMERA = 7;
    private static final int BACKGROUND = Color.parseColor("#0E0F13");

    private SharedPreferences prefs;
    private WebView web;
    private boolean showingSetup;
    private PermissionRequest pendingCamera; // a page asked for the camera while the system permission was still unknown

    private List<String> candidates = new ArrayList<>();
    private int candidateIndex;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        savePairingFromIntent(getIntent());

        if (buildCandidates().isEmpty()) showSetup();
        else showDeck();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (savePairingFromIntent(intent)) showDeck();
    }

    /**
     * The PC can pair the app over adb:
     * am start -n dev.selfstreamdeck/.MainActivity --es url "http://127.0.0.1:7878/?token=…" --es wifi "https://IP:7879/?token=…&fp=…"
     */
    private boolean savePairingFromIntent(Intent intent) {
        if (intent == null) return false;
        String url = normalize(intent.getStringExtra(KEY_URL));
        String wifi = normalize(intent.getStringExtra(KEY_WIFI));
        if (url == null && wifi == null) return false;
        savePairing(url, wifi);
        return true;
    }

    private void savePairing(String url, String wifi) {
        SharedPreferences.Editor editor = prefs.edit();
        if (url != null) editor.putString(KEY_URL, url);
        if (wifi != null) {
            editor.putString(KEY_WIFI, wifi);
            String fingerprint = Uri.parse(wifi).getQueryParameter("fp");
            if (fingerprint != null) editor.putString(KEY_FP, fingerprint.toLowerCase());
        }
        editor.apply();
    }

    /** The addresses to try, in order: this PC / USB first, then the home network. */
    private List<String> buildCandidates() {
        List<String> list = new ArrayList<>();
        String url = prefs.getString(KEY_URL, null);
        String wifi = prefs.getString(KEY_WIFI, null);
        if (url != null) {
            list.add(url);
        } else if (wifi != null) {
            String token = Uri.parse(wifi).getQueryParameter("token");
            if (token != null) list.add("http://127.0.0.1:" + USB_PORT + "/?token=" + token);
        }
        if (wifi != null) list.add(wifi);
        return list;
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // The app never closes on Back: a stray press must not drop the deck. On the setup screen it returns to the deck
        // (if an address is saved); on the deck it asks the page to step back (close a sheet, the menu, an overlay, or go to
        // Apps). The page answers "true"/"false"; either way there is nothing more to do here, and an old page without
        // Deck.back() just raises an error that evaluateJavascript hands to the callback.
        if (showingSetup) {
            if (!buildCandidates().isEmpty()) showDeck();
            return;
        }
        if (web != null) web.evaluateJavascript("Deck.back()", value -> { });
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    // --- deck -----------------------------------------------------------------

    private void showDeck() {
        showingSetup = false;
        destroyWebView();
        candidates = buildCandidates();
        candidateIndex = 0;

        web = new WebView(this);
        web.setBackgroundColor(BACKGROUND);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                // this address did not answer: try the next one before giving up
                if (candidateIndex + 1 < candidates.size()) {
                    candidateIndex += 1;
                    web.loadUrl(candidates.get(candidateIndex));
                } else {
                    showLoadError();
                }
            }

            // The home-network server's certificate is self-signed: accept it only if it is exactly the one paired with.
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                if (matchesPinnedCertificate(error.getCertificate())) handler.proceed();
                else handler.cancel();
            }
        });

        // The page can use the phone camera (the deck turns it into the PC's webcam), but only the paired PC's page.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> answerCameraRequest(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingCamera == request) pendingCamera = null;
            }
        });

        setContentView(web);
        web.loadUrl(candidates.get(0));
        hideSystemBars();
    }

    private boolean matchesPinnedCertificate(SslCertificate certificate) {
        String pinned = prefs.getString(KEY_FP, null);
        if (pinned == null || certificate == null) return false;
        try {
            // saveState keeps the DER bytes of the certificate under this key on every Android version
            byte[] der = SslCertificate.saveState(certificate).getByteArray("x509-certificate");
            if (der == null) return false;
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(der);
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) hex.append(String.format("%02x", b));
            return hex.toString().equals(pinned);
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isDeckOrigin(Uri origin) {
        if (origin == null || origin.getHost() == null) return false;
        for (String candidate : buildCandidates()) {
            Uri deck = Uri.parse(candidate);
            if (origin.getHost().equalsIgnoreCase(deck.getHost()) && origin.getPort() == deck.getPort()) return true;
        }
        return false;
    }

    private void answerCameraRequest(PermissionRequest request) {
        boolean wantsCamera = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) wantsCamera = true;
        }
        if (!wantsCamera || !isDeckOrigin(request.getOrigin())) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            pendingCamera = request;
            requestPermissions(new String[] {Manifest.permission.CAMERA}, REQUEST_CAMERA);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_CAMERA || pendingCamera == null) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) pendingCamera.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        else pendingCamera.deny();
        pendingCamera = null;
    }

    private void showLoadError() {
        String base = candidates.isEmpty() ? "about:blank" : candidates.get(0);
        String html = "<body style='background:#0e0f13;color:#eceef4;font-family:sans-serif;text-align:center;padding:48px 16px'>"
                + "<h2>Sem conexão com o PC</h2>"
                + "<p style='color:#8b90a0'>Confira se o servidor está rodando e se o celular está na mesma rede Wi-Fi (ou plugue o cabo USB).</p>"
                + "<p><button style='font-size:1.1rem;padding:12px 24px' onclick='Android.retry()'>Tentar de novo</button></p>"
                + "<p><button style='font-size:1.1rem;padding:12px 24px' onclick='Android.openSettings()'>Configurar endereço</button></p>"
                + "</body>";
        web.loadDataWithBaseURL(base, html, "text/html", "UTF-8", null);
    }

    private void destroyWebView() {
        if (web != null) {
            web.destroy();
            web = null;
        }
    }

    private class Bridge {
        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(MainActivity.this::showSetup);
        }

        /** Starts over from the first address (the error screen's "try again"). */
        @JavascriptInterface
        public void retry() {
            runOnUiThread(MainActivity.this::showDeck);
        }

        /** The page lost the PC for a while: try the other address (USB <-> Wi-Fi), if there is one. */
        @JavascriptInterface
        public void reconnect() {
            runOnUiThread(() -> {
                if (web == null || candidates.size() < 2) return;
                candidateIndex = (candidateIndex + 1) % candidates.size();
                web.loadUrl(candidates.get(candidateIndex));
            });
        }

        /** Idle dimmer for the AMOLED screen: window brightness to the minimum, or back to the system value. */
        @JavascriptInterface
        public void setDim(boolean on) {
            runOnUiThread(() -> {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.screenBrightness = on ? 0.01f : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
                getWindow().setAttributes(lp);
            });
        }

        /** Short haptic tick for button presses; the page calls it through Deck.vibrate(). */
        @JavascriptInterface
        @SuppressWarnings("deprecation")
        public void vibrate(int milliseconds) {
            Vibrator vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator == null || !vibrator.hasVibrator()) return;
            long duration = Math.max(1, Math.min(milliseconds, 500));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                vibrator.vibrate(duration);
            }
        }
    }

    // --- setup ----------------------------------------------------------------

    private void showSetup() {
        showingSetup = true;
        destroyWebView();

        int pad = dp(24);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(BACKGROUND);

        TextView title = new TextView(this);
        title.setText("Conectar ao PC");
        title.setTextColor(Color.WHITE);
        title.setTextSize(22);

        TextView hint = new TextView(this);
        hint.setText("Cole o endereço que o servidor mostra ao iniciar (npm run lan -- status):\nWi-Fi: https://IP:7879/?token=…&fp=…\nUSB: http://127.0.0.1:7878/?token=…");
        hint.setTextColor(Color.parseColor("#8B90A0"));
        hint.setPadding(0, dp(8), 0, dp(16));

        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.parseColor("#555A6B"));
        input.setHint("https://192.168.0.10:7879/?token=...&fp=...");
        String shown = prefs.getString(KEY_WIFI, prefs.getString(KEY_URL, ""));
        input.setText(shown);

        final TextView error = new TextView(this);
        error.setTextColor(Color.parseColor("#FF6B6B"));

        Button connect = new Button(this);
        connect.setText("Conectar");
        connect.setOnClickListener(v -> {
            String link = normalize(input.getText().toString());
            if (link == null) {
                error.setText("Endereço inválido. Use o formato https://IP:7879/?token=…&fp=… (Wi-Fi) ou http://127.0.0.1:7878/?token=… (USB)");
                return;
            }
            if (link.startsWith("https://")) {
                if (Uri.parse(link).getQueryParameter("fp") == null) {
                    error.setText("Faltou o &fp=… no endereço Wi-Fi: copie o link completo do servidor.");
                    return;
                }
                savePairing(null, link);
            } else {
                savePairing(link, null);
            }
            showDeck();
        });

        ViewGroup.LayoutParams wide = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        root.addView(title, wide);
        root.addView(hint, wide);
        root.addView(input, wide);
        root.addView(error, wide);
        root.addView(connect, wide);

        setContentView(root);
        hideSystemBars();
    }

    /** Accepts "ip:port/?token=x" without a scheme and rejects anything that is not http(s). */
    private static String normalize(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty()) return null;
        if (!value.contains("://")) value = "http://" + value;
        if (!value.startsWith("http://") && !value.startsWith("https://")) return null;
        return value;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
