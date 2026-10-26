package com.nivra.app;

/** NoDisplay entries must hand off synchronously and never remain in a task. */
final class LauncherEntryPolicy {
    interface Host {
        void openMain();
        void finishEntry();
    }
    private LauncherEntryPolicy() { }
    static void enter(Host host) {
        try { host.openMain(); }
        finally { host.finishEntry(); }
    }
}
