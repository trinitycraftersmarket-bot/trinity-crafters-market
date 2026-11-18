package com.trinitylutzmarkets.app;

import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  // §78 (Nov 18, 2026): window.print() is a no-op inside an Android
  // WebView, so every Print button in the web app silently did nothing
  // in the app. The web Print buttons now call this bridge when it
  // exists (and fall back to window.print() in a real browser). The
  // print adapter renders the WebView's current page, so the print
  // documents' @media print CSS (controls hidden, light canvas)
  // applies exactly as it would on paper.
  public class TrinityPrintBridge {
    @JavascriptInterface
    public void print() {
      runOnUiThread(() -> {
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        PrintManager pm = (PrintManager) getSystemService(PRINT_SERVICE);
        if (pm == null) return;
        String job = "Trinity Crafter's Market";
        pm.print(job, webView.createPrintDocumentAdapter(job), new PrintAttributes.Builder().build());
      });
    }
  }

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    WebView webView = getBridge().getWebView();
    if (webView != null) {
      webView.addJavascriptInterface(new TrinityPrintBridge(), "TrinityPrint");
    }
  }
}
