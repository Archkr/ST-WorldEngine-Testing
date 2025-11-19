import { extension_settings, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { callGenericPopup, POPUP_TYPE } from '/scripts/popup.js';
import { eventSource, event_types } from '/script.js';
import { registerSillyTavernIntegration, unregisterSillyTavernIntegration } from './chat-integration.js';
import { buildViewUrl, DEFAULT_SETTINGS, ensureSettings, EXTENSION_NAME, persistSettings, sendSettingsToFrame } from './settings-utils.js';

const EXTENSION_BASE_URL = new URL('.', import.meta.url);
const SETTINGS_HTML_URL = new URL('./settings.html', EXTENSION_BASE_URL).toString();
const SETTINGS_ROOT_ID = 'world-engine-settings';
const CHAT_ROLE_USER = 'user';
const CHAT_ROLE_ASSISTANT = 'assistant';
const CHAT_SYNC_POLL_INTERVAL = 5000;
const CHAT_SYNC_HISTORY_LIMIT = 24;
const IFRAME_LOAD_TIMEOUT_MS = 10000;

const trackedFrameOrigins = new WeakMap();

let chatIntegrationHandle = null;
let chatPollTimer = null;

const chatSyncState = {
    lastSignature: null,
    streamingBuffer: '',
    streamingActive: false,
};

function getWorldEngineContext() {
    if (typeof window.getContext === 'function') {
        return window.getContext();
    }

    if (window?.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
        return window.SillyTavern.getContext();
    }

    return null;
}

function getWorldEngineFrames() {
    return Array.from(document.querySelectorAll('iframe.world-engine-iframe'))
        .map((iframe) => iframe?.contentWindow)
        .filter(Boolean);
}

function trackWorldEngineFrame(iframe) {
    if (!iframe || !(iframe instanceof HTMLIFrameElement)) {
        return;
    }

    const frameWindow = iframe.contentWindow;
    if (!frameWindow) {
        return;
    }

    const src = iframe.getAttribute('src') || iframe.src || '';
    let origin = null;
    if (src) {
        try {
            origin = new URL(src, window.location.href).origin;
        } catch (error) {
            console.warn('[World Engine] Failed to resolve iframe origin.', error);
        }
    }

    trackedFrameOrigins.set(frameWindow, {
        origin,
        iframe,
    });
}

function broadcastChatPayload(payload, targetFrame = null) {
    const frames = targetFrame ? [targetFrame] : getWorldEngineFrames();
    frames.forEach((frame) => {
        try {
            frame.postMessage({
                source: EXTENSION_NAME,
                type: 'world-engine-chat',
                payload,
            }, '*');
        } catch (error) {
            console.warn('[World Engine] Failed to deliver chat payload to frame.', error);
        }
    });
}

function normalizeChatMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const text = typeof message.mes === 'string' ? message.mes.trim() : '';
    if (!text) return null;
    const signature = `${message.mesId ?? message.id ?? message.key ?? ''}:${text}`;
    return {
        text,
        signature,
        role: message.is_user ? CHAT_ROLE_USER : CHAT_ROLE_ASSISTANT,
    };
}

function getLatestAssistantEntry() {
    const ctx = getWorldEngineContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const startIndex = Math.max(0, chat.length - CHAT_SYNC_HISTORY_LIMIT * 2);

    for (let i = chat.length - 1; i >= startIndex; i--) {
        const normalized = normalizeChatMessage(chat[i]);
        if (normalized?.role === CHAT_ROLE_ASSISTANT) {
            return normalized;
        }
    }

    return null;
}

function refreshLastSignatureFromHistory() {
    const latestAssistantEntry = getLatestAssistantEntry();
    const latestSignature = latestAssistantEntry?.signature ?? null;

    if (latestSignature === chatSyncState.lastSignature) {
        return latestSignature;
    }

    chatSyncState.lastSignature = latestSignature;
    return latestSignature;
}

function syncChatHistory(targetFrame = null) {
    const latestAssistantEntry = getLatestAssistantEntry();
    const newestSignature = latestAssistantEntry?.signature ?? null;

    if (newestSignature === chatSyncState.lastSignature) {
        console.debug('[World Engine] Skipping chat sync; signature unchanged.', newestSignature);
        return;
    }

    chatSyncState.lastSignature = newestSignature;

    const history = latestAssistantEntry ? [{ text: latestAssistantEntry.text, role: latestAssistantEntry.role }] : [];

    console.debug('[World Engine] Broadcasting chat history update.', {
        signature: newestSignature,
        entries: history.length,
    });

    broadcastChatPayload({
        history,
        direction: 'incoming',
        signature: chatSyncState.lastSignature,
    }, targetFrame);
}

function resetChatSyncState() {
    chatSyncState.lastSignature = null;
    chatSyncState.streamingBuffer = '';
    chatSyncState.streamingActive = false;
}

function handleStreamStart() {
    chatSyncState.streamingActive = true;
    chatSyncState.streamingBuffer = '';
}

function resolveTokenText(args = []) {
    if (!args.length) return '';
    if (typeof args[0] === 'number') {
        return String(args[1] ?? '');
    }
    if (typeof args[0] === 'object') {
        return String(args[0]?.token ?? args[0]?.text ?? '');
    }
    return String(args.join(' ') || '');
}

function handleStreamToken(...args) {
    if (!chatSyncState.streamingActive) return;
    const tokenText = resolveTokenText(args);
    if (!tokenText) return;
    chatSyncState.streamingBuffer += tokenText;
    refreshLastSignatureFromHistory();
    broadcastChatPayload({
        text: chatSyncState.streamingBuffer,
        role: CHAT_ROLE_ASSISTANT,
        direction: 'incoming',
        signature: chatSyncState.lastSignature,
    });
}

function handleMessageFinished() {
    if (chatSyncState.streamingBuffer) {
        broadcastChatPayload({
            text: chatSyncState.streamingBuffer,
            role: CHAT_ROLE_ASSISTANT,
            direction: 'incoming',
            signature: chatSyncState.lastSignature,
        });
    }
    chatSyncState.streamingActive = false;
    chatSyncState.streamingBuffer = '';
    syncChatHistory();
}

function pushMessageToSillyTavern(text) {
    if (!text) return;

    if (typeof window.send_message === 'function') {
        window.send_message(text);
        return;
    }

    if (window?.SillyTavern && typeof window.SillyTavern.sendMessage === 'function') {
        window.SillyTavern.sendMessage(text);
        return;
    }

    const textarea = document.querySelector('#send_textarea') || document.querySelector('textarea[name="send_textarea"]');
    if (textarea) {
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const sendButton = document.querySelector('#send_but') || document.querySelector('#send_button') || document.querySelector('[data-send-button]');
    if (sendButton) {
        sendButton.click();
        return;
    }

    const form = document.querySelector('#send_form') || textarea?.closest('form');
    if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
}

function handleFrameChatMessage(event) {
    const { data } = event || {};
    if (!data || data.source !== EXTENSION_NAME || data.type !== 'world-engine-chat') return;

    const frameInfo = event?.source ? trackedFrameOrigins.get(event.source) : null;
    if (!frameInfo) {
        console.warn('[World Engine] Ignoring chat payload from untracked frame.', {
            origin: event?.origin,
        });
        return;
    }

    if (frameInfo.origin && event?.origin && frameInfo.origin !== event.origin) {
        console.warn('[World Engine] Ignoring chat payload from unexpected origin.', {
            expected: frameInfo.origin,
            received: event.origin,
        });
        return;
    }

    const payload = data.payload || {};
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text || payload.direction !== 'outgoing') return;

    pushMessageToSillyTavern(text);
}

function initializeChatIntegration() {
    if (chatIntegrationHandle) return;

    window.addEventListener('message', handleFrameChatMessage, false);
    chatIntegrationHandle = registerSillyTavernIntegration({
        eventSource,
        eventTypes: event_types,
        onGenerationStarted: handleStreamStart,
        onStreamStarted: handleStreamStart,
        onStreamToken: handleStreamToken,
        onMessageFinished: handleMessageFinished,
        onChatChanged: syncChatHistory,
        onHistoryChanged: () => {
            resetChatSyncState();
            syncChatHistory();
        },
    });

    if (chatPollTimer) {
        clearInterval(chatPollTimer);
    }
    chatPollTimer = window.setInterval(syncChatHistory, CHAT_SYNC_POLL_INTERVAL);
    syncChatHistory();
}

function teardownChatIntegration() {
    if (chatPollTimer) {
        clearInterval(chatPollTimer);
        chatPollTimer = null;
    }

    if (chatIntegrationHandle) {
        unregisterSillyTavernIntegration(chatIntegrationHandle, { eventSource });
        chatIntegrationHandle = null;
    }

    window.removeEventListener('message', handleFrameChatMessage, false);
    resetChatSyncState();
}

function getMenuContainer() {
    const selectors = ['#extensionsMenu', '#extensions-menu', '#extensionsList', '#extensionsMenuContainer', '#extensions_menu'];
    for (const selector of selectors) {
        const element = $(selector);
        if (element && element.length) {
            return element;
        }
    }
    return null;
}

async function renderWorldEngineTemplate(name, context = {}) {
    const templatePath = new URL(`./templates/${name}.html`, EXTENSION_BASE_URL).toString();

    try {
        const response = await fetch(templatePath, { cache: 'no-cache' });

        if (!response.ok) {
            throw new Error(`Failed to load template: ${templatePath}`);
        }

        const templateSource = await response.text();

        if (window.Handlebars?.compile) {
            return window.Handlebars.compile(templateSource)(context);
        }

        return templateSource;
    } catch (error) {
        console.warn('[World Engine] Falling back to default template renderer.', error);

        if (typeof renderExtensionTemplateAsync === 'function') {
            return renderExtensionTemplateAsync(EXTENSION_NAME, name, context);
        }

        throw error;
    }
}

async function openWorldEnginePopup() {
    const settings = getSettings();
    const viewUrl = buildViewUrl(settings);
    const template = await renderWorldEngineTemplate('window', { src: viewUrl });
    const dialog = $(template);
    const iframe = dialog.find('#world_engine_iframe')[0];
    const iframeWrapper = dialog.find('.world-engine-iframe-wrapper');
    const iframeError = dialog.find('.world-engine-iframe-error');
    let iframeLoadTimer = null;

    const clearIframeLoadTimer = () => {
        if (iframeLoadTimer) {
            clearTimeout(iframeLoadTimer);
            iframeLoadTimer = null;
        }
    };

    const showIframeError = () => {
        iframeWrapper?.addClass('has-error');
        iframeError?.removeClass('is-hidden');
    };

    const hideIframeError = () => {
        iframeWrapper?.removeClass('has-error');
        iframeError?.addClass('is-hidden');
    };

    const beginIframeLoadWatch = (reload = false) => {
        if (!iframe) return;
        hideIframeError();
        clearIframeLoadTimer();
        iframeLoadTimer = window.setTimeout(() => {
            console.warn('[World Engine] Popup iframe load timed out.');
            showIframeError();
        }, IFRAME_LOAD_TIMEOUT_MS);

        if (reload) {
            iframe.src = buildViewUrl(settings);
            trackWorldEngineFrame(iframe);
        }
    };

    dialog.on('load', '#world_engine_iframe', (event) => {
        clearIframeLoadTimer();
        hideIframeError();
        trackWorldEngineFrame(event.target);
        const frameWindow = event.target?.contentWindow;
        sendSettingsToFrame(frameWindow, settings);
        syncChatHistory(frameWindow);
    });

    dialog.on('error', '#world_engine_iframe', () => {
        clearIframeLoadTimer();
        showIframeError();
    });

    dialog.on('input', '#world_engine_speed', async (event) => {
        const value = Number(event.target.value) || DEFAULT_SETTINGS.movementSpeed;
        settings.movementSpeed = Math.max(0.1, value);
        dialog.find('#world_engine_speed_value').text(`${settings.movementSpeed.toFixed(1)}x`);
        await persistSettings();
        sendSettingsToFrame(dialog.find('#world_engine_iframe')[0]?.contentWindow, settings);
    });

    dialog.on('change', '#world_engine_invert_look', async (event) => {
        settings.invertLook = Boolean(event.target.checked);
        await persistSettings();
        sendSettingsToFrame(dialog.find('#world_engine_iframe')[0]?.contentWindow, settings);
    });

    dialog.on('change', '#world_engine_show_instructions', async (event) => {
        settings.showInstructions = Boolean(event.target.checked);
        await persistSettings();
        sendSettingsToFrame(dialog.find('#world_engine_iframe')[0]?.contentWindow, settings);
    });

    dialog.find('#world_engine_speed').val(settings.movementSpeed);
    dialog.find('#world_engine_speed_value').text(`${settings.movementSpeed.toFixed(1)}x`);
    dialog.find('#world_engine_invert_look').prop('checked', settings.invertLook);
    dialog.find('#world_engine_show_instructions').prop('checked', settings.showInstructions);

    dialog.on('click', '.world-engine-retry-button', (event) => {
        event.preventDefault();
        beginIframeLoadWatch(true);
    });

    beginIframeLoadWatch(false);

    callGenericPopup(dialog, POPUP_TYPE.TEXT, 'World Engine', { wide: true, large: true, allowVerticalScrolling: false });
}

function getSettings() {
    return ensureSettings(extension_settings);
}

async function ensureSettingsPanel() {
    const existingRoot = document.getElementById(SETTINGS_ROOT_ID);
    if (existingRoot) {
        setupSettingsPanel(existingRoot);
        return;
    }

    try {
        const response = await fetch(SETTINGS_HTML_URL, { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`Failed to load settings HTML (${response.status})`);
        }

        const settingsHtml = await response.text();
        const settingsContainer = $('#extensions_settings');

        if (!settingsContainer?.length) {
            console.warn('[World Engine] Could not find the extensions settings container.');
            return;
        }

        settingsContainer.append(settingsHtml);
        const root = document.getElementById(SETTINGS_ROOT_ID);
        setupSettingsPanel(root);
    } catch (error) {
        console.error('[World Engine] Failed to initialize settings UI:', error);
    }
}

function setupSettingsPanel(root) {
    if (!root || root.dataset.initialized === 'true') return;

    const settings = getSettings();
    const iframe = root.querySelector('#world_engine_iframe');
    trackWorldEngineFrame(iframe);
    const iframeWrapper = root.querySelector('.world-engine-iframe-wrapper');
    const iframeError = root.querySelector('.world-engine-iframe-error');
    const retryButton = root.querySelector('.world-engine-retry-button');
    const speedInput = root.querySelector('#world_engine_speed');
    const speedValue = root.querySelector('#world_engine_speed_value');
    const invertCheckbox = root.querySelector('#world_engine_invert_look');
    const instructionsCheckbox = root.querySelector('#world_engine_show_instructions');
    const maximizeButton = root.querySelector('#world_engine_maximize');
    const maximizeIcon = maximizeButton?.querySelector('.fa-solid');
    const maximizeLabel = maximizeButton?.querySelector('.world-engine-maximize-label');
    const minimizeButton = root.querySelector('#world_engine_minimize');
    const iframeWrapperParent = iframeWrapper?.parentElement;
    const iframeWrapperPlaceholder = document.createComment('world-engine-iframe-placeholder');
    const iframeWrapperNextSibling = iframeWrapper?.nextSibling || null;
    let isMaximized = false;
    let iframeLoadTimer = null;

    const clearIframeLoadTimer = () => {
        if (iframeLoadTimer) {
            clearTimeout(iframeLoadTimer);
            iframeLoadTimer = null;
        }
    };

    const showIframeError = () => {
        iframeWrapper?.classList.add('has-error');
        iframeError?.classList.remove('is-hidden');
    };

    const hideIframeError = () => {
        iframeWrapper?.classList.remove('has-error');
        iframeError?.classList.add('is-hidden');
    };

    const updateIframeSrc = () => {
        if (!iframe) return;
        hideIframeError();
        clearIframeLoadTimer();
        iframeLoadTimer = window.setTimeout(() => {
            console.warn('[World Engine] Settings iframe load timed out.');
            showIframeError();
        }, IFRAME_LOAD_TIMEOUT_MS);

        iframe.src = buildViewUrl(settings);
        trackWorldEngineFrame(iframe);
    };

    const syncControls = () => {
        if (speedInput) speedInput.value = settings.movementSpeed;
        if (speedValue) speedValue.textContent = `${settings.movementSpeed.toFixed(1)}x`;
        if (invertCheckbox) invertCheckbox.checked = Boolean(settings.invertLook);
        if (instructionsCheckbox) instructionsCheckbox.checked = Boolean(settings.showInstructions);
    };

    const pushSettingsToFrame = async () => {
        await persistSettings();
        sendSettingsToFrame(iframe?.contentWindow, settings);
    };

    const moveWrapperToBody = () => {
        if (!iframeWrapper) return;

        if (!iframeWrapperPlaceholder.isConnected && iframeWrapperParent) {
            iframeWrapperParent.insertBefore(iframeWrapperPlaceholder, iframeWrapper);
        }

        document.body.appendChild(iframeWrapper);
    };

    const restoreWrapperToPanel = () => {
        if (!iframeWrapper || !iframeWrapperParent) return;

        if (iframeWrapperPlaceholder.parentNode) {
            iframeWrapperPlaceholder.replaceWith(iframeWrapper);
            return;
        }

        iframeWrapperParent.insertBefore(iframeWrapper, iframeWrapperNextSibling);
    };

    const setMaximized = (maximized) => {
        isMaximized = Boolean(maximized);

        if (isMaximized) {
            moveWrapperToBody();
            iframeWrapper?.classList.remove('is-hidden');
        } else {
            iframeWrapper?.classList.add('is-hidden');
            restoreWrapperToPanel();
        }
        iframeWrapper?.classList.toggle('is-maximized', isMaximized);
        document.body.classList.toggle('world-engine-maximized', isMaximized);

        if (maximizeButton) {
            maximizeButton.setAttribute('aria-pressed', String(isMaximized));
        }

        if (maximizeIcon) {
            maximizeIcon.classList.toggle('fa-maximize', !isMaximized);
            maximizeIcon.classList.toggle('fa-minimize', isMaximized);
        }

        if (maximizeLabel) {
            maximizeLabel.textContent = isMaximized ? 'Minimize view' : 'Start world';
        }
    };

    speedInput?.addEventListener('input', (event) => {
        const value = Number(event.target.value) || DEFAULT_SETTINGS.movementSpeed;
        settings.movementSpeed = Math.max(0.1, value);
        if (speedValue) speedValue.textContent = `${settings.movementSpeed.toFixed(1)}x`;
        pushSettingsToFrame();
    });

    invertCheckbox?.addEventListener('change', (event) => {
        settings.invertLook = Boolean(event.target.checked);
        pushSettingsToFrame();
    });

    instructionsCheckbox?.addEventListener('change', (event) => {
        settings.showInstructions = Boolean(event.target.checked);
        pushSettingsToFrame();
    });

    maximizeButton?.addEventListener('click', () => setMaximized(!isMaximized));
    minimizeButton?.addEventListener('click', () => setMaximized(false));

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isMaximized) {
            setMaximized(false);
        }
    });

    iframe?.addEventListener('load', () => {
        clearIframeLoadTimer();
        hideIframeError();
        trackWorldEngineFrame(iframe);
        sendSettingsToFrame(iframe.contentWindow, settings);
        syncChatHistory(iframe.contentWindow);
    });

    iframe?.addEventListener('error', () => {
        clearIframeLoadTimer();
        showIframeError();
    });

    retryButton?.addEventListener('click', (event) => {
        event.preventDefault();
        updateIframeSrc();
    });

    root.dataset.initialized = 'true';
    syncControls();
    updateIframeSrc();
    setMaximized(false);
}

function addMenuButton() {
    if ($('#world_engine_menu_button').length) return;
    const container = getMenuContainer();
    if (!container) {
        console.warn('[World Engine] Could not find an extensions menu container to attach the launcher.');
        return;
    }

    const buttonHtml = `
        <div id="world_engine_menu_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-mountain-sun extensionsMenuExtensionButton"></div>
            <div class="flex1">World Engine</div>
        </div>
    `;

    container.append(buttonHtml);
    $('#world_engine_menu_button').on('click', openWorldEnginePopup);
}

jQuery(() => {
    addMenuButton();
    ensureSettingsPanel();
    initializeChatIntegration();
});
