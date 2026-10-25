package com.nivra.app;

import android.media.AudioDeviceInfo;
import org.junit.Test;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import static org.junit.Assert.*;

public class CallAudioRoutePolicyTest {
    private final CallAudioRoutePolicy.Route ear = route("ear", "earpiece");
    private final CallAudioRoutePolicy.Route speaker = route("speaker", "speaker");
    private final CallAudioRoutePolicy.Route bluetooth = route("bt", "bluetooth");
    private final CallAudioRoutePolicy.Route cable = route("cable", "wired");
    private final CallAudioRoutePolicy.Route usb = route("usb", "usb");

    @Test public void voicePrefersHandsetAndVideoPrefersSpeakerWithoutExternalDevices() {
        List<CallAudioRoutePolicy.Route> routes = Arrays.asList(speaker, ear);
        assertEquals("ear", CallAudioRoutePolicy.choose(routes, false, "", ""));
        assertEquals("speaker", CallAudioRoutePolicy.choose(routes, true, "", ""));
    }

    @Test public void connectedHeadsetWinsAutomaticVoiceAndVideoSelection() {
        List<CallAudioRoutePolicy.Route> routes = Arrays.asList(speaker, bluetooth, ear);
        assertEquals("bt", CallAudioRoutePolicy.choose(routes, false, "", ""));
        assertEquals("bt", CallAudioRoutePolicy.choose(routes, true, "", ""));
    }

    @Test public void explicitConnectedChoiceSurvivesHeadsetConnectionAndVideoUpgrade() {
        List<CallAudioRoutePolicy.Route> routes = Arrays.asList(ear, speaker, bluetooth, cable);
        assertEquals("speaker", CallAudioRoutePolicy.choose(routes, false, "speaker", ""));
        assertEquals("ear", CallAudioRoutePolicy.choose(routes, true, "ear", ""));
    }

    @Test public void unpluggedChoiceFallsBackToAnotherExternalDeviceThenCorrectLocalRoute() {
        assertEquals("bt", CallAudioRoutePolicy.choose(Arrays.asList(ear, speaker, bluetooth), false, "cable", ""));
        assertEquals("ear", CallAudioRoutePolicy.choose(Arrays.asList(ear, speaker), false, "bt", ""));
        assertEquals("speaker", CallAudioRoutePolicy.choose(Arrays.asList(ear, speaker), true, "bt", ""));
    }

    @Test public void wireAndUsbTakeAutomaticPriorityOverBluetooth() {
        assertEquals("cable", CallAudioRoutePolicy.choose(Arrays.asList(speaker, bluetooth, usb, cable), true, "", ""));
        assertEquals("usb", CallAudioRoutePolicy.choose(Arrays.asList(speaker, bluetooth, usb), false, "", ""));
    }

    @Test public void timedOutBluetoothDoesNotCauseAnAutomaticRetryLoop() {
        assertEquals("ear", CallAudioRoutePolicy.choose(Arrays.asList(ear, speaker, bluetooth), false, "", "bt"));
        assertEquals("", CallAudioRoutePolicy.choose(Collections.emptyList(), true, "missing", ""));
    }

    @Test public void a2dpAndUnrelatedOutputsAreNeverAdvertisedAsCommunicationDevices() {
        assertEquals("", NivraCallAudio.kind(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP));
        assertEquals("", NivraCallAudio.kind(AudioDeviceInfo.TYPE_HDMI));
        assertEquals("bluetooth", NivraCallAudio.kind(AudioDeviceInfo.TYPE_BLE_HEADSET));
        assertEquals("bluetooth", NivraCallAudio.kind(AudioDeviceInfo.TYPE_BLUETOOTH_SCO));
        assertEquals("wired", NivraCallAudio.kind(AudioDeviceInfo.TYPE_WIRED_HEADPHONES));
        assertEquals("usb", NivraCallAudio.kind(AudioDeviceInfo.TYPE_USB_HEADSET));
    }

    private static CallAudioRoutePolicy.Route route(String id, String kind) { return new CallAudioRoutePolicy.Route(id, kind, id); }
}
