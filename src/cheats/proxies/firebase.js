/**
 * Firebase Proxy
 *
 * Proxies for Firebase storage functions:
 * - playButton (re-initialize proxies on character selection)
 * - Companion management (delete, swap, set, get)
 * - Party members
 * - Unban (cleanMarkedFiles)
 * - Steam achievements (prevent duplicates)
 */

import { cheatConfig, cheatState } from "../core/state.js";
import { registerCommonVariables, cList, firebase, gameContext, gga, monsterDefs } from "../core/globals.js";
import { createMethodProxy } from "../utils/proxy.js";
import { setupCListProxy } from "./clist.js";
import { setupGameAttributeProxies } from "./gameAttributes.js";
import { setupItemProxies } from "./items.js";

const LUMI_ANVIL_DEBUG_KEY = "lumi_anvil_debug";
const LUMI_ANVIL_DEBUG_LIMIT = 20;
const LUMI_ANVIL_DEBUG_TEXT_KEY = "lumi_anvil_debug_text";
const LUMI_ANVIL_DEBUG_LAST_DOWNLOAD_KEY = "lumi_anvil_debug_last_download_at";
const LUMI_ANVIL_DEBUG_FIRST_EXPORT_KEY = "lumi_anvil_debug_first_export_done";
const LUMI_ANVIL_DOWNLOAD_COOLDOWN_MS = 2000;

function toSerializable(value, depth = 0) {
    if (depth > 3) return "[max-depth]";
    if (value === null || value === undefined) return value;

    const valueType = typeof value;
    if (valueType === "string" || valueType === "number" || valueType === "boolean") return value;

    if (Array.isArray(value)) {
        return value.slice(0, 20).map((entry) => toSerializable(entry, depth + 1));
    }

    if (valueType === "object") {
        const result = {};
        const keys = Object.keys(value).slice(0, 20);
        for (const key of keys) {
            result[key] = toSerializable(value[key], depth + 1);
        }
        return result;
    }

    return String(value);
}

function getDebugStorage() {
    try {
        if (gameContext?.localStorage) return gameContext.localStorage;
        if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    } catch {
        return null;
    }

    return null;
}

function getAnvilDebugEntries(storage) {
    try {
        const existing = storage.getItem(LUMI_ANVIL_DEBUG_KEY);
        const parsed = existing ? JSON.parse(existing) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveAnvilDebugEntries(storage, entries) {
    storage.setItem(LUMI_ANVIL_DEBUG_KEY, JSON.stringify(entries));
    storage.setItem(LUMI_ANVIL_DEBUG_TEXT_KEY, JSON.stringify(entries, null, 2));
}

function appendAnvilDebugEntry(entry) {
    const storage = getDebugStorage();
    if (!storage) return false;

    try {
        const entries = getAnvilDebugEntries(storage);

        entries.push(entry);
        if (entries.length > LUMI_ANVIL_DEBUG_LIMIT) {
            entries.splice(0, entries.length - LUMI_ANVIL_DEBUG_LIMIT);
        }

        saveAnvilDebugEntries(storage, entries);
        return true;
    } catch {
        return false;
    }
}

function tryAutoDownloadAnvilDebugFile(reason = "error") {
    const storage = getDebugStorage();
    if (!storage) return false;

    try {
        const now = Date.now();
        const lastDownloadAt = Number(storage.getItem(LUMI_ANVIL_DEBUG_LAST_DOWNLOAD_KEY) || 0);
        if (Number.isFinite(lastDownloadAt) && now - lastDownloadAt < LUMI_ANVIL_DOWNLOAD_COOLDOWN_MS) {
            return false;
        }

        const textPayload =
            storage.getItem(LUMI_ANVIL_DEBUG_TEXT_KEY) || JSON.stringify(getAnvilDebugEntries(storage), null, 2);
        if (!textPayload || textPayload === "[]") return false;

        const ctx = gameContext || (typeof window !== "undefined" ? window : null);
        if (!ctx?.document || !ctx?.URL || typeof ctx.Blob === "undefined") return false;

        storage.setItem(LUMI_ANVIL_DEBUG_LAST_DOWNLOAD_KEY, String(now));

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `lumi_anvil_debug_${reason}_${timestamp}.json`;
        const blob = new ctx.Blob([textPayload], { type: "application/json" });
        const url = ctx.URL.createObjectURL(blob);
        const link = ctx.document.createElement("a");

        link.href = url;
        link.download = filename;
        link.style.display = "none";

        ctx.document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => ctx.URL.revokeObjectURL(url), 1500);

        console.error("[LUMI_ANVIL_DEBUG_EXPORT_READY]", {
            filename,
            reason,
            localStorageKeys: [LUMI_ANVIL_DEBUG_KEY, LUMI_ANVIL_DEBUG_TEXT_KEY],
        });

        return true;
    } catch (error) {
        console.error("[LUMI_ANVIL_DEBUG_EXPORT_FAILED]", error?.message || String(error));
        return false;
    }
}

function tryExecCommandCopy(ctx, textPayload) {
    if (!ctx?.document?.body) return false;

    try {
        const textarea = ctx.document.createElement("textarea");
        textarea.value = textPayload;
        textarea.setAttribute("readonly", "readonly");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        textarea.style.pointerEvents = "none";
        textarea.style.left = "-9999px";

        ctx.document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();

        const success = ctx.document.execCommand?.("copy") === true;
        textarea.remove();
        return success;
    } catch {
        return false;
    }
}

function tryAutoCopyAnvilDebugText(reason = "entry") {
    const storage = getDebugStorage();
    if (!storage) return false;

    try {
        const textPayload = storage.getItem(LUMI_ANVIL_DEBUG_TEXT_KEY);
        if (!textPayload || textPayload === "[]") return false;

        const ctx = gameContext || (typeof window !== "undefined" ? window : null);
        if (!ctx) return false;

        if (ctx?.navigator?.clipboard?.writeText) {
            ctx.navigator.clipboard
                .writeText(textPayload)
                .then(() => {
                    console.error("[LUMI_ANVIL_DEBUG_CLIPBOARD_READY]", {
                        reason,
                        bytes: textPayload.length,
                        method: "navigator.clipboard",
                    });
                })
                .catch(() => {
                    const fallbackOk = tryExecCommandCopy(ctx, textPayload);
                    if (fallbackOk) {
                        console.error("[LUMI_ANVIL_DEBUG_CLIPBOARD_READY]", {
                            reason,
                            bytes: textPayload.length,
                            method: "execCommand",
                        });
                    } else {
                        console.error("[LUMI_ANVIL_DEBUG_CLIPBOARD_FAILED]", {
                            reason,
                            localStorageKeys: [LUMI_ANVIL_DEBUG_KEY, LUMI_ANVIL_DEBUG_TEXT_KEY],
                        });
                    }
                });

            return true;
        }

        const fallbackOk = tryExecCommandCopy(ctx, textPayload);
        if (fallbackOk) {
            console.error("[LUMI_ANVIL_DEBUG_CLIPBOARD_READY]", {
                reason,
                bytes: textPayload.length,
                method: "execCommand",
            });
            return true;
        }

        console.error("[LUMI_ANVIL_DEBUG_CLIPBOARD_FAILED]", {
            reason,
            localStorageKeys: [LUMI_ANVIL_DEBUG_KEY, LUMI_ANVIL_DEBUG_TEXT_KEY],
        });
        return false;
    } catch {
        return false;
    }
}

function shouldAutoExportFromEntry(args = [], extra = {}) {
    return extra?.phase === "before" && args[0] === "AnvilPA";
}

function tryAutoExportFirstEntry(args = [], extra = {}) {
    if (!shouldAutoExportFromEntry(args, extra)) return false;

    const storage = getDebugStorage();
    if (!storage) return false;

    if (storage.getItem(LUMI_ANVIL_DEBUG_FIRST_EXPORT_KEY) === "1") return false;

    const exported = tryAutoDownloadAnvilDebugFile("first-entry");
    tryAutoCopyAnvilDebugText("first-entry");
    if (exported) {
        storage.setItem(LUMI_ANVIL_DEBUG_FIRST_EXPORT_KEY, "1");
        return true;
    }

    // Mark as done even if download was blocked to avoid repeated spam on every tick.
    storage.setItem(LUMI_ANVIL_DEBUG_FIRST_EXPORT_KEY, "1");
    return exported;
}

function resetFirstExportFlag() {
    const storage = getDebugStorage();
    if (!storage) return;

    try {
        storage.removeItem(LUMI_ANVIL_DEBUG_FIRST_EXPORT_KEY);
    } catch {
        // Ignore storage errors in debug flow.
    }
}

function buildAnvilSnapshot(source, args = [], extra = {}) {
    const anvilPA = gga?.AnvilPA;
    const anvilPAselect = gga?.AnvilPAselect;
    const usernames = Array.isArray(gga?.GetPlayersUsernames) ? gga.GetPlayersUsernames : [];
    const charName = Array.isArray(gga?.UserInfo) ? gga.UserInfo[0] ?? null : null;
    const charIndex = charName ? usernames.indexOf(charName) : -1;

    const selectedRows = Array.isArray(anvilPAselect)
        ? anvilPAselect.map((index, slot) => {
              const numericIndex = Number(index);
              const validIndex = Number.isInteger(numericIndex) && numericIndex >= 0;
              const inRange = validIndex && Array.isArray(anvilPA) && numericIndex < anvilPA.length;
              const rowExists = inRange && Object.prototype.hasOwnProperty.call(anvilPA, numericIndex);
              const row = inRange ? anvilPA[numericIndex] : undefined;

              return {
                  slot,
                  index,
                  numericIndex: validIndex ? numericIndex : null,
                  inRange,
                  rowExists,
                  rowIsArray: Array.isArray(row),
                  row: toSerializable(row),
              };
          })
        : [];

    const anvilPAEntries = [];
    if (Array.isArray(anvilPA)) {
        for (let i = 0; i < anvilPA.length; i++) {
            const rowExists = Object.prototype.hasOwnProperty.call(anvilPA, i);
            const row = rowExists ? anvilPA[i] : undefined;

            anvilPAEntries.push({
                index: i,
                rowExists,
                rowIsArray: Array.isArray(row),
                row: toSerializable(row),
            });
        }
    }

    let holeCount = null;
    if (Array.isArray(anvilPA)) {
        holeCount = 0;
        for (let i = 0; i < anvilPA.length; i++) {
            if (!Object.prototype.hasOwnProperty.call(anvilPA, i)) {
                holeCount++;
            }
        }
    }

    const snapshot = {
        timestamp: new Date().toISOString(),
        source,
        args: toSerializable(args),
        charName,
        charIndex: charIndex >= 0 ? charIndex : null,
        anvil: {
            anvilPAType: Array.isArray(anvilPA) ? "array" : typeof anvilPA,
            anvilPALength: Array.isArray(anvilPA) ? anvilPA.length : null,
            anvilPAHoleCount: holeCount,
            anvilPAEntries,
            anvilPAselectType: Array.isArray(anvilPAselect) ? "array" : typeof anvilPAselect,
            anvilPAselectLength: Array.isArray(anvilPAselect) ? anvilPAselect.length : null,
            anvilPAselect: toSerializable(anvilPAselect),
            selectedRows,
        },
    };

    for (const [key, value] of Object.entries(extra)) {
        snapshot[key] = toSerializable(value);
    }

    return snapshot;
}

function logAnvilDebug(source, args = [], extra = {}, useError = false) {
    const snapshot = buildAnvilSnapshot(source, args, extra);
    const saved = appendAnvilDebugEntry(snapshot);

    const payload = {
        ...snapshot,
        localStorageKey: LUMI_ANVIL_DEBUG_KEY,
        saved,
    };

    if (useError) {
        console.error("[LUMI_ANVIL_DEBUG]", payload);
        try {
            console.error("[LUMI_ANVIL_DEBUG_JSON]", JSON.stringify(payload));
        } catch {
            // Ignore stringify failures in debug logging.
        }

        const reason = typeof extra?.phase === "string" ? extra.phase : "error";
        tryAutoDownloadAnvilDebugFile(reason);
        tryAutoCopyAnvilDebugText(reason);
    } else {
        console.log("[LUMI_ANVIL_DEBUG]", payload);
        try {
            console.log("[LUMI_ANVIL_DEBUG_JSON]", JSON.stringify(payload));
        } catch {
            // Ignore stringify failures in debug logging.
        }
        tryAutoExportFirstEntry(args, extra);
    }

    return payload;
}

function patchAnvilAfkMethod(target, methodName, ownerLabel) {
    if (!target || typeof target[methodName] !== "function") return false;

    const original = target[methodName];
    if (original._lumiAnvilDebugPatched) return false;

    target[methodName] = function (...args) {
        if (methodName === "_customBlock_AFKcode" && args[0] === "AnvilPA") {
            const snapshot = logAnvilDebug(`${ownerLabel}.${methodName}`, args, { phase: "before" });

            const hasInvalidSelection = snapshot.anvil.selectedRows.some(
                (entry) => entry.index !== -1 && (!entry.inRange || !entry.rowExists || !entry.rowIsArray)
            );

            if (hasInvalidSelection) {
                logAnvilDebug(
                    `${ownerLabel}.${methodName}`,
                    args,
                    {
                        phase: "preflight-warning",
                        reason: "selected AnvilPA row missing/out-of-range/not-array",
                    },
                    true
                );
            }
        }

        try {
            return Reflect.apply(original, this, args);
        } catch (error) {
            logAnvilDebug(
                `${ownerLabel}.${methodName}`,
                args,
                {
                    phase: "error",
                    error: error?.message || String(error),
                    stack: error?.stack || null,
                },
                true
            );
            throw error;
        }
    };

    Object.defineProperty(target[methodName], "_lumiAnvilDebugPatched", { value: true, enumerable: false });
    return true;
}

function setupAnvilAfkDebugProxy() {
    if (!gameContext) return;

    let patchedCount = 0;

    for (const [key, value] of Object.entries(gameContext)) {
        if (!key.startsWith("scripts.ActorEvents_")) continue;

        try {
            if (patchAnvilAfkMethod(value, "_customBlock_AFKcode", key)) patchedCount++;
            if (patchAnvilAfkMethod(value, "_customBlock_AFKgains", key)) patchedCount++;

            if (value?.prototype) {
                if (patchAnvilAfkMethod(value.prototype, "_customBlock_AFKcode", `${key}.prototype`)) patchedCount++;
                if (patchAnvilAfkMethod(value.prototype, "_customBlock_AFKgains", `${key}.prototype`)) patchedCount++;
            }
        } catch (error) {
            console.error("[LUMI_ANVIL_DEBUG] Failed patching method", key, error);
        }
    }

    if (patchedCount > 0) {
        console.log("[LUMI_ANVIL_DEBUG] AFK debug hooks active", {
            patchedCount,
            localStorageKey: LUMI_ANVIL_DEBUG_KEY,
        });
    }
}

/**
 * Setup Firebase storage proxy (companion, party, unban).
 */
export function setupFirebaseStorageProxy() {
    const deleteCompanion = firebase.deleteCompanion;
    firebase.deleteCompanion = function (...args) {
        if (cheatState.w1.companion) return Promise.resolve(1);
        return Reflect.apply(deleteCompanion, this, args);
    };

    const swapCompanionOrder = firebase.swapCompanionOrder;
    firebase.swapCompanionOrder = function (...args) {
        if (cheatState.w1.companion) return Promise.resolve(1);
        return Reflect.apply(swapCompanionOrder, this, args);
    };

    const setCompanionFollower = firebase.setCompanionFollower;
    firebase.setCompanionFollower = function (...args) {
        if (cheatState.w1.companion) {
            cheatConfig.w1.companion.current = String(args[0]);
        }
        return Reflect.apply(setCompanionFollower, this, args);
    };

    const getCompanionInfoMe = firebase.getCompanionInfoMe;
    firebase.getCompanionInfoMe = function (...args) {
        if (cheatState.w1.companion) {
            if (!cheatConfig.w1.companion.companions) {
                return Array.from({ length: cList.CompanionDB.length }, (_, index) => index).filter(
                    (index) => monsterDefs[cList.CompanionDB[index][0]]?.h.Name
                );
            }
            const companions = cheatConfig.w1.companion.companions;
            if (typeof companions === "string") {
                return companions
                    .split(",")
                    .map((id) => parseInt(id.trim()))
                    .filter((id) => !isNaN(id));
            }
            return companions;
        }
        return Reflect.apply(getCompanionInfoMe, this, args);
    };

    const getCurrentCompanion = firebase.getCurrentCompanion;
    firebase.getCurrentCompanion = function (...args) {
        if (cheatState.w1.companion) return cheatConfig.w1.companion.current;
        return Reflect.apply(getCurrentCompanion, this, args);
    };

    const cleanMarkedFiles = firebase.cleanMarkedFiles;
    firebase.cleanMarkedFiles = function (...args) {
        if (cheatConfig.unban) return;
        return Reflect.apply(cleanMarkedFiles, this, args);
    };

    createMethodProxy(firebase, "getPartyMembers", (base) => {
        if (!cheatState.wide.autoparty) return base;

        if (Array.isArray(base) && base.length > 0 && base.length < 10) {
            const playersToAdd = 11 - base.length;
            const otherPlayers = gga.OtherPlayers.h;
            const names = Object.keys(otherPlayers).slice(1, playersToAdd);
            for (const name of names) {
                base.push([name, base[0][1], 0]);
            }
        }
        return base;
    });
}

/**
 * Setup steam achievement proxy (prevent duplicate achievements).
 */
export function setupSteamAchievementProxy() {
    const achieveList = [];
    const areaCheck = firebase.areaCheck;
    firebase.areaCheck = function (...args) {
        if (!cheatConfig.steamachieve) return;
        if (achieveList.includes(args[0])) return;
        achieveList.push(args[0]);
        return Reflect.apply(areaCheck, this, args);
    };
}

/**
 * Setup Firebase proxy to handle character selection screen.
 *
 * When player returns from character selection, some game data objects
 * are recreated. The _isPatched flag on those objects will be undefined,
 * allowing the proxies to be re-applied to the new object references.
 */
export function setupFirebaseProxy() {
    if (!firebase.playButton) return;

    if (firebase.playButton._isPatched) return;

    // Apply once immediately so the current session is instrumented.
    resetFirstExportFlag();
    setupAnvilAfkDebugProxy();

    const playButton = firebase.playButton;
    firebase.playButton = function (...args) {
        let base;
        let playButtonError;

        try {
            base = Reflect.apply(playButton, this, args);
        } catch (error) {
            playButtonError = error;
            logAnvilDebug("Firebase.playButton", args, {
                phase: "playButton-error",
                error: error?.message || String(error),
                stack: error?.stack || null,
            }, true);
        }

        resetFirstExportFlag();

        // Register common variables again
        registerCommonVariables(gameContext);

        // Re-apply proxies that depend on game data objects that get
        // recreated during character selection. The _isPatched guard
        // in each setup function will only apply if the object is new.
        try {
            setupAnvilAfkDebugProxy();
            setupCListProxy();
            setupGameAttributeProxies();
            setupItemProxies();
        } catch (e) {
            console.error("Error re-applying proxies after character selection:", e);
        }

        if (playButtonError) throw playButtonError;

        return base;
    };

    Object.defineProperty(firebase.playButton, "_isPatched", { value: true, enumerable: false });
}
