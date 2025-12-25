const { app, Tray, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const { spawn } = require("child_process");
const WebSocket = require("ws");

let tray;
let lastScanTime = 0;
const SCAN_COOLDOWN = 2000;

// ---------------- Paths ----------------
const userData = app.getPath("userData");
const dataDir = path.join(userData, "data");
const scriptsDir = path.join(userData, "scripts");
const tagsFile = path.join(dataDir, "tags.json");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(scriptsDir, { recursive: true });
if (!fs.existsSync(tagsFile)) fs.writeFileSync(tagsFile, "{}");

// ---------------- Tags ----------------
function loadTags() {
  return JSON.parse(fs.readFileSync(tagsFile, "utf8"));
}

function saveTags(tags) {
  fs.writeFileSync(tagsFile, JSON.stringify(tags, null, 2));
}

// ---------------- Batch runner (FIXED) ----------------
function runBatch(scriptName) {
  if (!scriptName) return;

  const fullPath = path.join(scriptsDir, scriptName);
  if (!fs.existsSync(fullPath)) return;

  // Run exactly like double-clicking the file
  spawn(
    "cmd.exe",
    ["/c", `"${fullPath}"`],
    {
      cwd: scriptsDir,       //critical fix
      detached: true,
      shell: true,
      windowsHide: true
    }
  ).unref();
}
// ---------------- WebSocket ----------------
const wss = new WebSocket.Server({ port: 8080 });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => c.readyState === 1 && c.send(msg));
}

wss.on("connection", ws => {
  ws.send(JSON.stringify({
    type: "allTags",
    tags: loadTags()
  }));

  ws.on("message", msg => {
    const data = JSON.parse(msg.toString());
    const tags = loadTags();

    if (data.type === "saveTag") {
      tags[data.uid] ??= {};
      tags[data.uid].nickname = data.nickname || "";
      saveTags(tags);
      broadcast({ type: "allTags", tags });
    }

    if (data.type === "uploadBatch") {
      const scriptName = `${data.uid}.bat`;
      const destPath = path.join(scriptsDir, scriptName);

      fs.writeFileSync(destPath, Buffer.from(data.content, "base64"));

      tags[data.uid] ??= {};
      tags[data.uid].script = scriptName;
      saveTags(tags);

      broadcast({ type: "allTags", tags });
    }

    if (data.type === "deleteTag") {
      const script = tags[data.uid]?.script;
      if (script) {
        const p = path.join(scriptsDir, script);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      delete tags[data.uid];
      saveTags(tags);
      broadcast({ type: "allTags", tags });
    }

    if (data.type === "getAllTags") {
      ws.send(JSON.stringify({ type: "allTags", tags }));
    }
  });
});

// ---------------- RFID ----------------
function onUID(uid) {
  const now = Date.now();
  if (now - lastScanTime < SCAN_COOLDOWN) return;
  lastScanTime = now;

  const tags = loadTags();
  const tag = tags[uid];

  broadcast({
    type: "scan",
    uid,
    nickname: tag?.nickname || null
  });

  if (tag?.script) runBatch(tag.script);
}

// ---------------- Serial with auto-reconnect ----------------
let port;
let parser;
let serialPath = "COM3"; // change if needed
let serialBaud = 9600;
let reconnectTimeout = 2000;

function startSerial() {
  function connect() {
    port = new SerialPort({
      path: serialPath,
      baudRate: serialBaud,
      autoOpen: false
    });

    parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

    port.open(err => {
      if (err) {
        console.error("Failed to open port:", err.message);
        setTimeout(connect, reconnectTimeout);
        return;
      }
      console.log("RFID reader connected on", serialPath);
    });

    parser.on("data", line => {
      const uid = line.trim();
      if (uid) onUID(uid);
    });

    port.on("error", err => {
      console.error("Serial error:", err.message);
    });

    port.on("close", () => {
      console.log("Serial port closed, reconnecting...");
      setTimeout(connect, reconnectTimeout);
    });
  }

  connect();
}

// ---------------- Tray ----------------
function createTray() {
  tray = new Tray(path.join(__dirname, "tray_icon.ico"));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "RFID Bridge Running", enabled: false },
    { type: "separator" },
    { label: "Exit", click: () => app.quit() }
  ]));
}

// ---------------- App ----------------
app.whenReady().then(() => {
  createTray();
  startSerial();
});

app.on("window-all-closed", e => e.preventDefault());
