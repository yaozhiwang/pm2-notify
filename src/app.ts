/* eslint-disable no-console */
/* eslint-disable no-continue */
import fs from "node:fs";
import handlebars from "handlebars";
import he from "he";
import mjml2html from "mjml";
import { createTransport } from "nodemailer";
import pm2 from "pm2";
import { EventEmitter } from "node:stream";
import { promisify } from "node:util";

import { config } from "./config.js";
import { Packet, Log, QData, AppEvent, ProcessEventPacket } from "./types.js";

const template = handlebars.compile(fs.readFileSync(config.template, "utf8"));
const transporter = createTransport(config.smtp, { ...config.mail });

const events = new Set<AppEvent>();
Object.values(config.target).forEach((app) =>
  Object.keys(app.events).forEach((e) => events.add(e as AppEvent)),
);
const queues = <Record<AppEvent, QData[]>>{};
const processEventQueue = <{ event: string; name: string }[]>[];

// Throttling state for different queues
const throttleState = {
  appEvents: {
    currentTimeout: config.timeout.baseTimeout,
    windowStartTime: Date.now(), // Start time of measurement window
    recentMessageCount: 0, // Messages received in current window
    timeout: null as NodeJS.Timer | null,
  },
  processEvents: {
    currentTimeout: config.timeout.baseTimeout,
    windowStartTime: Date.now(), // Start time of measurement window
    recentMessageCount: 0, // Messages received in current window
    timeout: null as NodeJS.Timer | null,
  },
};

events.forEach((event: AppEvent) => {
  queues[event] = [];
});

// Function to update window timing and reset counters
function startNewMeasurementWindow(
  state: typeof throttleState.appEvents,
): void {
  state.windowStartTime = Date.now();
  state.recentMessageCount = 0;
}

// Calculate next timeout based on fixed window message count
function calculateNextTimeout(messageCount: number): number {
  if (messageCount <= config.timeout.burstThreshold) {
    // Normal traffic
    return config.timeout.minTimeout;
  } else {
    // Scale timeout based on message count relative to threshold
    const scaleFactor =
      (messageCount / config.timeout.burstThreshold) * config.timeout.factor;
    return Math.min(
      config.timeout.maxTimeout,
      Math.ceil(config.timeout.baseTimeout * scaleFactor),
    );
  }
}

// Function to truncate messages if they're too long
function truncateMessage(message: string): string {
  if (message.length > config.timeout.maxMessageLength) {
    return (
      message.substring(0, config.timeout.maxMessageLength) +
      config.timeout.truncationSuffix
    );
  }
  return message;
}

async function sendEmailWithThrottling(
  sendFunction: () => Promise<void>,
  state: typeof throttleState.appEvents,
): Promise<void> {
  if (state.timeout) {
    return;
  }
  state.currentTimeout = calculateNextTimeout(state.recentMessageCount);
  if (state.currentTimeout !== config.timeout.baseTimeout) {
    console.log(`Throttling: ${state.currentTimeout / 1000}s`);
  }
  state.timeout = setTimeout(async () => {
    try {
      await sendFunction();
    } catch (err) {
      console.error(err);
    } finally {
      startNewMeasurementWindow(state);
      state.timeout = null;
    }
  }, state.currentTimeout);
}

async function sendAppEventMail(): Promise<void> {
  const logs: Log[] = [];
  let totalMessageCount = 0;
  const messageCounts: Record<string, number> = {};

  for (const [event, qdata] of Object.entries(queues)) {
    const content: Record<string, string> = {};
    const messageCountsByApp: Record<string, number> = {};

    // Process queued messages
    for (const data of qdata.splice(0, qdata.length)) {
      if (!config.target[data.name].events[event]) {
        continue;
      }

      // Track message counts
      totalMessageCount++;
      messageCountsByApp[data.name] = (messageCountsByApp[data.name] || 0) + 1;

      if (config.target[data.name].events[event]?.ignores) {
        const ignore = config.target[data.name].events[event].ignores?.some(
          (pattern) => new RegExp(pattern).test(data.message),
        );
        if (ignore) {
          console.log(`Drop message from ${data.name}: ${data.message}`);
          totalMessageCount--; // Adjust count for ignored messages
          messageCountsByApp[data.name]--;
          continue;
        }
      }
      if (config.target[data.name].events[event]?.matches) {
        const match = config.target[data.name].events[event].matches?.some(
          (pattern) => new RegExp(pattern).test(data.message),
        );
        if (match) {
          content[data.name] = content[data.name] || "";
          content[data.name] += data.message;
        }
        continue;
      }
      content[data.name] = content[data.name] || "";
      content[data.name] += data.message;
    }

    // Update message counts for tracking
    for (const [name, count] of Object.entries(messageCountsByApp)) {
      if (count > 0) {
        messageCounts[`${name} ${event}`] = count;
      }
    }

    // Process content and truncate if needed
    for (const [name, message] of Object.entries(content)) {
      logs.push({
        name: `${name} ${event}`,
        message: he.encode(truncateMessage(message)),
      });
    }
  }

  if (logs.length === 0) {
    return;
  }

  // Create summary of message counts
  const countSummary = Object.entries(messageCounts)
    .map(([source, count]) => `${source}: ${count} messages`)
    .join("\n");

  // Add summary as the first log entry
  logs.unshift({
    name: "Summary",
    message: `Total: ${totalMessageCount} messages\n${countSummary}`,
  });

  // Check if total content is too large and truncate if needed
  let totalContentLength = logs.reduce(
    (len, log) => len + log.message.length,
    0,
  );
  if (totalContentLength > config.timeout.maxTotalLength) {
    console.log(
      `Email content too large (${totalContentLength} chars), truncating...`,
    );

    // Keep summary and truncate other logs
    const summary = logs[0];
    logs.splice(1); // Remove all except summary
    logs[0] = {
      ...summary,
      message: `${summary.message}\n\n[Email truncated due to excessive size (${totalContentLength} chars)]`,
    };
  }

  const content = template({ logs });
  const { errors, html } = mjml2html(content);
  if (errors.length > 0) {
    throw new Error(JSON.stringify(errors));
  }

  await transporter.sendMail({ html });
  console.log(
    `Email sent with ${totalMessageCount} log entries (throttle: ${throttleState.appEvents.currentTimeout / 1000}ms)`,
  );
}

async function sendProcessEventMail(): Promise<void> {
  if (processEventQueue.length === 0) {
    return;
  }

  // Group events by type for summary
  const eventCounts: Record<string, number> = {};
  processEventQueue.forEach((item) => {
    const key = `${item.name} ${item.event}`;
    eventCounts[key] = (eventCounts[key] || 0) + 1;
  });

  // Create summary
  const summary = [
    `Total: ${processEventQueue.length} process events`,
    ...Object.entries(eventCounts).map(([key, count]) => `${key}: ${count}`),
  ].join("\n");

  // Include summary at the top of the email
  const fullText = `${summary}\n\n${JSON.stringify(processEventQueue, null, 2)}`;

  // Truncate if necessary
  let emailText = fullText;
  if (fullText.length > config.timeout.maxTotalLength) {
    emailText = `${summary}\n\n[Content truncated due to length (${fullText.length} chars)]`;
    console.log(
      `Process email truncated from ${fullText.length} to ${emailText.length} chars`,
    );
  }

  await transporter.sendMail({
    ...config.processEventMail,
    text: emailText,
  });

  console.log(
    `Process event email sent with ${processEventQueue.length} events (throttle: ${throttleState.processEvents.currentTimeout / 1000}ms)`,
  );

  // Clear the queue only after successful send
  processEventQueue.length = 0;
}

function eventBus(event: AppEvent, packet: Packet): void {
  if (!(packet.process.name in config.target)) {
    return;
  }

  queues[event].push({
    event,
    name: packet.process.name,
    message: packet.data,
  });

  const now = Date.now();

  if (now >= throttleState.appEvents.windowStartTime) {
    throttleState.appEvents.recentMessageCount++;
  }

  sendEmailWithThrottling(sendAppEventMail, throttleState.appEvents).catch(
    console.error,
  );
}

function processEventBus(packet: ProcessEventPacket): void {
  if (packet.manually) {
    return;
  }

  processEventQueue.push({
    event: packet.event,
    name: packet.process.name,
  });

  const now = Date.now();

  if (now >= throttleState.processEvents.windowStartTime) {
    throttleState.processEvents.recentMessageCount++;
  }

  sendEmailWithThrottling(
    sendProcessEventMail,
    throttleState.processEvents,
  ).catch(console.error);
}

(async (): Promise<void> => {
  // https://github.com/nodejs/node/issues/13338#issuecomment-546494270
  await promisify(pm2.connect).bind(pm2)();
  console.log("[PM2] Log streaming connected");

  const bus = <EventEmitter>await promisify(pm2.launchBus).bind(pm2)();
  console.log("[PM2] Log streaming launched");

  for (const event of events) {
    console.log(`[PM2] ${event} streaming started`);
    bus.on(event, (packet: Packet) => eventBus(event, packet));
  }

  console.log("[PM2] process:event streaming started");
  bus.on("process:event", (packet: ProcessEventPacket) =>
    processEventBus(packet),
  );
})().catch(console.error);
