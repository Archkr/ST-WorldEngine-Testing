import { eventSource } from '/script.js';

export const EXTENSION_NAME = 'world-engine';
export const DEFAULT_SETTINGS = {
    movementSpeed: 1.0,
    invertLook: false,
    showInstructions: true,
};

const EXTENSION_BASE_URL = new URL('.', import.meta.url);
export const VIEW_URL = new URL('./Resources/world-engine/index.html', EXTENSION_BASE_URL).toString();

export function ensureSettings(extensionSettings) {
    extensionSettings[EXTENSION_NAME] = Object.assign({}, DEFAULT_SETTINGS, extensionSettings[EXTENSION_NAME]);
    return extensionSettings[EXTENSION_NAME];
}

export function buildViewUrl(settings) {
    const url = new URL(VIEW_URL);
    url.searchParams.set('moveSpeed', String(settings.movementSpeed ?? DEFAULT_SETTINGS.movementSpeed));
    url.searchParams.set('invertLook', String(Boolean(settings.invertLook ?? DEFAULT_SETTINGS.invertLook)));
    url.searchParams.set('showInstructions', String(Boolean(settings.showInstructions ?? DEFAULT_SETTINGS.showInstructions)));
    return url.toString();
}

export async function persistSettings(saveSettingsFn = window?.saveSettingsDebounced) {
    const tryPersist = async (label, fn) => {
        if (typeof fn !== 'function') {
            return false;
        }

        try {
            await fn.call(window);
            return true;
        } catch (error) {
            console.warn(`[World Engine] Failed to persist settings via ${label}.`, error);
            return false;
        }
    };

    if (await tryPersist('provided saveSettingsFn', saveSettingsFn)) {
        return true;
    }

    if (await tryPersist('window.saveSettings', window?.saveSettings)) {
        return true;
    }

    if (eventSource?.emit) {
        eventSource.emit('settingsSaved', {
            source: EXTENSION_NAME,
            settings: window?.extension_settings?.[EXTENSION_NAME] ?? null,
        });
        return true;
    }

    console.warn('[World Engine] No available persistence mechanism for settings.');
    return false;
}

export function sendSettingsToFrame(frame, settings) {
    if (!frame?.postMessage) return;
    frame.postMessage({
        source: EXTENSION_NAME,
        type: 'world-engine-settings',
        payload: settings,
    }, '*');
}
