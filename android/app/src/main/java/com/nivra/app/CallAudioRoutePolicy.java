package com.nivra.app;

import java.util.List;

/** Pure route preference; a user's still-connected choice always wins. */
final class CallAudioRoutePolicy {
    static final class Route {
        final String id;
        final String kind;
        final String label;
        Route(String id, String kind, String label) { this.id = id; this.kind = kind; this.label = label; }
    }

    static String choose(List<Route> routes, boolean video, String userChoice, String unavailable) {
        if (userChoice != null && !userChoice.isEmpty()) {
            for (Route route : routes) if (route.id.equals(userChoice)) return route.id;
        }
        String[] order = video ? new String[] { "wired", "usb", "bluetooth", "speaker", "earpiece" }
            : new String[] { "wired", "usb", "bluetooth", "earpiece", "speaker" };
        for (String kind : order) {
            for (Route route : routes) if (kind.equals(route.kind) && !route.id.equals(unavailable)) return route.id;
        }
        return "";
    }
}
