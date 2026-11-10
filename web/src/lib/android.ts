/**
 * The bridge the Android shell injects into the page (android/, ADR 0005). Every member is optional: in a normal browser
 * (and on an iPhone) there is no `window.Android`, and an older APK lacks the newer members.
 */
export interface AndroidBridge {
  openSettings?: () => void;
  vibrate?: (ms: number) => void;
  reconnect?: () => void;
  setDim?: (on: boolean) => void;
  /** locks the phone (the first time Android asks to turn on the device administrator role); newer APKs only */
  lockScreen?: () => void;
}

declare global {
  interface Window {
    Android?: AndroidBridge;
    /** what MainActivity calls through evaluateJavascript (Back button); same name and meaning as in the old interface */
    Deck?: { back: () => boolean; vibrate?: (ms?: number) => void };
  }
}

export const android = (): AndroidBridge | undefined => window.Android;
