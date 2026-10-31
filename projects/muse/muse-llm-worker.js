/* Muse: runs the on-device model off the main thread so the page never freezes */
import { WebWorkerMLCEngineHandler } from "./vendor/web-llm-0.2.87.js";
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
