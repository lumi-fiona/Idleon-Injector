/**
 * Cheat Injection Module
 *
 * Handles Chrome DevTools Protocol interception and script modification for injecting
 * cheat functionality into the game. Intercepts specific script requests, modifies their
 * content to include cheat hooks, and manages the injection of cheat code into the game context.
 */

const CDP = require("chrome-remote-interface");
const fs = require("fs").promises;
const { getRuntimePath } = require("../utils/runtimePaths");

const { objToString } = require("../utils/helpers");
const { createLogger } = require("../utils/logger");

const log = createLogger("Injection");
const LUMI_DEBUG_MARKER = "[LUMI_ANVIL_DEBUG_JSON]";
const LUMI_DEBUG_EXPORT_READY_MARKER = "[LUMI_ANVIL_DEBUG_EXPORT_READY]";
const LUMI_DEBUG_FILE_PATH =
    process.platform === "win32" ? "C:/temp/lumi_debug.txt" : getRuntimePath("logs", "lumi_debug.txt");
let lumiDebugFileAnnounced = false;

function getConsoleArgValue(arg) {
    if (Object.prototype.hasOwnProperty.call(arg, "value")) return arg.value;
    if (Object.prototype.hasOwnProperty.call(arg, "unserializableValue")) return arg.unserializableValue;
    if (arg?.description) return arg.description;
    return "";
}

async function appendLumiDebugLine(line) {
    try {
        if (process.platform === "win32") {
            await fs.mkdir("C:/temp", { recursive: true });
        } else {
            await fs.mkdir(getRuntimePath("logs"), { recursive: true });
        }

        await fs.appendFile(LUMI_DEBUG_FILE_PATH, line + "\n", "utf8");

        if (!lumiDebugFileAnnounced) {
            lumiDebugFileAnnounced = true;
            log.info(`LUMI debug log path: ${LUMI_DEBUG_FILE_PATH}`);
        }
    } catch (error) {
        log.error("Failed writing LUMI debug file:", error.message);
    }
}

async function handleLumiDebugConsole(args) {
    if (!Array.isArray(args) || args.length === 0) return;

    const first = String(args[0] ?? "");

    if (first === LUMI_DEBUG_MARKER) {
        const rawPayload = typeof args[1] === "string" ? args[1] : JSON.stringify(args[1]);
        const timestamp = new Date().toISOString();

        try {
            const parsed = JSON.parse(rawPayload);
            const line = `[${timestamp}] ${JSON.stringify(parsed)}`;
            await appendLumiDebugLine(line);
        } catch {
            const line = `[${timestamp}] ${rawPayload}`;
            await appendLumiDebugLine(line);
        }
        return;
    }

    if (first === LUMI_DEBUG_EXPORT_READY_MARKER) {
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${LUMI_DEBUG_EXPORT_READY_MARKER} ${JSON.stringify(args[1] ?? {})}`;
        await appendLumiDebugLine(line);
    }
}

/**
 * Set up CDP interception and inject cheats into the game
 * @param {string} hook - WebSocket URL for CDP connection
 * @param {Object} config - Configuration object containing injection settings
 * @param {Array} startupCheats - Array of cheat names to run on startup
 * @param {Object} cheatConfig - Configuration for individual cheats
 * @param {number} cdpPort - CDP port number
 * @returns {Promise<Object>} CDP client instance
 */
async function setupIntercept(hook, config, startupCheats, cheatConfig, cdpPort) {
    const options = {
        tab: hook,
        port: cdpPort,
    };

    const client = await CDP(options);

    const { DOM, Page, Network, Runtime } = client;
    log.info("Setting up cheat injection");

    const cheatsPath = getRuntimePath("cheats.js");
    let cheats = await fs.readFile(cheatsPath, "utf8");
    cheats =
        `let startupCheats = ${JSON.stringify(startupCheats)};\n` +
        `let cheatConfig = ${objToString(cheatConfig)};\n` +
        `let webPort = ${config.webPort};\n` +
        `${cheats}`;

    await Network.setRequestInterception({
        patterns: [
            {
                urlPattern: config.interceptPattern,
                resourceType: "Script",
                interceptionStage: "HeadersReceived",
            },
        ],
    });

    // Disable cache to ensure network interception works reliably
    await Network.setCacheDisabled({ cacheDisabled: true });

    await Page.setBypassCSP({ enabled: true });

    Runtime.consoleAPICalled((entry) => {
        const values = entry.args.map((arg) => getConsoleArgValue(arg));
        log.debug(values.join(" "));
        handleLumiDebugConsole(values).catch((error) => {
            log.error("Failed handling LUMI debug console entry:", error.message);
        });
    });

    await Promise.all([Runtime.enable(), Page.enable(), Network.enable(), DOM.enable()]);

    Network.requestIntercepted(async ({ interceptionId, request }) => {
        try {
            log.debug(`Intercepted script: ${request.url}`);
            const response = await Network.getResponseBodyForInterception({ interceptionId });
            const originalBody = Buffer.from(response.body, "base64").toString("utf8");

            // Find the main application variable assignment to hook cheats into
            const InjRegG = new RegExp(config.injreg, "g");
            const VarName = new RegExp("^\\w+");

            const AppMain = InjRegG.exec(originalBody);
            if (!AppMain) {
                log.error(`Injection regex did not match - check injreg pattern`);
                Network.continueInterceptedRequest({ interceptionId });
                return;
            }
            const AppVar = Array(AppMain.length).fill("");
            for (let i = 0; i < AppMain.length; i++) AppVar[i] = VarName.exec(AppMain[i])[0];

            // Inject cheats directly into the current context to persist across page reloads
            log.debug("Evaluating cheat code");
            await Runtime.evaluate({
                expression: cheats,
                awaitPromise: true,
                allowUnsafeEvalBlockedByCSP: true,
            });

            // Assign the game variable to a global window property for cheat access
            const replacementRegex = new RegExp(config.injreg);
            const newBody = originalBody.replace(replacementRegex, `window.__idleon_cheats__=${AppVar[0]};$&`);

            log.debug("Patching game script");

            const newHeaders = [
                `Date: ${new Date().toUTCString()}`,
                `Connection: closed`,
                `Content-Length: ${newBody.length}`,
                `Content-Type: text/javascript`,
            ];
            const newResponse = Buffer.from(
                "HTTP/1.1 200 OK\r\n" + newHeaders.join("\r\n") + "\r\n\r\n" + newBody
            ).toString("base64");

            await Network.continueInterceptedRequest({
                // Make sure to await this
                interceptionId,
                rawResponse: newResponse,
            });
            log.info("Cheats injected successfully!");
        } catch (error) {
            log.error("Injection failed:", error);
            // Attempt to continue with original content to prevent game from hanging
            try {
                await Network.continueInterceptedRequest({ interceptionId });
            } catch (continueError) {
                log.error("Failed to recover from injection error:", continueError);
            }
        }
    });

    log.debug("Request interceptor attached");
    return client;
}

/**
 * Create the JavaScript context expression for accessing the game's cheat interface
 * @returns {string} JavaScript expression for the cheat context
 */
function createCheatContext() {
    return "(window.__idleon_cheats__ || window.document.querySelector('iframe')?.contentWindow?.__idleon_cheats__)";
}

module.exports = {
    setupIntercept,
    createCheatContext,
};
