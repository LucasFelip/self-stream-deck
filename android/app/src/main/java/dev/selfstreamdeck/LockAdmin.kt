package dev.selfstreamdeck

import android.app.admin.DeviceAdminReceiver

/**
 * The device administrator role, asked for only to lock the screen (res/xml/device_admin.xml: `force-lock` and nothing else).
 * The person turns it on once, in the system's own dialog, from the "Bloquear tela" button; it can be turned off in the phone's
 * settings (Security → Device admin apps), and has to be before the app is uninstalled.
 */
class LockAdmin : DeviceAdminReceiver()
