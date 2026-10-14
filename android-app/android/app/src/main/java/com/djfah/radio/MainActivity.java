package com.djfah.radio;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RadioPlayerPlugin.class);
        super.onCreate(savedInstanceState);
        // «Πίσω»: η εφαρμογή γυρίζει στην προηγούμενη οθόνη της. Στην αρχική πάει στο παρασκήνιο
        // (δεν κλείνει), ώστε η μουσική να συνεχίζει και η οθόνη να μένει όπως ήταν.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() == null || getBridge().getWebView() == null) {
                    moveTaskToBack(true);
                    return;
                }
                getBridge().getWebView().evaluateJavascript(
                        "(window.djfahBack ? window.djfahBack() : 'exit')",
                        value -> {
                            if (value == null || value.contains("exit")) moveTaskToBack(true);
                        });
            }
        });
    }
}
