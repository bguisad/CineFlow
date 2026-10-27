const dgram = require('node:dgram');
const http = require('node:http');
const { execFile } = require('node:child_process');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'upnp:rootdevice',
  'ssdp:all'
];
const PROBE_INTERVAL_MS = 1500;
const PROBE_MAX_ROUNDS = 4;
const DEVICE_TTL_MS = 26000;
const BLUETOOTH_CACHE_MS = 15000;

const DISPLAY_KEYWORDS = [
  '无线显示器', '显示器', '投屏', '镜像', '电视', '智慧屏', '接收器', '机顶盒', '盒子',
  'miracast', 'wireless display', 'wireless monitor', 'wfd', 'cast', 'display', 'screen',
  'mirror', 'receiver', 'smart tv', 'beacon', 'vision'
];
const DOCK_KEYWORDS = [
  '扩展坞', '坞站', '底座', '集线器', '转换器',
  'dock', 'docking', 'hub', 'cradle', 'port replicator'
];
const EXCLUDED_KEYWORDS = [
  '耳机', '耳麦', '耳塞', '音箱', '音响', '回音壁', '键盘', '鼠标', '触控板', '触摸板',
  '手柄', '游戏', '控制器', '手机', '平板', '手表', '手环', '打印', '扫描', '车载', '遥控',
  'headset', 'headphone', 'earbud', 'earphone', 'airpod', 'speaker', 'soundbar', 'audio',
  'keyboard', 'mouse', 'touchpad', 'trackpad', 'gamepad', 'joystick', 'controller',
  'xbox', 'playstation', 'ps4', 'ps5', 'nintendo', 'phone', 'watch', 'band', 'watch',
  'printer', 'scanner', 'remote', 'touch'
];

function classifyBluetoothDevice(...values) {
  const text = values.filter(Boolean).join(' ').toLowerCase();
  if (!text.trim()) return 'other';
  if (EXCLUDED_KEYWORDS.some((keyword) => text.includes(keyword))) return 'other';
  if (DOCK_KEYWORDS.some((keyword) => text.includes(keyword))) return 'dock';
  if (DISPLAY_KEYWORDS.some((keyword) => text.includes(keyword))) return 'display';
  return 'other';
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fetchText(url, timeoutMs = 1800, maxBytes = 262144) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let size = 0;
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        size += chunk.length;
        body += chunk;
        if (size > maxBytes) {
          settled = true;
          request.destroy();
          reject(new Error('response too large'));
          response.resume();
        }
      });
      response.on('end', () => {
        if (!settled) resolve(body);
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function soapRequest(controlUrl, serviceType, action, args) {
  return new Promise((resolve, reject) => {
    try {
      const body = `<?xml version="1.0" encoding="utf-8"?>`
        + `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">`
        + `<s:Body><u:${action} xmlns:u="${serviceType}">`
        + Object.entries(args).map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`).join('')
        + `</u:${action}></s:Body></s:Envelope>`;

      const target = new URL(controlUrl);
      const request = http.request({
        method: 'POST',
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        timeout: 4000,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"${serviceType}#${action}"`,
          'Content-Length': Buffer.byteLength(body)
        }
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => {
          if ((response.statusCode || 0) >= 400) {
            reject(new Error(`${action} 失败 (${response.statusCode})`));
            return;
          }
          resolve(text);
        });
      });
      request.on('timeout', () => request.destroy(new Error('投屏设备无响应')));
      request.on('error', reject);
      request.end(body);
    } catch (error) {
      reject(error);
    }
  });
}

function parseDeviceDescription(xml, location) {
  const pick = (tag, source = xml) => {
    const match = source.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? match[1].trim() : '';
  };
  const avBlock = xml.match(/<service>([\s\S]*?)<\/service>/gi) || [];
  let controlUrl = '';
  for (const block of avBlock) {
    if (/AVTransport\/1/.test(block)) {
      controlUrl = pick('controlURL', block);
      break;
    }
  }
  if (!controlUrl) return null;
  const base = new URL(location);
  const absolute = new URL(controlUrl.startsWith('/') ? controlUrl : `/${controlUrl}`, base).toString();
  const udn = pick('UDN') || `uuid:${base.host}`;
  return {
    udn,
    name: pick('friendlyName') || base.hostname,
    hostName: base.hostname,
    modelName: pick('modelDescription') || pick('modelName'),
    controlUrl: absolute,
    serviceType: 'urn:schemas-upnp-org:service:AVTransport:1',
    location
  };
}

function parseSsdpHeaders(message) {
  const text = String(message);
  const headers = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).trim().toUpperCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function createCastController({ isWin32 = process.platform === 'win32', getSender, openBluetoothSettings } = {}) {
  const devices = new Map();
  const locationIndex = new Map();
  let socket = null;
  let probeTimer = null;
  let probeRound = 0;
  let bluetoothCache = { at: 0, supported: false, devices: [] };

  const send = (payload) => {
    try {
      const sender = getSender?.();
      if (!sender || sender.isDestroyed?.()) return;
      sender.send('cast:devices', snapshot());
    } catch {

    }
  };

  function snapshot() {
    const now = Date.now();
    for (const [udn, device] of devices) {
      if (device.discoveredAt && now - device.discoveredAt > DEVICE_TTL_MS && !device.pinned) devices.delete(udn);
    }
    return {
      searching: probeRound > 0 && probeRound < PROBE_MAX_ROUNDS,
      dlna: [...devices.values()].map((device) => ({
        udn: device.udn,
        name: device.name,
        hostName: device.hostName,
        modelName: device.modelName,
        online: now - (device.discoveredAt || 0) < DEVICE_TTL_MS,
        casting: Boolean(device.casting),
        kind: 'dlna'
      })),
      bluetooth: bluetoothCache.devices,
      bluetoothSupported: bluetoothCache.supported
    };
  }

  async function registerLocation(location) {
    if (!location || locationIndex.has(location)) {
      const udn = locationIndex.get(location);
      if (udn && devices.has(udn)) devices.get(udn).discoveredAt = Date.now();
      if (udn) send();
      return;
    }
    try {
      const xml = await fetchText(location);
      const parsed = parseDeviceDescription(xml, location);
      if (!parsed) return;
      locationIndex.set(location, parsed.udn);
      const previous = devices.get(parsed.udn) || {};
      devices.set(parsed.udn, { ...previous, ...parsed, discoveredAt: Date.now() });
      send();
    } catch {

    }
  }

  function ensureSocket() {
    if (socket) return socket;
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (buffer) => {
      const headers = parseSsdpHeaders(buffer);
      const nts = (headers.NTS || '').toLowerCase();
      const location = headers.LOCATION || '';
      if (nts === 'ssdp:byebye') {
        const udn = locationIndex.get(location);
        if (udn && devices.has(udn)) {
          devices.get(udn).discoveredAt = 0;
          send();
        }
        return;
      }
      if (!/^https?:/i.test(location)) return;
      if (!/mediarenderer|MediaRenderer:1|rootdevice/i.test(headers.ST || headers.NT || '') && !/\.xml|\/description/i.test(location)) return;
      registerLocation(location);
    });
    socket.on('error', () => {
      try {
        socket.close();
      } catch {

      }
      socket = null;
    });
    try {
      socket.bind(0, () => {
        try {
          socket.setMulticastTTL(4);
          socket.addMembership(SSDP_ADDRESS);
        } catch {

        }
      });
    } catch {
      socket = null;
    }
    return socket;
  }

  function probe() {
    const active = ensureSocket();
    if (!active) return;
    for (const target of SEARCH_TARGETS) {
      const message = [
        'M-SEARCH * HTTP/1.1',
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
        `MAN: "ssdp:discover"`,
        'MX: 2',
        `ST: ${target}`,
        '',
        ''
      ].join('\r\n');
      const packet = Buffer.from(message, 'utf8');
      try {
        active.send(packet, 0, packet.length, SSDP_PORT, SSDP_ADDRESS, () => {});
      } catch {

      }
    }
  }

  function startScan() {
    probeRound = 0;
    if (probeTimer) clearInterval(probeTimer);
    probeTimer = setInterval(() => {
      probeRound += 1;
      probe();
      refreshBluetooth();
      if (probeRound >= PROBE_MAX_ROUNDS) {
        clearInterval(probeTimer);
        probeTimer = null;
        probeRound = 0;
      }
      send();
    }, PROBE_INTERVAL_MS);
    probe();
    refreshBluetooth();
    send();
    return snapshot();
  }

  function stopScan() {
    if (probeTimer) clearInterval(probeTimer);
    probeTimer = null;
    probeRound = 0;
    send();
  }

  function getDevice(ref) {
    if (!ref) return null;
    if (ref.udn && devices.has(ref.udn)) return devices.get(ref.udn);
    for (const device of devices.values()) {
      if (device.controlUrl && device.controlUrl === ref.controlUrl) return device;
    }
    return typeof ref === 'string' ? null : { ...ref };
  }

  async function castTo(ref, url, title = '') {
    const device = getDevice(ref);
    if (!device?.controlUrl || !device.serviceType) throw new Error('设备不支持 DLNA 投屏');
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('播放地址无法外发给设备');

    const metadata = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${escapeXml(title || 'CineFlow')}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:*:*">${escapeXml(url)}</res></item></DIDL-Lite>`;

    await soapRequest(device.controlUrl, device.serviceType, 'SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: url,
      CurrentMetadata: metadata
    });
    await soapRequest(device.controlUrl, device.serviceType, 'Play', { InstanceID: '0', Speed: '1' });
    device.casting = true;
    device.discoveredAt = Date.now();
    send();
    return { ok: true, name: device.name };
  }

  async function stopCast(ref) {
    const device = getDevice(ref);
    if (!device?.controlUrl) return { ok: false };
    try {
      await soapRequest(device.controlUrl, device.serviceType, 'Stop', { InstanceID: '0' });
    } catch {

      try {
        await soapRequest(device.controlUrl, device.serviceType, 'Pause', { InstanceID: '0' });
      } catch {

      }
    }
    device.casting = false;
    send();
    return { ok: true, name: device.name };
  }

  function refreshBluetooth(force = false) {
    if (!isWin32) {
      bluetoothCache = { at: Date.now(), supported: false, devices: [] };
      return Promise.resolve(bluetoothCache);
    }
    if (!force && Date.now() - bluetoothCache.at < BLUETOOTH_CACHE_MS) {
      return Promise.resolve(bluetoothCache);
    }
    return new Promise((resolve) => {

      const command = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$ErrorActionPreference="SilentlyContinue";'
        + "$d = Get-CimInstance -ClassName Win32_PnPEntity -Filter 'PNPClass=\"Bluetooth\"'"
        + ' | Select-Object -First 80 Name,Manufacturer,Status;'
        + ' if (-not $d) { $d = Get-PnpDevice -Class Bluetooth'
        + ' | Select-Object -First 80 @{n="Name";e={$_.FriendlyName}},@{n="Manufacturer";e={$_.Manufacturer}},Status };'
        + ' $d | ConvertTo-Json -Compress';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        timeout: 9000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      }, (error, stdout) => {
        const found = [];
        if (!error && stdout) {
          try {
            const parsed = JSON.parse(stdout.trim().startsWith('[') ? stdout : `[${stdout}]`);
            for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
              const name = String((item && (item.Name || item.FriendlyName)) || '');
              if (!name) continue;
              const manufacturer = String((item && item.Manufacturer) || '');
              found.push({
                name,
                manufacturer,
                status: String((item && item.Status) || 'Unknown'),
                id: String((item && (item.DeviceID || item.InstanceId)) || name),
                connected: String((item && item.Status) || '').toUpperCase() === 'OK',
                category: classifyBluetoothDevice(name, manufacturer),
                kind: 'bluetooth'
              });
            }
          } catch {

          }
        }
        found.sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
        bluetoothCache = {
          at: Date.now(),
          supported: true,
          devices: found.length ? found : bluetoothCache.devices
        };
        send();
        resolve(bluetoothCache);
      });
    });
  }

  function publishBluetoothDiscovered(candidates = []) {
    let added = 0;
    for (const candidate of candidates) {
      const name = candidate?.name || candidate?.localName;
      const id = candidate?.id || candidate?.deviceId;
      if (!name && !id) continue;
      const exists = bluetoothCache.devices.some((item) => (item.id && item.id === id) || (item.name && item.name === name));
      if (exists) continue;
      bluetoothCache.devices.push({
        name: name || id,
        manufacturer: '',
        status: 'Discovering',
        id: String(id || name),
        connected: false,
        category: classifyBluetoothDevice(name, id),
        kind: 'bluetooth'
      });
      added += 1;
    }
    if (added) {
      bluetoothCache.supported = true;
      bluetoothCache.at = Date.now();
      send();
    }
    return added;
  }

  return {
    snapshot,
    startScan,
    stopScan,
    castTo,
    stopCast,
    refreshBluetooth,
    publishBluetoothDiscovered,
    openBluetoothSettings: () => {
      try {
        openBluetoothSettings?.();
        return { ok: true };
      } catch {
        return { ok: false };
      }
    }
  };
}

module.exports = { createCastController };
