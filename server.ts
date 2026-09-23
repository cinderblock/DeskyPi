const PORT = 80;
const DEFAULTS_PATH = import.meta.dir + "/defaults.json";
const FLASH_DIR = "/var/tmp/deskypi-flash";
const BOOT_MOUNT = "/tmp/deskypi-boot";

// ==================== Helpers ====================

async function readSysFile(path: string): Promise<string> {
  try {
    return (await Bun.file(path).text()).trim();
  } catch {
    return "";
  }
}

async function run(cmd: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { out: out.trim(), err: err.trim(), code: await proc.exited };
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function shellEsc(s: string): string {
  return s.replace(/'/g, "'\\''");
}

// ==================== History Ring Buffer ====================

const HIST_N = 30;
const histBuf: Record<string, number[]> = {};

function pushHist(key: string, val: number): void {
  if (!histBuf[key]) histBuf[key] = [];
  histBuf[key].push(val);
  if (histBuf[key].length > HIST_N) histBuf[key].shift();
}

// ==================== Monitoring State ====================

let prevCpu: { total: number; idle: number } | null = null;
let cpuUsage = 0;
let prevDisk: Record<string, [number, number, number]> = {};
let diskRates: Record<string, [number, number]> = {};
let prevNet: Record<string, [number, number, number]> = {};
let netRates: Record<string, [number, number]> = {};

async function sampleIO(): Promise<void> {
  const now = Date.now();

  // CPU usage
  const statLine = (await readSysFile("/proc/stat")).split("\n")[0];
  if (statLine) {
    const f = statLine.split(/\s+/).slice(1).map(Number);
    const total = f.reduce((a, b) => a + b, 0);
    const idle = f[3] + (f[4] || 0);
    if (prevCpu) {
      const dT = total - prevCpu.total;
      const dI = idle - prevCpu.idle;
      cpuUsage = dT > 0 ? ((dT - dI) / dT) * 100 : 0;
    }
    prevCpu = { total, idle };
  }

  // Disk I/O
  const { out: blockList } = await run(["ls", "/sys/block"]);
  for (const name of blockList.split("\n").filter(Boolean)) {
    if (name.startsWith("loop") || name.startsWith("zram") || name.startsWith("ram")) continue;
    const stat = await readSysFile(`/sys/block/${name}/stat`);
    if (!stat) continue;
    const f = stat.split(/\s+/).filter(Boolean);
    const rs = parseInt(f[2]) || 0;
    const ws = parseInt(f[6]) || 0;
    const p = prevDisk[name];
    if (p) {
      const dt = (now - p[2]) / 1000;
      if (dt > 0) diskRates[name] = [Math.max(0, ((rs - p[0]) * 512) / dt), Math.max(0, ((ws - p[1]) * 512) / dt)];
    }
    prevDisk[name] = [rs, ws, now];
  }

  // Network I/O
  const { out: netList } = await run(["ls", "/sys/class/net"]);
  for (const name of netList.split("\n").filter(Boolean)) {
    if (name === "lo") continue;
    const rx = parseInt(await readSysFile(`/sys/class/net/${name}/statistics/rx_bytes`)) || 0;
    const tx = parseInt(await readSysFile(`/sys/class/net/${name}/statistics/tx_bytes`)) || 0;
    const p = prevNet[name];
    if (p) {
      const dt = (now - p[2]) / 1000;
      if (dt > 0) netRates[name] = [Math.max(0, (rx - p[0]) / dt), Math.max(0, (tx - p[1]) / dt)];
    }
    prevNet[name] = [rx, tx, now];
  }

  // Push to history
  pushHist("cpu", Math.round(cpuUsage * 10) / 10);
  for (const [name, [r, w]] of Object.entries(diskRates)) pushHist(`drv:${name}:r`, r), pushHist(`drv:${name}:w`, w);
  for (const [name, [rx, tx]] of Object.entries(netRates)) pushHist(`net:${name}:rx`, rx), pushHist(`net:${name}:tx`, tx);
}

// ==================== System Info ====================

let piModel = "";
(async () => {
  piModel = await readSysFile("/proc/device-tree/model");
  piModel = piModel.replace(/\0/g, "");
})();

async function getSystemInfo() {
  const temp = parseInt(await readSysFile("/sys/class/thermal/thermal_zone0/temp")) / 1000 || 0;
  const memRaw = await readSysFile("/proc/meminfo");
  const mem: Record<string, number> = {};
  for (const line of memRaw.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = parseInt(m[2]);
  }
  const cores = (await readSysFile("/proc/cpuinfo")).split("processor").length - 1;

  return {
    model: piModel,
    cores: cores || 4,
    cpuUsage: Math.round(cpuUsage * 10) / 10,
    cpuTemp: Math.round(temp * 10) / 10,
    memTotal: mem.MemTotal || 0,
    memAvailable: mem.MemAvailable || 0,
    memPercent: mem.MemTotal ? Math.round(((mem.MemTotal - mem.MemAvailable) / mem.MemTotal) * 1000) / 10 : 0,
  };
}

// ==================== Network Info ====================

async function getWifiInfo(): Promise<{ ssid: string; signal: number; bitrate: string } | null> {
  try {
    const { out, code } = await run(["iw", "dev", "wlan0", "link"]);
    if (code !== 0 || out.includes("Not connected")) return null;
    const ssid = out.match(/SSID:\s*(.+)/)?.[1] || "";
    const signal = parseInt(out.match(/signal:\s*(-?\d+)/)?.[1] || "0");
    const bitrate = out.match(/tx bitrate:\s*(.+)/)?.[1] || "";
    return { ssid, signal, bitrate };
  } catch {
    return null;
  }
}

async function getNetworkInfo() {
  const { out } = await run(["ip", "-j", "addr", "show"]);
  const wifi = await getWifiInfo();
  const { out: routeOut } = await run(["ip", "-j", "route", "show", "default"]);
  const { out: route6Out } = await run(["ip", "-j", "-6", "route", "show", "default"]);
  const gateways: Record<string, { gw: string; metric: number | null }> = {};
  const gateways6: Record<string, string> = {};
  try {
    for (const r of JSON.parse(routeOut)) {
      if (r.dev) gateways[r.dev] = { gw: r.gateway || "", metric: r.metric ?? null };
    }
  } catch {}
  try {
    for (const r of JSON.parse(route6Out)) {
      if (r.dev && r.gateway) gateways6[r.dev] = r.gateway;
    }
  } catch {}
  try {
    const ifaces = JSON.parse(out)
      .filter((i: any) => i.ifname !== "lo")
      .map((i: any) => {
        const inet = i.addr_info?.find((a: any) => a.family === "inet");
        const inet6Addrs = i.addr_info?.filter((a: any) => a.family === "inet6") || [];
        const r = netRates[i.ifname];
        const gw = gateways[i.ifname];
        return {
          name: i.ifname,
          ip: inet?.local || null,
          prefix: inet?.prefixlen || null,
          mac: i.address,
          mtu: i.mtu || null,
          state: i.operstate,
          metric: gw?.metric ?? null,
          gateway: gw?.gw || null,
          gateway6: gateways6[i.ifname] || null,
          ipv6: inet6Addrs.map((a: any) => `${a.local}/${a.prefixlen}`),
          rxRate: r ? r[0] : 0,
          txRate: r ? r[1] : 0,
          wifi: i.ifname === "wlan0" ? wifi : undefined,
        };
      });
    ifaces.sort((a: any, b: any) => (a.metric ?? 9999) - (b.metric ?? 9999));
    return ifaces;
  } catch {
    return [];
  }
}

// ==================== USB Adapters ====================

async function getUsbAdapters() {
  const { out } = await run(["lsusb"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/Bus (\d+) Device (\d+): ID ([0-9a-f:]+)\s+(.*)/i);
      if (!m) return null;
      return { bus: m[1], device: m[2], id: m[3], name: m[4] };
    })
    .filter((d): d is NonNullable<typeof d> => {
      if (!d) return false;
      const n = d.name.toLowerCase();
      return !n.includes("root hub") && !n.includes("hub");
    });
}

// ==================== USB Speed ====================

async function getUsbSpeed(devName: string): Promise<string | null> {
  try {
    // Walk sysfs ancestors to find USB speed attribute
    let p = (await run(["readlink", "-f", `/sys/block/${devName}`])).out;
    for (let i = 0; i < 8; i++) {
      p = p.substring(0, p.lastIndexOf("/"));
      if (p.length < 5) break;
      const speed = await readSysFile(`${p}/speed`);
      if (speed) {
        const mbps = parseInt(speed);
        if (mbps <= 12) return "USB 1.1";
        if (mbps <= 480) return "USB 2.0";
        if (mbps <= 5000) return "USB 3.0";
        if (mbps <= 10000) return "USB 3.1";
        return `USB 3.2`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ==================== Block Devices ====================

async function getDevices() {
  const { out } = await run([
    "lsblk", "-J", "-b", "-o",
    "NAME,PATH,SIZE,TYPE,MOUNTPOINT,MODEL,SERIAL,TRAN,FSTYPE,LABEL,UUID,RM,RO,REV",
  ]);
  let all: any[] = [];
  try {
    all = JSON.parse(out).blockdevices || [];
  } catch {}

  const enrich = (d: any) => {
    const r = diskRates[d.name];
    d.readRate = r ? r[0] : 0;
    d.writeRate = r ? r[1] : 0;
    d.rm = d.rm === true || d.rm === "1" || d.rm === 1;
    d.ro = d.ro === true || d.ro === "1" || d.ro === 1;
    if (d.children) d.children = d.children.map(enrich);
    return d;
  };
  all = all.map(enrich);

  const rootDev = all.find((d) => d.tran === "mmc" || d.name.startsWith("mmcblk"));
  const usbDrives: any[] = [];

  for (const d of all.filter((d) => d.tran === "usb" && d.type === "disk" && d.size > 0)) {
    d.usbVersion = await getUsbSpeed(d.name);
    d.hasPartitions = !!(d.children && d.children.length > 0);
    d.operations = getOpsForDevice(d.name).map(opPublic);
    // Get USB vendor:model ID for adapter correlation
    try {
      const { out: udevOut } = await run(["udevadm", "info", "-q", "property", `/dev/${d.name}`]);
      const vid = udevOut.match(/ID_USB_VENDOR_ID=([0-9a-f]+)/i)?.[1];
      const mid = udevOut.match(/ID_USB_MODEL_ID=([0-9a-f]+)/i)?.[1];
      if (vid && mid) d.usbId = `${vid}:${mid}`;
    } catch {}
    usbDrives.push(d);
  }

  return { rootDevice: rootDev ? enrich(rootDev) : null, drives: usbDrives };
}

// ==================== NBD Exports ====================

async function getNbdExports(): Promise<string[]> {
  try {
    const { out } = await run(["ls", "/etc/nbd-server/conf.d/"]);
    return out.split("\n").filter((f) => f.endsWith(".conf")).map((f) => f.replace(".conf", ""));
  } catch {
    return [];
  }
}

// ==================== Status Assembly ====================

async function getStatus() {
  await sampleIO();
  const system = await getSystemInfo();
  const network = await getNetworkInfo();
  const { rootDevice, drives } = await getDevices();
  const nbdExports = await getNbdExports();
  const usbAdapters = await getUsbAdapters();
  const hostname = await readSysFile("/etc/hostname");
  const uptimeStr = await readSysFile("/proc/uptime");

  // Push mem/wifi to history
  pushHist("mem", system.memPercent);
  const wifiIf = network.find((n: any) => n.wifi);
  if (wifiIf) pushHist("wifi", wifiIf.wifi.signal);

  return {
    hostname,
    uptime: parseFloat(uptimeStr.split(" ")[0]) || 0,
    timestamp: Date.now(),
    buildVersion: (await getBuild()).version,
    // Alias kept so dashboards still open from the previous deploy — which compare
    // `uiVersion` — see the change and reload themselves once.
    uiVersion: (await getBuild()).version,
    system,
    network,
    rootDevice,
    usbAdapters,
    drives,
    nbdExports,
    operations: getAllOps().map(opPublic),
    history: histBuf,
  };
}

// ==================== Operation Queue ====================

interface Operation {
  id: string;
  type: "erase" | "flash" | "deepscan";
  device: string;
  status: string;
  progress: number;
  message: string;
  mode?: string;
  imageUrl?: string;
  imageName?: string;
  extractSize?: number;
  settings?: any;
  scanResult?: any;
  process?: ReturnType<typeof Bun.spawn>;
  aborted?: boolean;
}

const deviceOps = new Map<string, Operation[]>();

function opPublic(o: Operation) {
  return { id: o.id, type: o.type, device: o.device, status: o.status, progress: o.progress, message: o.message, imageName: o.imageName, scanResult: o.scanResult };
}

function getOpsForDevice(device: string): Operation[] {
  return deviceOps.get(device) || [];
}

function getAllOps(): Operation[] {
  return [...deviceOps.values()].flat();
}

function isDeviceBusy(device: string): boolean {
  return !!deviceOps.get(device)?.some((o) => !["done", "error", "queued"].includes(o.status));
}

function hasQueuedFlash(device: string): boolean {
  return !!deviceOps.get(device)?.some((o) => o.type === "flash" && o.status === "queued");
}

function enqueue(op: Operation): void {
  let ops = deviceOps.get(op.device);
  if (!ops) {
    ops = [];
    deviceOps.set(op.device, ops);
  }
  const running = ops.find((o) => !["done", "error", "queued"].includes(o.status));
  ops.push(op);
  if (!running) {
    execOp(op);
  } else {
    op.status = "queued";
    op.message = `Queued after ${running.type}`;
  }
}

async function execOp(op: Operation): Promise<void> {
  try {
    if (op.type === "erase") await doErase(op);
    else if (op.type === "flash") await doFlash(op);
    else if (op.type === "deepscan") await doDeepScan(op);
  } catch (e: any) {
    if (op.status !== "error") {
      op.status = "error";
      op.message = e.message;
    }
  }

  setTimeout(() => {
    const ops = deviceOps.get(op.device);
    if (ops) {
      const idx = ops.indexOf(op);
      if (idx !== -1) ops.splice(idx, 1);
      if (ops.length === 0) deviceOps.delete(op.device);
    }
  }, 30000);

  const ops = deviceOps.get(op.device);
  const next = ops?.find((o) => o.status === "queued");
  if (next) execOp(next);
}

// ==================== Device Actions ====================

function isSysDev(name: string): boolean {
  return name.startsWith("mmcblk") || name.startsWith("zram") || name.startsWith("loop");
}

async function prepareDevice(devName: string): Promise<void> {
  const { out } = await run(["lsblk", "-J", "-o", "NAME,MOUNTPOINT", `/dev/${devName}`]);
  const mps: string[] = [];
  const collect = (d: any) => {
    if (d.mountpoint) mps.push(d.mountpoint);
    d.children?.forEach(collect);
  };
  try {
    JSON.parse(out).blockdevices?.[0] && collect(JSON.parse(out).blockdevices[0]);
  } catch {}
  for (const mp of mps) await run(["sudo", "umount", "-l", mp]);

  // Stale mount dirs
  try {
    const { out: dirs } = await run(["ls", "/srv/nfs/drives/"]);
    for (const d of dirs.split("\n").filter(Boolean)) {
      const { code } = await run(["mountpoint", "-q", `/srv/nfs/drives/${d}`]);
      if (code !== 0) await run(["sudo", "rmdir", `/srv/nfs/drives/${d}`]);
    }
  } catch {}

  // NBD cleanup
  const { out: nbd } = await run(["ls", "/etc/nbd-server/conf.d/"]);
  for (const f of nbd.split("\n").filter(Boolean)) {
    if (f.startsWith(devName)) await run(["sudo", "rm", "-f", `/etc/nbd-server/conf.d/${f}`]);
  }
  await run(["sudo", "systemctl", "restart", "nbd-server"]);
  await run(["sudo", "exportfs", "-ra"]);
}

async function ejectDevice(devName: string): Promise<{ ok: boolean; message: string }> {
  if (isSysDev(devName)) return { ok: false, message: "Cannot eject system device" };
  if (isDeviceBusy(devName)) return { ok: false, message: "Device has active operation" };
  try {
    await prepareDevice(devName);
    const { code } = await run(["sudo", "udisksctl", "power-off", "-b", `/dev/${devName}`, "--no-user-interaction"]);
    if (code !== 0) {
      const sp = (await run(["readlink", "-f", `/sys/block/${devName}/device`])).out;
      if (sp) await run(["sudo", "bash", "-c", `echo 1 > ${sp}/delete`]);
    }
    return { ok: true, message: `${devName} ejected` };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
}

async function scanDevice(devName: string): Promise<{ ok: boolean; message: string; partitions?: any[] }> {
  if (isSysDev(devName)) return { ok: false, message: "Cannot scan system device" };
  await run(["sudo", "partprobe", `/dev/${devName}`]);
  await run(["sudo", "udevadm", "settle", "--timeout=5"]);
  const { out } = await run(["lsblk", "-J", "-b", "-o", "NAME,SIZE,TYPE,FSTYPE,LABEL", `/dev/${devName}`]);
  try {
    const dev = JSON.parse(out).blockdevices?.[0];
    const parts = dev?.children || [];
    if (parts.length > 0) {
      return { ok: true, message: `Found ${parts.length} partition(s)`, partitions: parts };
    }
    // Check for filesystem directly on device
    const { out: blk } = await run(["sudo", "blkid", `/dev/${devName}`]);
    if (blk) return { ok: true, message: `Direct filesystem: ${blk}` };
    // Try file identification
    const { out: fout } = await run(["sudo", "file", "-sL", `/dev/${devName}`]);
    return { ok: true, message: fout || "No partitions or filesystems found" };
  } catch {
    return { ok: false, message: "Scan failed" };
  }
}

// ==================== Raw Sector Probe ====================
//
// A filesystem that reports "empty" says nothing about what is still on the platter.
// These helpers read the block device directly, so a quick-erased or freshly-formatted
// drive still reveals whatever the previous image left behind.

const PROBE_BLOCK = 4096;

// Deep-scan findings, kept per device so they outlive the operation record.
const lastScanResults = new Map<string, any>();

interface Signature {
  name: string;
  bytes: number[];
  at?: number; // required offset within the sampled block; otherwise matched anywhere
}

// Ordered roughly by how much they tell you. `at` entries are filesystem/container
// headers that only mean anything at a fixed offset, which keeps false positives down.
const SIGNATURES: Signature[] = [
  { name: "MBR partition table", bytes: [0x55, 0xaa], at: 510 },
  { name: "GPT header", bytes: [0x45, 0x46, 0x49, 0x20, 0x50, 0x41, 0x52, 0x54] },
  { name: "ext2/3/4 superblock", bytes: [0x53, 0xef], at: 0x438 },
  { name: "FAT32", bytes: [0x46, 0x41, 0x54, 0x33, 0x32], at: 0x52 },
  { name: "FAT12/16", bytes: [0x46, 0x41, 0x54, 0x31], at: 0x36 },
  { name: "NTFS", bytes: [0x4e, 0x54, 0x46, 0x53, 0x20, 0x20, 0x20, 0x20], at: 3 },
  { name: "exFAT", bytes: [0x45, 0x58, 0x46, 0x41, 0x54, 0x20, 0x20, 0x20], at: 3 },
  { name: "LUKS volume", bytes: [0x4c, 0x55, 0x4b, 0x53, 0xba, 0xbe] },
  { name: "squashfs", bytes: [0x68, 0x73, 0x71, 0x73] },
  { name: "Linux swap", bytes: [0x53, 0x57, 0x41, 0x50, 0x53, 0x50, 0x41, 0x43, 0x45, 0x32] },
  { name: "arm64 kernel Image", bytes: [0x41, 0x52, 0x4d, 0x64], at: 0x38 },
  { name: "devicetree blob", bytes: [0xd0, 0x0d, 0xfe, 0xed] },
  { name: "ELF binary", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "SQLite database", bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00] },
  { name: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  { name: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: "GIF", bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: "PDF", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { name: "ZIP / Office / jar", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: "gzip", bytes: [0x1f, 0x8b, 0x08] },
  { name: "xz", bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { name: "bzip2", bytes: [0x42, 0x5a, 0x68] },
  { name: "zstd", bytes: [0x28, 0xb5, 0x2f, 0xfd] },
  { name: "7-zip", bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { name: "tar archive", bytes: [0x75, 0x73, 0x74, 0x61, 0x72], at: 257 },
  { name: "MP4 / MOV", bytes: [0x66, 0x74, 0x79, 0x70], at: 4 },
  { name: "Matroska / WebM", bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { name: "RIFF (wav/avi)", bytes: [0x52, 0x49, 0x46, 0x46] },
  { name: "Ogg", bytes: [0x4f, 0x67, 0x67, 0x53] },
  { name: "FLAC", bytes: [0x66, 0x4c, 0x61, 0x43] },
  { name: "MP3 (ID3)", bytes: [0x49, 0x44, 0x33] },
];

const MAX_SIG_LEN = Math.max(...SIGNATURES.map((s) => s.bytes.length));

function matchesAt(buf: Uint8Array, pos: number, bytes: number[]): boolean {
  if (pos + bytes.length > buf.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[pos + i] !== bytes[i]) return false;
  return true;
}

// Returns absolute byte offsets of every signature hit in `buf`, which starts at `base`.
function findSignatures(buf: Uint8Array, base: number): { name: string; offset: number }[] {
  const hits: { name: string; offset: number }[] = [];
  for (const sig of SIGNATURES) {
    if (sig.at !== undefined) {
      // Anchored: only meaningful at a fixed offset within each block-aligned unit.
      // Alignment is relative to the device, not the buffer — in the deep scan `base`
      // is offset by the carry-over overlap and is not itself block-aligned.
      const firstBlk = Math.ceil(base / PROBE_BLOCK) * PROBE_BLOCK;
      for (let abs = firstBlk; abs - base + sig.at + sig.bytes.length <= buf.length; abs += PROBE_BLOCK) {
        if (matchesAt(buf, abs - base + sig.at, sig.bytes)) hits.push({ name: sig.name, offset: abs });
      }
    } else {
      const first = sig.bytes[0];
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === first && matchesAt(buf, i, sig.bytes)) hits.push({ name: sig.name, offset: base + i });
      }
    }
  }
  return hits;
}

type BlockKind = "zero" | "ones" | "text" | "compressed" | "structured";

interface BlockReading {
  offset: number;
  kind: BlockKind;
  entropy: number;
  signatures: string[];
}

// Shannon entropy in bits/byte. ~0 = uniform fill, ~8 = compressed or encrypted.
function classifyBlock(buf: Uint8Array, offset: number): BlockReading {
  const freq = new Uint32Array(256);
  let zeros = 0, ones = 0, printable = 0;
  for (const b of buf) {
    freq[b]++;
    if (b === 0x00) zeros++;
    else if (b === 0xff) ones++;
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable++;
  }
  const n = buf.length || 1;
  let entropy = 0;
  for (const f of freq) {
    if (!f) continue;
    const p = f / n;
    entropy -= p * Math.log2(p);
  }

  let kind: BlockKind;
  if (zeros === n) kind = "zero";
  else if (ones === n) kind = "ones";
  else if (printable / n > 0.85) kind = "text";
  else if (entropy >= 7.5) kind = "compressed";
  else kind = "structured";

  const signatures = [...new Set(findSignatures(buf, 0).map((h) => h.name))];
  return { offset, kind, entropy: Math.round(entropy * 100) / 100, signatures };
}

async function getDeviceSizeBytes(devName: string): Promise<number> {
  const sectors = parseInt(await readSysFile(`/sys/block/${devName}/size`)) || 0;
  return sectors * 512;
}

// Byte ranges NOT covered by any declared partition — where leftovers hide.
async function getUnallocatedRanges(devName: string, total: number): Promise<{ start: number; end: number }[]> {
  const { out } = await run(["sudo", "sfdisk", "-J", `/dev/${devName}`]);
  let used: { start: number; end: number }[] = [];
  try {
    const pt = JSON.parse(out).partitiontable;
    const ss = pt?.sectorsize || 512;
    used = (pt?.partitions || [])
      .map((p: any) => ({ start: p.start * ss, end: (p.start + p.size) * ss }))
      .sort((a: any, b: any) => a.start - b.start);
  } catch {
    // No partition table at all — the whole device is "unallocated".
    return total > 0 ? [{ start: 0, end: total }] : [];
  }
  const gaps: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const u of used) {
    if (u.start > cursor) gaps.push({ start: cursor, end: u.start });
    cursor = Math.max(cursor, u.end);
  }
  if (cursor < total) gaps.push({ start: cursor, end: total });
  return gaps.filter((g) => g.end - g.start >= PROBE_BLOCK);
}

// One sudo, many seeks — 250 separate `sudo dd` calls would spend most of the time in sudo.
async function readBlocks(devName: string, blockIndexes: number[]): Promise<Uint8Array[]> {
  if (blockIndexes.length === 0) return [];
  const script = blockIndexes
    .map((i) => `dd if=/dev/${devName} bs=${PROBE_BLOCK} count=1 skip=${i} status=none 2>/dev/null`)
    .join("; ");
  const proc = Bun.spawn(["sudo", "sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
  const all = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  const out: Uint8Array[] = [];
  for (let i = 0; i < blockIndexes.length; i++) {
    const s = i * PROBE_BLOCK;
    if (s >= all.length) break;
    out.push(all.subarray(s, Math.min(s + PROBE_BLOCK, all.length)));
  }
  return out;
}

function spreadBlocks(start: number, end: number, count: number): number[] {
  const first = Math.floor(start / PROBE_BLOCK);
  const last = Math.floor((end - PROBE_BLOCK) / PROBE_BLOCK);
  if (last < first) return [];
  const span = last - first;
  const n = Math.min(count, span + 1);
  if (n <= 1) return [first];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(first + Math.round((span * i) / (n - 1)));
  return [...new Set(out)];
}

// Fast sampled read — seconds, not minutes. Gives a feel for what is actually on the
// device without committing to a full pass.
async function probeDevice(devName: string): Promise<any> {
  if (isSysDev(devName)) return { ok: false, message: "Cannot probe system device" };
  const total = await getDeviceSizeBytes(devName);
  if (!total) return { ok: false, message: "Could not determine device size" };

  const gaps = await getUnallocatedRanges(devName, total);

  // Uniform sweep across the whole device, plus a denser look at the unallocated gaps
  // and at the head/tail where partition tables and stale superblocks live.
  const plan = new Set<number>(spreadBlocks(0, total, 192));
  for (const g of gaps) for (const b of spreadBlocks(g.start, g.end, 48)) plan.add(b);
  for (const b of spreadBlocks(0, Math.min(1024 * 1024, total), 16)) plan.add(b);
  for (const b of spreadBlocks(Math.max(0, total - 1024 * 1024), total, 16)) plan.add(b);

  const indexes = [...plan].sort((a, b) => a - b);
  const blocks = await readBlocks(devName, indexes);
  const readings: BlockReading[] = blocks.map((b, i) => classifyBlock(b, indexes[i] * PROBE_BLOCK));

  const counts: Record<BlockKind, number> = { zero: 0, ones: 0, text: 0, compressed: 0, structured: 0 };
  for (const r of readings) counts[r.kind]++;

  const sigMap = new Map<string, number[]>();
  for (const r of readings) {
    for (const name of r.signatures) {
      const list = sigMap.get(name) || [];
      if (list.length < 8) list.push(r.offset);
      sigMap.set(name, list);
    }
  }

  const sampled = readings.length || 1;
  const emptyBlocks = counts.zero + counts.ones;
  // Never round up to 100% while any sampled block still holds data — "100% empty"
  // next to "1 block with data" is worse than useless.
  const emptyPct = emptyBlocks === sampled ? 100 : Math.min(99, Math.round((emptyBlocks / sampled) * 100));
  const inGaps = readings.filter((r) => gaps.some((g) => r.offset >= g.start && r.offset < g.end));
  const gapsWithData = inGaps.filter((r) => r.kind !== "zero" && r.kind !== "ones").length;

  return {
    ok: true,
    device: devName,
    sizeBytes: total,
    sampledBlocks: sampled,
    blockSize: PROBE_BLOCK,
    bytesRead: sampled * PROBE_BLOCK,
    counts,
    emptyPct,
    unallocated: {
      ranges: gaps.map((g) => ({ start: g.start, end: g.end, bytes: g.end - g.start })),
      sampled: inGaps.length,
      withData: gapsWithData,
    },
    signatures: [...sigMap.entries()].map(([name, offsets]) => ({ name, offsets })),
    // Coarse strip for the UI: kind per sample, in device order.
    map: readings.map((r) => ({ o: r.offset, k: r.kind, e: r.entropy })),
    message:
      `Sampled ${sampled} blocks (${fmtBytes(sampled * PROBE_BLOCK)}) — ` +
      `${emptyPct}% empty` +
      (gapsWithData ? `, ${gapsWithData} block(s) with data outside any partition` : "") +
      (sigMap.size ? `, ${sigMap.size} signature type(s) found` : ""),
  };
}

// Exhaustive pass. Runs as a tracked Operation so it reports progress over SSE and can
// be cancelled like an erase or a flash.
async function doDeepScan(op: Operation): Promise<void> {
  const dev = op.device;
  const total = await getDeviceSizeBytes(dev);
  op.status = "scanning";
  op.progress = 0;
  op.message = "Scanning raw device...";

  const proc = Bun.spawn(["sudo", "dd", `if=/dev/${dev}`, "bs=4M", "status=none"], { stdout: "pipe", stderr: "pipe" });
  op.process = proc;

  const hits = new Map<string, { count: number; first: number[] }>();
  let pos = 0;
  let carry = new Uint8Array(0);

  for await (const chunk of proc.stdout) {
    if (op.aborted) { proc.kill(); break; }
    const buf = new Uint8Array(carry.length + chunk.length);
    buf.set(carry, 0);
    buf.set(chunk, carry.length);
    const base = pos - carry.length;

    // Anything starting inside the trailing overlap is deferred to the next chunk, so a
    // signature straddling a chunk boundary is found exactly once.
    const carryLen = Math.min(buf.length, MAX_SIG_LEN - 1);
    const boundary = base + buf.length - carryLen;
    for (const h of findSignatures(buf, base)) {
      if (h.offset >= boundary) continue;
      const e = hits.get(h.name) || { count: 0, first: [] };
      e.count++;
      if (e.first.length < 10) e.first.push(h.offset);
      hits.set(h.name, e);
    }

    pos += chunk.length;
    carry = new Uint8Array(buf.subarray(buf.length - carryLen));
    op.progress = total ? Math.min(99, Math.round((pos / total) * 100)) : 0;
    op.message = `Scanned ${fmtBytes(pos)}${total ? ` / ${fmtBytes(total)}` : ""} — ${hits.size} signature type(s)`;
  }

  await proc.exited;
  if (op.aborted) throw new Error("Cancelled");

  op.scanResult = {
    bytesScanned: pos,
    signatures: [...hits.entries()]
      .map(([name, v]) => ({ name, count: v.count, first: v.first }))
      .sort((a, b) => b.count - a.count),
  };
  // Operations are reaped 30s after completion; keep the findings retrievable after that.
  lastScanResults.set(dev, { ...op.scanResult, device: dev, at: Date.now() });
  op.progress = 100;
  op.status = "done";
  op.message = hits.size
    ? `Found ${hits.size} signature type(s) in ${fmtBytes(pos)}`
    : `No known signatures in ${fmtBytes(pos)} — device looks genuinely blank`;
}

// ==================== Erase ====================

async function doErase(op: Operation): Promise<void> {
  op.status = "preparing";
  op.message = "Unmounting...";
  await prepareDevice(op.device);
  op.status = "erasing";
  const mode = op.mode || "quick";

  if (mode === "quick") {
    op.message = "Wiping signatures...";
    await run(["sudo", "wipefs", "-a", `/dev/${op.device}`]);
    op.progress = 30;
    op.message = "Zeroing partition table...";
    await run(["sudo", "dd", "if=/dev/zero", `of=/dev/${op.device}`, "bs=1M", "count=10", "conv=fsync"]);
    op.progress = 60;
    const { out: sz } = await run(["sudo", "blockdev", "--getsz", `/dev/${op.device}`]);
    const sectors = parseInt(sz);
    if (sectors > 20480) {
      op.message = "Zeroing GPT backup...";
      await run(["sudo", "dd", "if=/dev/zero", `of=/dev/${op.device}`, "bs=512", `seek=${sectors - 20480}`, "count=20480", "conv=fsync"]);
    }
    op.progress = 100;
    op.status = "done";
    op.message = "Quick erase complete";
  } else if (mode === "full") {
    const { out: sizeStr } = await run(["sudo", "blockdev", "--getsize64", `/dev/${op.device}`]);
    const totalBytes = parseInt(sizeStr) || 0;
    op.message = `Writing zeros to ${fmtBytes(totalBytes)}...`;
    const proc = Bun.spawn(["sudo", "dd", "if=/dev/zero", `of=/dev/${op.device}`, "bs=4M", "conv=fsync", "status=progress"], { stdout: "pipe", stderr: "pipe" });
    op.process = proc;
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (op.aborted) { proc.kill(); break; }
      buf += dec.decode(value, { stream: true });
      const ms = [...buf.matchAll(/(\d+) bytes/g)];
      if (ms.length && totalBytes) {
        const c = parseInt(ms[ms.length - 1][1]);
        op.progress = Math.round((c / totalBytes) * 100);
        op.message = `Erasing: ${fmtBytes(c)} / ${fmtBytes(totalBytes)} (${op.progress}%)`;
      }
      if (buf.length > 4096) buf = buf.slice(-2048);
    }
    await proc.exited;
    if (op.aborted) { op.status = "error"; op.message = "Cancelled"; return; }
    op.progress = 100;
    op.status = "done";
    op.message = "Full erase complete";
  } else if (mode === "discard") {
    op.message = "Discarding (TRIM)...";
    const { code, err } = await run(["sudo", "blkdiscard", "-f", `/dev/${op.device}`]);
    if (code !== 0) {
      const msg = err.includes("not supported") || err.includes("not permitted")
        ? "Device does not support TRIM/discard (only SSDs do). Use Quick or Full erase instead."
        : `Discard failed: ${err}`;
      op.status = "error"; op.message = msg; return;
    }
    op.progress = 100;
    op.status = "done";
    op.message = "Discard complete";
  }

  if (op.status === "done") await run(["sudo", "partprobe", `/dev/${op.device}`]);
}

// ==================== Flash ====================

async function doFlash(op: Operation): Promise<void> {
  const imageUrl = op.imageUrl!;
  const filename = imageUrl.split("/").pop()!;
  const dlPath = `${FLASH_DIR}/${filename}`;

  await run(["mkdir", "-p", FLASH_DIR]);

  // Download
  op.status = "downloading";
  op.message = "Starting download...";
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const totalDl = parseInt(resp.headers.get("content-length") || "0");
  const writer = Bun.file(dlPath).writer();
  let downloaded = 0;
  for await (const chunk of resp.body!) {
    if (op.aborted) throw new Error("Cancelled");
    writer.write(chunk);
    downloaded += chunk.length;
    op.progress = totalDl > 0 ? Math.round((downloaded / totalDl) * 40) : 0;
    op.message = `Downloading: ${fmtBytes(downloaded)}${totalDl ? ` / ${fmtBytes(totalDl)}` : ""}`;
  }
  await writer.end();

  // Prepare
  op.status = "preparing";
  op.progress = 40;
  op.message = "Unmounting...";
  await prepareDevice(op.device);

  // Flash
  op.status = "flashing";
  op.message = "Writing image...";
  let cmd: string;
  if (filename.endsWith(".xz")) cmd = `xzcat "${dlPath}" | sudo dd of=/dev/${op.device} bs=4M conv=fsync status=progress`;
  else if (filename.endsWith(".gz")) cmd = `gzip -dc "${dlPath}" | sudo dd of=/dev/${op.device} bs=4M conv=fsync status=progress`;
  else if (filename.endsWith(".zip")) cmd = `unzip -p "${dlPath}" "*.img" | sudo dd of=/dev/${op.device} bs=4M conv=fsync status=progress`;
  else cmd = `sudo dd if="${dlPath}" of=/dev/${op.device} bs=4M conv=fsync status=progress`;

  const flashProc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  op.process = flashProc;
  const reader = flashProc.stderr.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const exSize = op.extractSize || 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (op.aborted) { flashProc.kill(); break; }
    buf += dec.decode(value, { stream: true });
    const ms = [...buf.matchAll(/(\d+) bytes/g)];
    if (ms.length && exSize) {
      const c = parseInt(ms[ms.length - 1][1]);
      op.progress = 40 + Math.round((c / exSize) * 45);
      op.message = `Flashing: ${fmtBytes(c)} / ${fmtBytes(exSize)}`;
    }
    if (buf.length > 4096) buf = buf.slice(-2048);
  }
  const exit = await flashProc.exited;
  if (op.aborted) throw new Error("Cancelled");
  if (exit !== 0) throw new Error("Flash failed");

  // Configure
  op.status = "configuring";
  op.progress = 85;
  op.message = "Applying settings...";
  await run(["sudo", "partprobe", `/dev/${op.device}`]);
  await Bun.sleep(2000);
  if (op.settings && Object.keys(op.settings).length) await applySettings(op.device, op.settings);

  op.progress = 100;
  op.status = "done";
  op.message = "Flash complete!";
  await run(["rm", "-f", dlPath]);
}

async function applySettings(devName: string, s: any): Promise<void> {
  const bootDev = `/dev/${devName}1`;
  await run(["sudo", "mkdir", "-p", BOOT_MOUNT]);
  if ((await run(["sudo", "mount", bootDev, BOOT_MOUNT])).code !== 0) return;
  try {
    if (s.enableSsh) await run(["sudo", "touch", `${BOOT_MOUNT}/ssh`]);
    if (s.username && s.password) {
      const { out: hash } = await run(["openssl", "passwd", "-6", s.password]);
      if (hash) {
        await Bun.write("/tmp/_userconf.txt", `${s.username}:${hash}\n`);
        await run(["sudo", "cp", "/tmp/_userconf.txt", `${BOOT_MOUNT}/userconf.txt`]);
        await run(["rm", "/tmp/_userconf.txt"]);
      }
    } else if (s.username) {
      // No password — create user with locked password (SSH key-only)
      await Bun.write("/tmp/_userconf.txt", `${s.username}:*\n`);
      await run(["sudo", "cp", "/tmp/_userconf.txt", `${BOOT_MOUNT}/userconf.txt`]);
      await run(["rm", "/tmp/_userconf.txt"]);
    }
    const firstrun = mkFirstrun(s);
    await Bun.write("/tmp/_firstrun.sh", firstrun);
    await run(["sudo", "cp", "/tmp/_firstrun.sh", `${BOOT_MOUNT}/firstrun.sh`]);
    await run(["sudo", "chmod", "+x", `${BOOT_MOUNT}/firstrun.sh`]);
    await run(["rm", "/tmp/_firstrun.sh"]);
    const { out: cmdline } = await run(["sudo", "cat", `${BOOT_MOUNT}/cmdline.txt`]);
    if (cmdline && !cmdline.includes("firstrun.sh")) {
      await Bun.write("/tmp/_cmdline.txt", cmdline.trimEnd() + " systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target\n");
      await run(["sudo", "cp", "/tmp/_cmdline.txt", `${BOOT_MOUNT}/cmdline.txt`]);
      await run(["rm", "/tmp/_cmdline.txt"]);
    }
  } finally {
    await run(["sudo", "umount", BOOT_MOUNT]);
  }
}

function mkFirstrun(s: any): string {
  const hn = shellEsc(s.hostname || "raspberrypi");
  let sc = `#!/bin/bash\nset +e\nCURRENT_HOSTNAME=$(cat /etc/hostname | tr -d " \\t\\n\\r")\n`;

  // Hostname
  sc += `\nif [ -f /usr/lib/raspberrypi-sys-mods/imager_custom ]; then\n  /usr/lib/raspberrypi-sys-mods/imager_custom set_hostname '${hn}'\nelse\n  echo '${hn}' >/etc/hostname\n  sed -i "s/127.0.1.1.*$CURRENT_HOSTNAME/127.0.1.1\\t${hn}/g" /etc/hosts\nfi\n`;

  // SSH
  if (s.enableSsh) {
    const pwAuth = s.password ? "true" : "false";
    sc += `\nif [ -f /usr/lib/raspberrypi-sys-mods/imager_custom ]; then\n  /usr/lib/raspberrypi-sys-mods/imager_custom enable_ssh\nelse\n  systemctl enable ssh\nfi\n`;
    if (!s.password) {
      sc += `\nsed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config\n`;
    }
  }

  // SSH authorized keys
  const keys: string[] = Array.isArray(s.sshKeys) ? s.sshKeys : s.sshKeys ? [s.sshKeys] : [];
  const validKeys = keys.map((k: string) => k.trim()).filter((k: string) => k.length > 0);
  if (validKeys.length > 0) {
    const user = shellEsc(s.username || "pi");
    sc += `\nFIRSTUSERHOME=$(getent passwd '${user}' | cut -d: -f6)\nif [ -z "$FIRSTUSERHOME" ]; then FIRSTUSERHOME="/home/${user}"; fi\nmkdir -p "$FIRSTUSERHOME/.ssh"\nchmod 700 "$FIRSTUSERHOME/.ssh"\ncat >> "$FIRSTUSERHOME/.ssh/authorized_keys" <<'SSHEOF'\n`;
    for (const key of validKeys) sc += `${key}\n`;
    sc += `SSHEOF\nchmod 600 "$FIRSTUSERHOME/.ssh/authorized_keys"\nchown -R '${user}:${user}' "$FIRSTUSERHOME/.ssh"\n`;
  }

  // WiFi networks (supports array)
  const wifiNets: any[] = Array.isArray(s.wifiNetworks) ? s.wifiNetworks : [];
  // Legacy single-network compat
  if (wifiNets.length === 0 && s.configureWifi && s.wifiSsid) {
    wifiNets.push({ ssid: s.wifiSsid, password: s.wifiPassword || "", country: s.wifiCountry || "US", priority: 0 });
  }
  for (let i = 0; i < wifiNets.length; i++) {
    const w = wifiNets[i];
    if (!w.ssid) continue;
    const ssid = shellEsc(w.ssid);
    const psk = shellEsc(w.password || "");
    const cc = shellEsc(w.country || "US");
    const connName = `wifi-${i}`;
    sc += `\nif [ -f /usr/lib/raspberrypi-sys-mods/imager_custom ]; then\n  /usr/lib/raspberrypi-sys-mods/imager_custom set_wlan '${ssid}' '${psk}' '${cc}'\nelse\n  cat > '/etc/NetworkManager/system-connections/${connName}.nmconnection' <<'NMEOF'\n[connection]\nid=${w.ssid}\ntype=wifi\nautoconnect-priority=${w.priority || 0}\n[wifi]\nmode=infrastructure\nssid=${w.ssid}\n[wifi-security]\nauth-alg=open\nkey-mgmt=wpa-psk\npsk=${w.password || ""}\n[ipv4]\nmethod=auto\n[ipv6]\nmethod=auto\nNMEOF\n  chmod 600 '/etc/NetworkManager/system-connections/${connName}.nmconnection'\nfi\n`;
  }

  // Timezone
  if (s.timezone) sc += `\nif [ -f /usr/lib/raspberrypi-sys-mods/imager_custom ]; then\n  /usr/lib/raspberrypi-sys-mods/imager_custom set_timezone '${shellEsc(s.timezone)}'\nelse\n  rm -f /etc/localtime\n  echo '${shellEsc(s.timezone)}' >/etc/timezone\n  dpkg-reconfigure -f noninteractive tzdata\nfi\n`;

  // Keyboard
  if (s.keyboardLayout) sc += `\nif [ -f /usr/lib/raspberrypi-sys-mods/imager_custom ]; then\n  /usr/lib/raspberrypi-sys-mods/imager_custom set_keymap '${shellEsc(s.keyboardLayout)}' '${shellEsc(s.keyboardLayout)}'\nfi\n`;

  // Cleanup
  sc += `\nrm -f /boot/firmware/firstrun.sh\nsed -i 's| systemd.run.*||g' /boot/firmware/cmdline.txt\nexit 0\n`;
  return sc;
}

// ==================== RPi Image Catalog ====================

let imageCache: any = null;
let imageCacheTime = 0;

async function getRpiImages() {
  if (imageCache && Date.now() - imageCacheTime < 3600000) return imageCache;
  try {
    const resp = await fetch("https://downloads.raspberrypi.com/os_list_imagingutility_v4.json");
    const data: any = await resp.json();
    imageCache = flattenImages(data.os_list || []);
    imageCacheTime = Date.now();
    return imageCache;
  } catch {
    return imageCache || [];
  }
}

function flattenImages(items: any[], category = ""): any[] {
  const r: any[] = [];
  for (const i of items) {
    if (i.subitems) r.push(...flattenImages(i.subitems, i.name));
    else if (i.url) r.push({ name: i.name, description: i.description || "", category, url: i.url, extractSize: i.extract_size || 0, downloadSize: i.image_download_size || 0, releaseDate: i.release_date || "", icon: i.icon || "" });
  }
  return r;
}

// ==================== Default Settings ====================

async function getDefaultSettings() {
  const tz = (await readSysFile("/etc/timezone")) || "UTC";
  let wifiSsid = "";
  try {
    const { out } = await run(["nmcli", "-t", "-f", "active,ssid", "dev", "wifi"]);
    const line = out.split("\n").find((l) => l.startsWith("yes:"));
    if (line) wifiSsid = line.split(":").slice(1).join(":");
  } catch {}
  return {
    hostname: "raspberrypi", username: "pi", password: "", enableSsh: true,
    sshKeys: [] as string[],
    wifiNetworks: wifiSsid ? [{ ssid: wifiSsid, password: "", country: "US", priority: 0 }] : [],
    timezone: tz, keyboardLayout: "us",
  };
}

// ==================== SSE ====================

const sseClients = new Set<ReadableStreamDefaultController>();

function broadcast(status: any) {
  const enc = new TextEncoder().encode(`data: ${JSON.stringify(status)}\n\n`);
  for (const c of sseClients) {
    try { c.enqueue(enc); } catch { sseClients.delete(c); }
  }
}

setInterval(async () => {
  if (sseClients.size === 0) return;
  try { broadcast(await getStatus()); } catch {}
}, 2000);

// ==================== API Docs ====================

const API_DOCS = {
  name: "DeskyPi API", version: "1.0", base: "http://deskypi.tsl",
  endpoints: {
    "GET /api": "This documentation",
    "GET /api/status": "System status snapshot (same data as SSE)",
    "GET /api/events": "SSE stream, sends status every ~2s",
    "POST /api/eject": { body: { device: "sdb" }, description: "Safely eject USB device (unmount, remove NFS/NBD, power off)" },
    "POST /api/erase": { body: { device: "sdb", mode: "quick|full|discard" }, description: "Erase device. Returns immediately; track via SSE. Queueable before flash." },
    "POST /api/flash": { body: { imageUrl: "https://...", extractSize: 0, device: "sdb", settings: {} }, description: "Flash RPi image. Can queue after erase." },
    "POST /api/scan": { body: { device: "sdb" }, description: "Re-read partition table and identify contents" },
    "POST /api/probe": { body: { device: "sdb" }, description: "Fast sampled raw-sector probe. Reads ~1MB spread across the device (denser in unallocated gaps), classifies each block as zero/ones/text/compressed/structured and reports file signatures. Seconds." },
    "POST /api/deepscan": { body: { device: "sdb" }, description: "Exhaustive raw scan for file signatures across the whole device. Tracked like erase/flash: progress via SSE, cancellable." },
    "GET /api/scanresult?device=sdb": "Findings from the last deep scan of a device",
    "POST /api/cancel": { body: { operationId: "uuid" }, description: "Cancel active operation" },
    "GET /api/images": "Official RPi OS image catalog (cached 1hr)",
    "GET /api/defaults": "Saved default flash settings",
    "POST /api/defaults": "Save default flash settings",
  },
  examples: {
    eject: 'curl -X POST http://deskypi.tsl/api/eject -H "Content-Type: application/json" -d \'{"device":"sdb"}\'',
    status: "curl -s http://deskypi.tsl/api/status | jq '.drives'",
    list_exports: "curl -s http://deskypi.tsl/api/status | jq '.nbdExports'",
  },
};

// ==================== HTTP Server ====================

// ==================== Build Versioning ====================
//
// The dashboard is a long-lived page held open for hours, so a deploy would otherwise
// leave a stale UI talking to a newer backend. The version is substituted into the page
// at serve time, so a client always knows exactly which build it is running, rather than
// inferring it from the first status message it happens to see (which would be the *new*
// version for anyone connecting mid-deploy).
//
// It hashes every file whose content defines the running app, not just index.html: a
// server.ts-only deploy leaves index.html byte-identical, so hashing the page alone would
// let an open dashboard keep talking to a changed API forever.

const UI_PATH = import.meta.dir + "/index.html";

// UI_PATH must stay first — getBuild() serves texts[0] as the page.
// defaults.json is deliberately excluded: it is user data, rewritten every time flash
// settings are saved, and would cause a spurious reload on each save.
const BUILD_FILES = [UI_PATH, import.meta.dir + "/server.ts"];

let buildCache: { stamp: string; version: string; html: string } | null = null;

async function getBuild(): Promise<{ version: string; html: string }> {
  const files = BUILD_FILES.map((p) => Bun.file(p));
  // Cheap staleness check so a git pull is picked up without a restart.
  const stamp = files.map((f) => `${f.lastModified}:${f.size}`).join("|");
  if (!buildCache || buildCache.stamp !== stamp) {
    const texts = await Promise.all(files.map((f) => f.text().catch(() => "")));
    // Hash the sources as stored, before substitution, so the value is stable rather
    // than self-referential.
    const version = Bun.hash(texts.join(" ")).toString(16);
    buildCache = { stamp, version, html: texts[0].replaceAll("__BUILD_VERSION__", version) };
  }
  return buildCache;
}

Bun.serve({
  port: PORT, hostname: "::",
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    // no-cache (revalidate every load), not no-store — otherwise a deploy is invisible
    // until the user knows to hard-refresh. The ETag keeps revalidation cheap.
    if (p === "/" || p === "/index.html") {
      const ui = await getBuild();
      const etag = `"${ui.version}"`;
      const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ETag: etag };
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
      return new Response(ui.html, { headers });
    }
    if (p === "/api" || p === "/api/") return Response.json(API_DOCS);
    if (p === "/api/status") return Response.json(await getStatus());

    if (p === "/api/events") {
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) { ctrl = c; sseClients.add(c); getStatus().then((s) => { try { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(s)}\n\n`)); } catch {} }); },
        cancel() { sseClients.delete(ctrl); },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    }

    if (p === "/api/eject" && req.method === "POST") {
      const { device } = await req.json();
      if (!device || isSysDev(device)) return Response.json({ ok: false, message: "Invalid device" }, { status: 400 });
      if (isDeviceBusy(device)) return Response.json({ ok: false, message: "Device busy" }, { status: 409 });
      return Response.json(await ejectDevice(device));
    }

    if (p === "/api/erase" && req.method === "POST") {
      const { device, mode } = await req.json();
      if (!device || isSysDev(device)) return Response.json({ ok: false, message: "Invalid device" }, { status: 400 });
      if (isDeviceBusy(device)) return Response.json({ ok: false, message: "Device busy" }, { status: 409 });
      const op: Operation = { id: crypto.randomUUID(), type: "erase", device, status: "starting", progress: 0, message: "Starting...", mode: mode || "quick" };
      enqueue(op);
      return Response.json({ ok: true, message: "Erase started" });
    }

    if (p === "/api/flash" && req.method === "POST") {
      const { imageUrl, imageName, extractSize, device, settings } = await req.json();
      if (!device || isSysDev(device)) return Response.json({ ok: false, message: "Invalid device" }, { status: 400 });
      if (!imageUrl) return Response.json({ ok: false, message: "No image URL" }, { status: 400 });
      // Allow queueing after erase, but not if already queued or non-erase is running
      const ops = getOpsForDevice(device);
      const nonEraseRunning = ops.some((o) => !["done", "error", "queued"].includes(o.status) && o.type !== "erase");
      const alreadyQueued = ops.some((o) => o.status === "queued");
      if (nonEraseRunning || alreadyQueued) return Response.json({ ok: false, message: "Device busy" }, { status: 409 });
      const op: Operation = { id: crypto.randomUUID(), type: "flash", device, status: "starting", progress: 0, message: "Starting...", imageUrl, imageName, extractSize, settings };
      enqueue(op);
      return Response.json({ ok: true, message: hasQueuedFlash(device) ? "Flash queued after erase" : "Flash started" });
    }

    if (p === "/api/scan" && req.method === "POST") {
      const { device } = await req.json();
      if (!device || isSysDev(device)) return Response.json({ ok: false, message: "Invalid device" }, { status: 400 });
      return Response.json(await scanDevice(device));
    }

    if (p === "/api/probe" && req.method === "POST") {
      const { device } = await req.json();
      if (!device || isSysDev(device)) return Response.json({ ok: false, message: "Invalid device" }, { status: 400 });
      return Response.json(await probeDevice(device));
    }

    if (p === "/api/deepscan" && req.method === "POST") {
      const { device } = await req.json();
      if (!device || isSysDev(device)) return Response.json({ ok: false, message: "Invalid device" }, { status: 400 });
      if (isDeviceBusy(device)) return Response.json({ ok: false, message: "Device busy" }, { status: 409 });
      const op: Operation = { id: crypto.randomUUID(), type: "deepscan", device, status: "starting", progress: 0, message: "Starting..." };
      enqueue(op);
      return Response.json({ ok: true, message: "Deep scan started", operationId: op.id });
    }

    if (p === "/api/scanresult") {
      const device = url.searchParams.get("device") || "";
      const r = lastScanResults.get(device);
      return Response.json(r ? { ok: true, ...r } : { ok: false, message: "No deep scan result for this device" });
    }

    if (p === "/api/cancel" && req.method === "POST") {
      const { operationId } = await req.json();
      const all = getAllOps();
      const op = all.find((o) => o.id === operationId);
      if (op) { op.aborted = true; op.process?.kill(); op.status = "error"; op.message = "Cancelled"; }
      return Response.json({ ok: true });
    }

    if (p === "/api/images") return Response.json(await getRpiImages());
    if (p === "/api/defaults") {
      if (req.method === "GET") { try { return Response.json(await Bun.file(DEFAULTS_PATH).json()); } catch { return Response.json(await getDefaultSettings()); } }
      if (req.method === "POST") { await Bun.write(DEFAULTS_PATH, JSON.stringify(await req.json(), null, 2)); return Response.json({ ok: true }); }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`DeskyPi running on http://[::]:${PORT} (dual-stack: IPv6 + IPv4)`);
