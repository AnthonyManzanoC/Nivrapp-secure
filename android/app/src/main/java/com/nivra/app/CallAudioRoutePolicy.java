package com.nivra.app;

import java.util.List;
import java.util.Set;

/** Pure route preference; a user's still-connected choice always wins. */
final class CallAudioRoutePolicy {
    static final class Route {
        final String id;
        final String kind;
        final String label;
        Route(String id, String kind, String label) { this.id = id; this.kind = kind; this.label = label; }
    }

    static boolean includes(List<Route> routes, String routeId) {
        for (Route route : routes) if (route.id.equals(routeId)) return true;
        return false;
    }

    static String choose(List<Route> routes, boolean video, String userChoice, Set<String> unavailable) {
        if (includes(routes, userChoice) && !unavailable.contains(userChoice)) return userChoice;
        String[] order = video ? new String[] { "wired", "usb", "bluetooth", "speaker", "earpiece" }
            : new String[] { "wired", "usb", "bluetooth", "earpiece", "speaker" };
        for (String kind : order) {
            for (Route route : routes) if (kind.equals(route.kind) && !unavailable.contains(route.id)) return route.id;
        }
        return "";
    }
}
