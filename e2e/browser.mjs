/**
 * Browser E2E for ShareShare.
 *
 * Requires the signaling server (:8787) and Vite (:5173) running, plus a
 * Chromium binary. `showSaveFilePicker` is replaced with an in-page writable
 * stub because the native picker cannot be automated; this test covers the
 * DataChannel/transfer/reconnect paths, not OS-level save permissions.
 */
import { chromium } from "playwright-core";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const SIZE_SET = (process.env.SIZES ?? "1,16385,307213").split(",").map(Number);
const RESUME_SIZE = Number(process.env.RESUME_SIZE ?? 4 * 1024 * 1024);
const executablePath =
  process.env.CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

function pageErrors(page, label, errors) {
  page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
}

const receiverStub = ({ delayMs, dropVerified }) => {
  window.__saved = { writes: [], closed: false, aborted: false };
  window.__droppedVerified = false;
  window.showSaveFilePicker = async (options) => ({
    name: options?.suggestedName ?? "download.bin",
    kind: "file",
    async createWritable() {
      return {
        async write(chunk) {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (chunk?.type === "write") {
            window.__saved.writes.push({
              position: chunk.position ?? 0,
              data: Array.from(chunk.data),
            });
          }
        },
        async close() {
          window.__saved.closed = true;
        },
        async abort() {
          window.__saved.aborted = true;
        },
      };
    },
  });
  const original = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (value) {
    if (
      dropVerified &&
      !window.__droppedVerified &&
      typeof value === "string" &&
      value.includes('"type":"verified"')
    ) {
      window.__droppedVerified = true;
      return;
    }
    return original.call(this, value);
  };
};

const captureDataChannel = () => {
  const original = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (value) {
    window.__lastDataChannel = this;
    return original.call(this, value);
  };
};

const captureSignaling = () => {
  const Original = window.WebSocket;
  window.WebSocket = class extends Original {
    constructor(...args) {
      super(...args);
      if (String(args[0]).endsWith("/ws")) window.__signaling = this;
    }
  };
};

const capturePeerConnection = () => {
  const Original = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Original {
    constructor(...args) {
      super(...args);
      window.__pc = this;
    }
  };
};

async function readSaved(receiver, expectedSize) {
  return receiver.evaluate(async () => {
    let max = 0;
    for (const write of window.__saved.writes) {
      max = Math.max(max, write.position + write.data.length);
    }
    const bytes = new Uint8Array(max);
    for (const write of window.__saved.writes) bytes.set(write.data, write.position);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return {
      length: max,
      hex: Array.from(digest)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      closed: window.__saved.closed,
      aborted: window.__saved.aborted,
      writes: window.__saved.writes.length,
    };
  }).then((result) => {
    if (result.length !== expectedSize) throw new Error(`saved ${result.length} != ${expectedSize}`);
    return result;
  });
}

async function startPair(browser, options) {
  const context = await browser.newContext();
  const sender = await context.newPage();
  const receiver = await context.newPage();
  const errors = [];
  pageErrors(sender, "sender", errors);
  pageErrors(receiver, "receiver", errors);
  if (options.captureChannel) await sender.addInitScript(captureDataChannel);
  if (options.captureSignaling) await sender.addInitScript(captureSignaling);
  if (options.capturePc) await sender.addInitScript(capturePeerConnection);
  await receiver.addInitScript(receiverStub, {
    delayMs: options.delayMs ?? 0,
    dropVerified: options.dropVerified ?? false,
  });

  await sender.goto(`${BASE}/`);
  await sender.waitForSelector("text=파일 선택", { timeout: 15_000 });
  await sender.setInputFiles('input[type="file"]', {
    name: options.fileName,
    mimeType: "application/octet-stream",
    buffer: options.data,
  });
  await sender.waitForSelector("text=수신자 입장을 기다리는 중", { timeout: 15_000 });
  const invite = await sender.locator(".invite-input").inputValue();
  await receiver.goto(invite);
  await receiver.waitForSelector("text=송신자 승인 대기", { timeout: 15_000 });
  const senderCode = (await sender.locator(".code").textContent()).trim();
  const receiverCode = (await receiver.locator(".code").textContent()).trim();
  if (senderCode !== receiverCode) throw new Error("connection codes differ");
  await sender.getByRole("button", { name: /코드가 같습니다/ }).click();
  await receiver.waitForSelector("text=받을 파일", { timeout: 20_000 });
  await receiver.getByRole("button", { name: /저장 위치 선택하고 받기/ }).click();

  return { context, sender, receiver, errors };
}

async function runSize(browser, size) {
  const data = randomBytes(size);
  const expected = createHash("sha256").update(data).digest("hex");
  const { context, sender, receiver, errors } = await startPair(browser, {
    data,
    fileName: `e2e-한글 🚀-${size}.bin`,
  });
  try {
    await sender.waitForSelector("text=수신 확인 완료", { timeout: 60_000 });
    await receiver.waitForSelector("text=저장하고 검증했습니다", { timeout: 60_000 });
    const senderHash = (await sender.locator(".hash-box code").textContent()).trim();
    const receiverHash = (await receiver.locator(".hash-box code").textContent()).trim();
    const saved = await readSaved(receiver, size);
    if (senderHash !== expected || receiverHash !== expected || saved.hex !== expected) {
      throw new Error(`hash mismatch for ${size}`);
    }
    if (!saved.closed || saved.aborted) throw new Error(`writable state invalid for ${size}`);
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(`✓ ${size} bytes`);
  } finally {
    await context.close();
  }
}

async function runChannelDropResume(browser) {
  const data = randomBytes(RESUME_SIZE);
  const expected = createHash("sha256").update(data).digest("hex");
  const { context, sender, receiver, errors } = await startPair(browser, {
    data,
    fileName: "resume.bin",
    captureChannel: true,
    delayMs: 1,
  });
  try {
    await receiver.waitForFunction(() => window.__saved.writes.length >= 64, undefined, {
      timeout: 30_000,
      polling: 10,
    });
    await sender.evaluate(() => {
      if (!window.__lastDataChannel) throw new Error("no data channel captured");
      window.__lastDataChannel.close();
    });
    await sender.waitForSelector("text=수신 확인 완료", { timeout: 90_000 });
    await receiver.waitForSelector("text=저장하고 검증했습니다", { timeout: 90_000 });
    const saved = await readSaved(receiver, RESUME_SIZE);
    if (saved.hex !== expected || !saved.closed || saved.aborted) {
      throw new Error("resume produced wrong bytes");
    }
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(`✓ data channel drop + resume (${RESUME_SIZE} bytes, ${saved.writes} writes)`);
  } finally {
    await context.close();
  }
}

async function runPeerConnectionDrop(browser) {
  const data = randomBytes(RESUME_SIZE);
  const expected = createHash("sha256").update(data).digest("hex");
  const { context, sender, receiver, errors } = await startPair(browser, {
    data,
    fileName: "pc-drop.bin",
    capturePc: true,
    delayMs: 1,
  });
  try {
    await receiver.waitForFunction(() => window.__saved.writes.length >= 64, undefined, {
      timeout: 30_000,
      polling: 10,
    });
    await sender.evaluate(() => {
      if (!window.__pc) throw new Error("no RTCPeerConnection captured");
      window.__pc.close();
    });
    await sender.waitForSelector("text=수신 확인 완료", { timeout: 90_000 });
    await receiver.waitForSelector("text=저장하고 검증했습니다", { timeout: 90_000 });
    const saved = await readSaved(receiver, RESUME_SIZE);
    if (saved.hex !== expected || !saved.closed || saved.aborted) {
      throw new Error("peer connection recovery produced wrong bytes");
    }
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(`✓ RTCPeerConnection close + new connection (${RESUME_SIZE} bytes)`);
  } finally {
    await context.close();
  }
}

async function runSignalingDrop(browser) {
  const data = randomBytes(RESUME_SIZE);
  const expected = createHash("sha256").update(data).digest("hex");
  const { context, sender, receiver, errors } = await startPair(browser, {
    data,
    fileName: "ws-drop.bin",
    captureSignaling: true,
    delayMs: 1,
  });
  try {
    await receiver.waitForFunction(() => window.__saved.writes.length >= 64, undefined, {
      timeout: 30_000,
      polling: 10,
    });
    await sender.evaluate(() => {
      if (!window.__signaling) throw new Error("no signaling socket captured");
      window.__signaling.close();
    });
    await sender.waitForSelector("text=수신 확인 완료", { timeout: 90_000 });
    await receiver.waitForSelector("text=저장하고 검증했습니다", { timeout: 90_000 });
    const saved = await readSaved(receiver, RESUME_SIZE);
    if (saved.hex !== expected || !saved.closed || saved.aborted) {
      throw new Error("signaling reconnect produced wrong bytes");
    }
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(`✓ signaling WebSocket drop + resume (${RESUME_SIZE} bytes)`);
  } finally {
    await context.close();
  }
}

async function runVerifiedRetry(browser) {
  const size = 300 * 1024;
  const data = randomBytes(size);
  const expected = createHash("sha256").update(data).digest("hex");
  const { context, sender, receiver, errors } = await startPair(browser, {
    data,
    fileName: "verified-retry.bin",
    dropVerified: true,
  });
  try {
    await receiver.waitForSelector("text=저장하고 검증했습니다", { timeout: 30_000 });
    await sender.waitForSelector("text=수신 확인 완료", { timeout: 30_000 });
    const dropped = await receiver.evaluate(() => window.__droppedVerified);
    if (!dropped) throw new Error("verified response was not dropped");
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("✓ verified response loss + finish retry");
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  for (const size of SIZE_SET) await runSize(browser, size);
  await runChannelDropResume(browser);
  await runPeerConnectionDrop(browser);
  await runSignalingDrop(browser);
  await runVerifiedRetry(browser);
  console.log("Browser E2E passed.");
} finally {
  await browser.close();
}
