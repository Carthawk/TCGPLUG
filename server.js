// The TCG Plug – TikTok Shop koppeling
// Haalt betaalde TikTok Shop-bestellingen op en zet ze live in de wachtrij van het kluis-dashboard.
// Starten: dubbelklik op start.bat  →  dashboard: http://localhost:3000  →  instellingen: http://localhost:3000/setup

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import https from "node:https";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "data");
const PORT = 3000;
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "version.json"), "utf8")).version;
const API = "https://open-api.tiktokglobalshop.com";
const AUTH = "https://auth.tiktok-shops.com";
const POLL_MS = 5000;
const PAID = new Set(["ON_HOLD", "AWAITING_SHIPMENT", "PARTIALLY_SHIPPING", "AWAITING_COLLECTION", "IN_TRANSIT", "DELIVERED", "COMPLETED"]);

fs.mkdirSync(DATA, { recursive: true });
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch { return d; } };
const writeJSON = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 2));
const log = (...a) => console.log(new Date().toLocaleTimeString("nl-NL"), "|", ...a);

let config = readJSON("config.json", { appKey: "", appSecret: "", tiktokUsername: "", productAliases: {} });
let tokens = readJSON("tokens.json", null);
let seen = new Set(readJSON("seen.json", []));
const userNames = new Map(Object.entries(readJSON("names.json", {}))); // TikTok userId → @naam

let status = { ok: false, text: "nog niet gekoppeld" };
const clients = new Set();
const pending = []; // bestellingen die binnenkwamen terwijl het dashboard dicht was

// ---------- Live-verbinding met het dashboard (Server-Sent Events) ----------
function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const c of clients) send(c, event, data); }
function setStatus(ok, text) {
  if (status.ok === ok && status.text === text) return;
  status = { ok, text }; broadcast("status", status); log("Status:", text);
}
function pushOrder(order) {
  if (clients.size) broadcast("order", order); else pending.push(order);
  log(`🛒 ${order.name} – ${order.product}`);
}

// ---------- TikTok Shop API ----------
function sign(pathname, params, body) {
  const keys = Object.keys(params).filter(k => k !== "sign" && k !== "access_token").sort();
  let input = pathname + keys.map(k => k + params[k]).join("");
  if (body) input += body;
  input = config.appSecret + input + config.appSecret;
  return crypto.createHmac("sha256", config.appSecret).update(input).digest("hex");
}

async function api(method, pathname, query = {}, bodyObj = null) {
  await ensureToken();
  const params = { app_key: config.appKey, timestamp: Math.floor(Date.now() / 1000), ...query };
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  params.sign = sign(pathname, params, body);
  const url = API + pathname + "?" + new URLSearchParams(params);
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-tts-access-token": tokens.access_token },
    body: body || undefined
  });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) throw new Error(`TikTok API ${pathname}: ${json.code} ${json.message || res.status}`);
  return json.data;
}

async function tokenRequest(params) {
  const url = AUTH + "/api/v2/token/get?" + new URLSearchParams({ app_key: config.appKey, app_secret: config.appSecret, ...params });
  const json = await (await fetch(url)).json();
  if (json.code !== 0) throw new Error(`Token: ${json.code} ${json.message}`);
  const d = json.data;
  tokens = { ...tokens, access_token: d.access_token, access_expire: d.access_token_expire_in, refresh_token: d.refresh_token, refresh_expire: d.refresh_token_expire_in, seller: d.seller_name };
  writeJSON("tokens.json", tokens);
}

async function exchangeCode(code) {
  await tokenRequest({ auth_code: code, grant_type: "authorized_code" });
  tokens.shop_cipher = null; writeJSON("tokens.json", tokens);
  log("Winkel gekoppeld:", tokens.seller || "(onbekende naam)");
}

async function ensureToken() {
  if (!tokens?.access_token) throw new Error("Nog niet gekoppeld: open http://localhost:3000/setup");
  const now = Math.floor(Date.now() / 1000);
  if (tokens.access_expire && tokens.access_expire - now < 3600) {
    await tokenRequest({ refresh_token: tokens.refresh_token, grant_type: "refresh_token" });
    log("Toegangssleutel ververst");
  }
}

async function ensureShop() {
  if (tokens.shop_cipher) return;
  const data = await api("GET", "/authorization/202309/shops");
  const shop = (data.shops || [])[0];
  if (!shop) throw new Error("Geen winkel gevonden bij deze koppeling");
  tokens.shop_cipher = shop.cipher; tokens.shop_name = shop.name; writeJSON("tokens.json", tokens);
}

function shortName(name) {
  for (const [needle, short] of Object.entries(config.productAliases || {})) {
    if (needle && name.toLowerCase().includes(needle.toLowerCase())) return short;
  }
  return name;
}

function describe(order) {
  const counts = new Map();
  for (const li of order.line_items || []) {
    const n = shortName([li.product_name, li.sku_name && li.sku_name !== "Default" ? li.sku_name : ""].filter(Boolean).join(" – "));
    counts.set(n, (counts.get(n) || 0) + (Number(li.quantity) || 1));
  }
  return [...counts].map(([n, q]) => (q > 1 ? `${q}× ` : "") + n).join("\n");
}

function buyerName(order) {
  const fromChat = userNames.get(String(order.user_id));
  if (fromChat) return fromChat;
  const a = order.recipient_address || {};
  const n = (a.first_name || a.name || "").trim();
  if (n && !/\*/.test(n)) return n;
  return "TikTok-koper " + String(order.id).slice(-4);
}

// ---------- Shopify (alle bestellingen: TikTok + webshop) ----------
const SHOPIFY_VERSION = "2026-04";
let shopToken = null, shopTokenExp = 0;
const shopHost = () => String(config.shopifyShop || "").trim().replace(/^https?:\/\//, "").replace(/\.myshopify\.com.*$/, "").replace(/\/.*$/, "") + ".myshopify.com";
const shopifyOn = () => !!(config.shopifyShop && (config.shopifyToken || (config.shopifyClientId && config.shopifyClientSecret)));
async function shopifyToken() {
  if (config.shopifyToken) return config.shopifyToken; // oude (legacy) custom app met vaste sleutel
  if (shopToken && Date.now() < shopTokenExp - 10 * 60 * 1000) return shopToken;
  const res = await fetch(`https://${shopHost()}/admin/oauth/access_token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: config.shopifyClientId, client_secret: config.shopifyClientSecret })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error("Shopify-sleutel ophalen mislukt (" + res.status + "): " + JSON.stringify(j).slice(0, 200));
  shopToken = j.access_token; shopTokenExp = Date.now() + (Number(j.expires_in) || 86400) * 1000;
  return shopToken;
}
async function shopifyGql(query, variables) {
  const res = await fetch(`https://${shopHost()}/admin/api/${SHOPIFY_VERSION}/graphql.json`, {
    method: "POST", headers: { "content-type": "application/json", "x-shopify-access-token": await shopifyToken() },
    body: JSON.stringify({ query, variables })
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401) { shopToken = null; }
  if (!res.ok || j.errors) throw new Error("Shopify " + res.status + ": " + JSON.stringify(j.errors || j).slice(0, 300));
  return j.data;
}
const ORDERS_Q = `query($q:String!){ orders(first:50, sortKey:CREATED_AT, reverse:true, query:$q){ nodes{
  id name createdAt sourceName tags note
  app{ name }
  channelInformation{ channelDefinition{ channelName handle } }
  customAttributes{ key value }
  customer{ firstName lastName displayName }
  billingAddress{ firstName } shippingAddress{ firstName }
  lineItems(first:30){ nodes{ title variantTitle quantity customAttributes{ key value } } }
} } }`;
// Voor welke stream is deze bestelling? Kijkt naar het verkoopkanaal (TikTok Shop) en naar de keuze
// die de klant in de webshop maakte (Whatnot of TikTok), waar die ook staat: extra velden, productopties, tags of notitie.
function streamOf(o) {
  if (isTikTok(o)) return "tiktok";
  const bits = [];
  for (const a of o.customAttributes || []) bits.push(a.key + " " + a.value);
  for (const li of o.lineItems?.nodes || []) { for (const a of li.customAttributes || []) bits.push(a.key + " " + a.value); if (li.variantTitle) bits.push(li.variantTitle); }
  bits.push(...(o.tags || []), o.note || "");
  const hay = bits.join(" | ");
  const tt = /tik ?tok/i.test(hay), wn = /what ?not/i.test(hay);
  if (tt && !wn) return "tiktok";
  if (wn && !tt) return "whatnot";
  return "onbekend";
}
function isTikTok(o) {
  const hay = [o.sourceName, o.app?.name, o.channelInformation?.channelDefinition?.channelName, o.channelInformation?.channelDefinition?.handle, ...(o.tags || [])].join(" ");
  return /tik ?tok/i.test(hay);
}
function shopifyProducts(o) {
  const counts = new Map();
  for (const li of o.lineItems?.nodes || []) {
    const n = shortName([li.title, li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : ""].filter(Boolean).join(" – "));
    counts.set(n, (counts.get(n) || 0) + (Number(li.quantity) || 1));
  }
  return [...counts].map(([n, q]) => (q > 1 ? `${q}\u00d7 ` : "") + n).join("\n") || "Bestelling";
}
let shopStarted = new Date(Date.now() - 15 * 60 * 1000).toISOString();
async function pollShopify() {
  try {
    const q = `created_at:>='${shopStarted}' financial_status:paid -status:cancelled`;
    const data = await shopifyGql(ORDERS_Q, { q });
    const orders = (data.orders?.nodes || []).slice().reverse();
    for (const o of orders) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      const tt = isTikTok(o);
      const stream = streamOf(o);
      if ((config.orderFilter || "tiktok") === "tiktok" && stream !== "tiktok") {
        log(`Overgeslagen: ${o.name} (${stream === "whatnot" ? "voor Whatnot" : "geen TikTok-keuze gevonden"})`);
        continue;
      }
      // Voornaam (als Shopify die meegeeft) + bestelnummer, voor TikTok- en webshop-bestellingen
      const first = String(o.customer?.firstName || o.shippingAddress?.firstName || o.billingAddress?.firstName || "").trim();
      const name = first ? `${first} \u00b7 ${o.name}` : `Bestelling ${o.name}`;
      pushOrder({ id: o.id, name, product: shopifyProducts(o), src: tt ? "tiktok" : "shopify" });
    }
    writeJSON("seen.json", [...seen].slice(-3000));
    setStatus(true, "Shopify verbonden");
  } catch (e) {
    setStatus(false, "Shopify: fout \u2013 zie het zwarte venster");
    log("\u26a0\ufe0f", e.message);
  }
}

let startedAt = Math.floor(Date.now() / 1000) - 15 * 60; // pak ook bestellingen van het laatste kwartier mee
async function poll() {
  if (shopifyOn()) return pollShopify();
  if (!config.appKey || !config.appSecret || !tokens?.access_token) { setStatus(false, "Shopify nog niet gekoppeld"); return; }
  try {
    await ensureShop();
    let pageToken = "", pages = 0;
    const since = Math.max(startedAt, Math.floor(Date.now() / 1000) - 6 * 3600);
    do {
      const q = { shop_cipher: tokens.shop_cipher, page_size: 50, sort_field: "create_time", sort_order: "ASC" };
      if (pageToken) q.page_token = pageToken;
      const data = await api("POST", "/order/202309/orders/search", q, { create_time_ge: since });
      for (const o of data.orders || []) {
        if (seen.has(o.id) || !PAID.has(o.status)) continue;
        seen.add(o.id);
        if (!userNames.has(String(o.user_id))) log(`Koper-ID ${o.user_id} nog niet gezien in de chat (bestelling ${o.id})`);
        pushOrder({ id: o.id, name: buyerName(o), product: describe(o) || "TikTok Shop-bestelling" });
      }
      pageToken = data.next_page_token || "";
    } while (pageToken && ++pages < 5);
    writeJSON("seen.json", [...seen].slice(-3000));
    setStatus(true, `verbonden${tokens.shop_name ? " (" + tokens.shop_name + ")" : ""}`);
  } catch (e) {
    setStatus(false, "fout – zie het zwarte venster");
    log("⚠️", e.message);
  }
}

// ---------- Live-chat: koppel koper-ID aan TikTok-naam ----------
let live = null, liveRetry = null, namesDirty = false, testCount = 0;
const chatLog = []; // laatste berichten uit de live-chat, voor als het dashboard later opent
let chatState = { ok: false, text: "live-chat niet verbonden" };
function pushChat(item) {
  item.ts = Date.now();
  chatLog.push(item); if (chatLog.length > 150) chatLog.shift();
  broadcast("chat", item);
}
function setChatState(ok, text) { chatState = { ok, text }; broadcast("chatstatus", chatState); }
const chatName = u => (u?.nickname || (u?.uniqueId ? "@" + u.uniqueId : "Kijker"));
setInterval(() => { if (namesDirty) { writeJSON("names.json", Object.fromEntries([...userNames].slice(-20000))); namesDirty = false; } }, 15000);
async function startLive() {
  clearTimeout(liveRetry);
  if (live) { try { await live.disconnect(); } catch {} live = null; }
  if (!config.tiktokUsername) { setChatState(false, "vul de TikTok-naam in bij instellingen"); return; }
  let mod;
  try { mod = await import("tiktok-live-connector"); } catch { log("Chat-koppeling niet geïnstalleerd (npm install)"); return; }
  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = mod;
  live = new TikTokLiveConnection(config.tiktokUsername, { processInitialData: false });
  const remember = u => {
    if (!u?.userId) return;
    const name = u.uniqueId ? "@" + u.uniqueId : u.nickname;
    if (name && userNames.get(String(u.userId)) !== name) { userNames.set(String(u.userId), name); namesDirty = true; }
  };
  for (const ev of [WebcastEvent.CHAT, WebcastEvent.MEMBER, WebcastEvent.LIKE, WebcastEvent.GIFT, WebcastEvent.SOCIAL, WebcastEvent.FOLLOW, WebcastEvent.SHARE]) {
    if (ev) live.on(ev, d => remember(d.user));
  }
  // Live-chat doorsturen naar het dashboard
  live.on(WebcastEvent.CHAT, d => {
    const text = String(d?.comment ?? d?.content ?? "").trim();
    log(`\ud83d\udcac ${chatName(d?.user)}: ${text || "(leeg)"}`);
    if (text) pushChat({ k: "chat", u: chatName(d.user), id: d.user?.uniqueId || "", text });
  });
  if (WebcastEvent.EMOTE) live.on(WebcastEvent.EMOTE, d => pushChat({ k: "chat", u: chatName(d?.user), id: d?.user?.uniqueId || "", text: "stuurt een sticker" }));
  // Overzicht welke soorten berichten TikTok stuurt (om problemen te zien)
  const typeCount = {};
  if (ControlEvent.DECODED_DATA) live.on(ControlEvent.DECODED_DATA, (type) => { const k = typeof type === "string" ? type : (type?.type || "onbekend"); typeCount[k] = (typeCount[k] || 0) + 1; });
  const tc = setInterval(() => { const e = Object.entries(typeCount); if (e.length) { log("Live-berichten afgelopen minuut: " + e.map(([k, v]) => k.replace("Webcast", "") + " " + v).join(", ")); for (const k in typeCount) delete typeCount[k]; } }, 60000);
  live.on(ControlEvent.DISCONNECTED, () => clearInterval(tc));
  live.on(WebcastEvent.GIFT, d => {
    const type = d?.giftDetails?.giftType, name = d?.giftDetails?.giftName || "een gift";
    if (type === 1 && !d.repeatEnd) return;
    pushChat({ k: "gift", u: chatName(d.user), id: d.user?.uniqueId || "", text: "stuurt " + (d.repeatCount > 1 ? d.repeatCount + "× " : "") + name });
  });
  if (WebcastEvent.FOLLOW) live.on(WebcastEvent.FOLLOW, d => pushChat({ k: "follow", u: chatName(d.user), id: d.user?.uniqueId || "", text: "volgt nu" }));
  if (WebcastEvent.SHARE) live.on(WebcastEvent.SHARE, d => pushChat({ k: "share", u: chatName(d.user), id: d.user?.uniqueId || "", text: "deelt de live" }));
  if (WebcastEvent.MEMBER) live.on(WebcastEvent.MEMBER, d => pushChat({ k: "join", u: chatName(d.user), id: d.user?.uniqueId || "", text: "komt binnen" }));
  // Ter controle: winkel-meldingen uit de live bewaren, zodat we kunnen zien wat TikTok meestuurt.
  if (WebcastEvent.OEC_LIVE_SHOPPING) live.on(WebcastEvent.OEC_LIVE_SHOPPING, d => {
    fs.appendFile(path.join(DATA, "live-shopping-log.jsonl"), JSON.stringify(d) + "\n", () => {});
  });
  live.on(ControlEvent.DISCONNECTED, () => { setChatState(false, "live-chat verbroken, opnieuw verbinden…"); log("Live-chat verbroken, opnieuw proberen over 60 s"); liveRetry = setTimeout(startLive, 60000); });
  try { await live.connect(); setChatState(true, "@" + config.tiktokUsername + " live"); log(`Live-chat van @${config.tiktokUsername} verbonden`); }
  catch (e) { setChatState(false, "nog niet live – opnieuw proberen…"); log("Live-chat nog niet live of niet bereikbaar, opnieuw over 60 s:", e.message || e); liveRetry = setTimeout(startLive, 60000); }
}

// ---------- Labels printen via DYMO Connect ----------
// DYMO Connect draait een printservice op deze computer (dezelfde die kassasystemen gebruiken).
// Het programma stuurt het label daar rechtstreeks naartoe: geen printvenster, geen Windows-printer nodig.
let dymoPort = null;
function dymoRequest(port, pathname, method = "GET", form = null) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : null;
    const req = https.request({ host: "127.0.0.1", port, path: pathname, method, rejectUnauthorized: false, timeout: 8000,
      headers: body ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {} }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => res.statusCode < 300 ? resolve(d) : reject(new Error("DYMO " + res.statusCode + ": " + d.slice(0, 300))));
    });
    req.on("timeout", () => req.destroy(new Error("DYMO reageert niet")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
async function dymo(pathname, method, form) {
  const ports = dymoPort ? [dymoPort, ...Array.from({ length: 10 }, (_, i) => 41951 + i).filter(p => p !== dymoPort)] : Array.from({ length: 10 }, (_, i) => 41951 + i);
  for (const port of ports) {
    try { const r = await dymoRequest(port, pathname, method, form); dymoPort = port; return r; }
    catch (e) {
      // Een foutmelding van DYMO zelf (bijv. 500) betekent dat de service er wel is: niet verder zoeken.
      if (/^DYMO \d/.test(e.message)) { dymoPort = port; throw e; }
    }
  }
  dymoPort = null;
  throw new Error("De printservice van DYMO Connect reageert niet. Herstart de computer, of start DYMO Connect één keer en sluit het weer.");
}
async function dymoPrinters() {
  let raw = await dymo("/DYMO/DLS/Printing/GetPrinters");
  try { raw = JSON.parse(raw); } catch {}
  const list = [];
  const re = /<(LabelWriterPrinter|LabelManagerPrinter|TapePrinter)[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(String(raw)))) {
    const get = t => ((m[2].match(new RegExp("<" + t + ">([\\s\\S]*?)</" + t + ">")) || [])[1] || "").trim();
    list.push({ name: get("Name"), model: get("ModelName"), connected: /true/i.test(get("IsConnected")), type: m[1] });
  }
  return list;
}
const xmlEsc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
function textObject(name, text, size, bold, x, y, w, h, align = "Left") {
  return `<ObjectInfo><TextObject><Name>${name}</Name><ForeColor Alpha="255" Red="0" Green="0" Blue="0" /><BackColor Alpha="0" Red="255" Green="255" Blue="255" />` +
    `<LinkedObjectName></LinkedObjectName><Rotation>Rotation0</Rotation><IsMirrored>False</IsMirrored><IsVariable>False</IsVariable>` +
    `<HorizontalAlignment>${align}</HorizontalAlignment><VerticalAlignment>Middle</VerticalAlignment><TextFitMode>ShrinkToFit</TextFitMode>` +
    `<UseFullFontHeight>True</UseFullFontHeight><Verticalized>False</Verticalized><StyledText><Element><String>${xmlEsc(text)}</String>` +
    `<Attributes><Font Family="Arial" Size="${size}" Bold="${bold ? "True" : "False"}" Italic="False" Underline="False" Strikeout="False" />` +
    `<ForeColor Alpha="255" Red="0" Green="0" Blue="0" /></Attributes></Element></StyledText></TextObject>` +
    `<Bounds X="${x}" Y="${y}" Width="${w}" Height="${h}" /></ObjectInfo>`;
}
// Label 11352 (54 x 25 mm), liggend. Maten in twips (1440 per inch).
function labelXml({ name, product, footer }) {
  // Instelbare verschuiving in millimeters (1 mm = ~56,7 twips), om de afwijking van de printer te corrigeren
  const dx = Math.round((Number(config.labelShiftX) || 0) * 56.7), dy = Math.round((Number(config.labelShiftY) || 0) * 56.7);
  return `<?xml version="1.0" encoding="utf-8"?><DieCutLabel Version="8.0" Units="twips"><PaperOrientation>Landscape</PaperOrientation>` +
    `<Id>ReturnAddressInt</Id><PaperName>${xmlEsc(config.dymoPaper || "11352 Return Address Int")}</PaperName>` +
    `<DrawCommands><RoundRectangle X="0" Y="0" Width="1440" Height="3060" Rx="90" Ry="90" /></DrawCommands>` +
    textObject("NAAM", name, 22, true, 110 + dx, 70 + dy, 2840, 540, "Center") +
    textObject("PRODUCT", product, 12, false, 110 + dx, 610 + dy, 2840, 490, "Center") +
    textObject("ONDER", footer, 6, false, 110 + dx, 1120 + dy, 2840, 230, "Center") +
    `</DieCutLabel>`;
}
async function printLabel({ name, product, no, shop }) {
  const printers = await dymoPrinters();
  // Voorkeur: zelf gekozen printer > verbonden LabelWriter > LabelWriter Wireless via USB (DYMO meldt die soms onterecht als niet verbonden)
  const pick = printers.find(p => config.dymoPrinter && p.name === config.dymoPrinter) ||
    printers.find(p => p.connected && /LabelWriter/i.test(p.name + p.model)) || printers.find(p => p.connected) ||
    printers.find(p => /^DYMO LabelWriter Wireless$/i.test(p.name)) ||
    printers.find(p => /LabelWriter/i.test(p.name) && !/ on |Kopie/i.test(p.name));
  if (!pick) throw new Error("Geen Dymo gevonden in DYMO Connect (" + printers.map(p => p.name).join(", ") + ")");
  const date = new Date().toLocaleDateString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric" });
  const footer = `${shop || "The TCG Plug"}   ·   ${date}   ·   #${no}`;
  const form = { printerName: pick.name, printParamsXml: "", labelXml: labelXml({ name, product, footer }), labelSetXml: "" };
  try { await dymo("/DYMO/DLS/Printing/PrintLabel", "POST", form); }
  catch (e) {
    // Bekende tijdelijke fout van DYMO Connect: één keer opnieuw proberen
    if (!/thread|busy|bezig/i.test(e.message)) throw e;
    log("DYMO was bezig, nog één poging…");
    await new Promise(r => setTimeout(r, 2000));
    await dymo("/DYMO/DLS/Printing/PrintLabel", "POST", form);
  }
  log(`🏷️ Label geprint op ${pick.name}: ${name} – ${product}`);
  return pick.name;
}

// ---------- Updates ----------
// Het update-adres wijst naar een map online (bijv. GitHub) met daarin version.json en de programmabestanden.
// version.json: { "version": "1.0.1", "notes": "...", "files": { "server.js": "<sha256>", "public/index.html": "<sha256>", ... } }
// Alleen bestanden uit die lijst worden vervangen; de map data (instellingen, sleutels) wordt nooit aangeraakt.
const DEFAULT_UPDATE_URL = "https://raw.githubusercontent.com/Carthawk/TCGPLUG/main/";
const updateBase = () => { const u = String(config.updateUrl || DEFAULT_UPDATE_URL).trim(); return u ? (u.endsWith("/") ? u : u + "/") : ""; };
const newer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
let updateInfo = { current: VERSION, latest: null, notes: "", available: false, error: null };
async function checkUpdate() {
  const base = updateBase();
  if (!base) { updateInfo = { current: VERSION, latest: null, notes: "", available: false, error: "Geen update-adres ingesteld" }; return updateInfo; }
  try {
    const res = await fetch(base + "version.json?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("version.json niet gevonden (" + res.status + ")");
    const m = await res.json();
    updateInfo = { current: VERSION, latest: m.version, notes: m.notes || "", available: newer(m.version, VERSION), error: null, manifest: m };
  } catch (e) { updateInfo = { current: VERSION, latest: null, notes: "", available: false, error: e.message }; }
  return updateInfo;
}
async function applyUpdate() {
  const info = await checkUpdate();
  if (!info.available) throw new Error(info.error || "Er is geen nieuwere versie");
  const base = updateBase(), files = info.manifest.files || {};
  const names = Object.keys(files).filter(f => !/^data\//.test(f) && !f.includes("..") && !path.isAbsolute(f));
  if (!names.length) throw new Error("Lege updatelijst");
  // 1. Alles eerst downloaden en controleren; pas als alles klopt wordt er iets vervangen
  const got = {};
  for (const f of names) {
    const res = await fetch(base + f + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(f + " downloaden mislukt (" + res.status + ")");
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    if (files[f] && files[f] !== hash) throw new Error(f + " is beschadigd gedownload (controlegetal klopt niet)");
    got[f] = buf;
  }
  // 2. Reservekopie van de huidige versie
  const backup = path.join(DIR, "reservekopie", VERSION);
  for (const f of names) {
    const src = path.join(DIR, f);
    if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(path.join(backup, f)), { recursive: true }); fs.copyFileSync(src, path.join(backup, f)); }
  }
  const vsrc = path.join(DIR, "version.json"); if (fs.existsSync(vsrc)) fs.copyFileSync(vsrc, path.join(backup, "version.json"));
  // 3. Nieuwe bestanden neerzetten
  const oldPkg = fs.existsSync(path.join(DIR, "package.json")) ? fs.readFileSync(path.join(DIR, "package.json"), "utf8") : "";
  for (const f of names) {
    const dst = path.join(DIR, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst + ".nieuw", got[f]);
    fs.renameSync(dst + ".nieuw", dst);
  }
  fs.writeFileSync(path.join(DIR, "version.json"), JSON.stringify(info.manifest, null, 2));
  // 4. Zijn de onderdelen veranderd? Dan opnieuw installeren bij de herstart
  if (got["package.json"] && got["package.json"].toString("utf8") !== oldPkg) {
    try { fs.rmSync(path.join(DIR, "node_modules"), { recursive: true, force: true }); } catch {}
  }
  log(`\u2705 Bijgewerkt van ${VERSION} naar ${info.latest}. Het programma start opnieuw\u2026`);
  return info.latest;
}

// ---------- Webserver ----------
const readBody = req => new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });
const html = (res, s, code = 200) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(s); };
const json = (res, v, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/" ) return html(res, fs.readFileSync(path.join(DIR, "public", "index.html"), "utf8"));
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(res); send(res, "status", status); send(res, "chatstatus", chatState); send(res, "chatlog", chatLog);
      while (pending.length) send(res, "order", pending.shift());
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (url.pathname === "/setup") return html(res, setupPage());
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code") || url.searchParams.get("auth_code");
      if (!code) return html(res, "<p>Geen code ontvangen.</p>", 400);
      await exchangeCode(code); await poll();
      res.writeHead(302, { location: "/setup?ok=1" }); return res.end();
    }
    if (url.pathname === "/api/config" && req.method === "POST") {
      const b = await readBody(req);
      const restartLive = b.tiktokUsername !== undefined && b.tiktokUsername !== config.tiktokUsername;
      config = { ...config, ...b, tiktokUsername: String(b.tiktokUsername ?? config.tiktokUsername ?? "").replace(/^@/, "").trim() };
      writeJSON("config.json", config);
      shopToken = null;
      if (restartLive) startLive();
      poll();
      return json(res, { ok: true });
    }
    if (url.pathname === "/api/code" && req.method === "POST") {
      const b = await readBody(req);
      let code = String(b.code || "").trim();
      const m = code.match(/[?&](?:auth_)?code=([^&]+)/); if (m) code = decodeURIComponent(m[1]);
      await exchangeCode(code); await poll();
      return json(res, { ok: true, seller: tokens.seller });
    }
    if (url.pathname === "/api/testchat" && req.method === "POST") {
      const demo = [["join", "Sanne", "komt binnen"], ["join", "PokeJan", "komt binnen"], ["chat", "PokeJan", "Wanneer gaat de kluis open? 👀"], ["gift", "Ronnie69", "stuurt 5× Rose"], ["follow", "Anouk", "volgt nu"], ["join", "Mila_TCG", "komt binnen"], ["chat", "TCGTOM", "2+1 kluis voor mij!"]];
      demo.forEach((m, i) => setTimeout(() => pushChat({ k: m[0], u: m[1], id: m[1].toLowerCase(), text: m[2] }), i * 400));
      return json(res, { ok: true });
    }
    if (url.pathname === "/api/test" && req.method === "POST") {
      const id = "TEST-" + Date.now();
      const tt = (testCount = (testCount || 0) + 1) % 2 === 1;
      pushOrder({ id, name: (tt ? "Sanne" : "Jan") + " \u00b7 #10" + id.slice(-2), product: tt ? "30th Celebration bundel" : "30th Celebration bundel\n2\u00d7 Booster pack Ascended Heroes", src: tt ? "tiktok" : "shopify" });
      return json(res, { ok: true });
    }
    if (url.pathname === "/api/print" && req.method === "POST") {
      const b = await readBody(req);
      try { const printer = await printLabel(b); return json(res, { ok: true, printer }); }
      catch (e) { log("⚠️ Label printen mislukt:", e.message); return json(res, { ok: false, error: e.message }); }
    }
    if (url.pathname === "/api/printers") {
      try { return json(res, { ok: true, printers: await dymoPrinters() }); }
      catch (e) { return json(res, { ok: false, error: e.message }); }
    }
    if (url.pathname === "/api/state") {
      if (req.method === "POST") {
        const b = await readBody(req);
        if (b && b.state && typeof b.state === "object") {
          const prev = readJSON("dashboard.json", null);
          writeJSON("dashboard.json", b.state);
          // Kluislogboek: elke wijziging van packs of waarde per pack
          if (!prev || prev.packs !== b.state.packs || prev.price !== b.state.price) {
            const line = { tijd: new Date().toISOString(), packs: b.state.packs, waardePerPack: b.state.price, totaal: Math.round((b.state.packs || 0) * (b.state.price || 0) * 100) / 100 };
            fs.appendFile(path.join(DATA, "kluis-logboek.jsonl"), JSON.stringify(line) + "\n", () => {});
          }
          broadcast("state", { from: b.from, state: b.state });
        }
        return json(res, { ok: true });
      }
      return json(res, { state: readJSON("dashboard.json", null) });
    }
    if (url.pathname === "/api/update") {
      if (req.method === "POST") {
        try { const v = await applyUpdate(); json(res, { ok: true, version: v }); setTimeout(() => process.exit(42), 800); }
        catch (e) { log("\u26a0\ufe0f Bijwerken mislukt:", e.message); json(res, { ok: false, error: e.message }); }
        return;
      }
      const i = await checkUpdate();
      return json(res, { current: i.current, latest: i.latest, notes: i.notes, available: i.available, error: i.error, url: updateBase() });
    }
    if (url.pathname === "/api/status") return json(res, { status, chat: !!live, names: userNames.size, shop: tokens?.shop_name || null });
    html(res, "Niet gevonden", 404);
  } catch (e) {
    log("⚠️", e.message);
    json(res, { ok: false, error: e.message }, 500);
  }
});

function setupPage() {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const aliases = Object.entries(config.productAliases || {}).map(([k, v]) => `${k} = ${v}`).join("\n");
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>The TCG Plug koppeling – instellingen</title>
<style>
body{font-family:system-ui,sans-serif;background:#0b0a08;color:#f4efe4;max-width:720px;margin:0 auto;padding:2rem 1.25rem;line-height:1.5}
h1{color:#f6d47a;margin-top:0} h2{color:#f6d47a;font-size:1.15rem;margin-top:2rem}
label{display:block;margin:.8rem 0 .3rem;color:#a89b82}
input,textarea{width:100%;box-sizing:border-box;background:#17140f;border:1px solid #3d3322;color:#f4efe4;border-radius:8px;padding:.6rem;font:inherit}
button{background:#d9a63a;color:#1a1405;border:0;border-radius:8px;padding:.6rem 1rem;font-weight:600;cursor:pointer;margin-top:.8rem}
.st{padding:.7rem 1rem;border-radius:10px;border:1px solid ${status.ok ? "#46d6c8" : "#ef6b5b"};color:${status.ok ? "#46d6c8" : "#ef6b5b"}}
small{color:#a89b82} code{background:#17140f;padding:.1rem .3rem;border-radius:4px}
#msg{margin-top:.6rem;color:#46d6c8}
</style></head><body>
<h1>The TCG Plug koppeling</h1>
<div class="st">Status: ${esc(status.text)}${tokens?.seller ? " · winkel: " + esc(tokens.seller) : ""}</div>

<h2>1. Shopify (alle bestellingen)</h2>
<p>TikTok-bestellingen komen in Shopify binnen, dus het programma haalt alles uit Shopify. Elke bestelling komt in de rij met voornaam en bestelnummer, plus wat er besteld is: 🛒 = via TikTok, 🛍️ = via de webshop.</p>
<label>Winkelnaam (het stuk vóór .myshopify.com)</label><input id="shopifyShop" value="${esc(config.shopifyShop)}" placeholder="thetcgplug">
<label>Client ID (uit de Shopify Dev Dashboard-app)</label><input id="shopifyClientId" value="${esc(config.shopifyClientId)}">
<label>Client Secret</label><input id="shopifyClientSecret" type="password" value="${esc(config.shopifyClientSecret)}">
<small>Heb je nog een oude Shopify-app met een vaste sleutel (begint met <code>shpat_</code>)? Vul die dan hieronder in en laat Client ID en Secret leeg.</small>
<label>Admin API access token (alleen bij een oude app)</label><input id="shopifyToken" type="password" value="${esc(config.shopifyToken)}">

<label>Welke bestellingen in de wachtrij?</label>
<select id="orderFilter" style="width:100%;background:#17140f;border:1px solid #3d3322;color:#f4efe4;border-radius:8px;padding:.6rem;font:inherit">
<option value="tiktok"${(config.orderFilter || "tiktok") === "tiktok" ? " selected" : ""}>Alleen TikTok-bestellingen (Whatnot niet tonen)</option>
<option value="all"${config.orderFilter === "all" ? " selected" : ""}>Alle betaalde bestellingen</option>
</select>
<small>TikTok-bestelling = via het TikTok-kanaal, of in de webshop gekozen voor TikTok.</small>

<h2>2. TikTok live-chat</h2>
<label>TikTok-gebruikersnaam van de stream (zonder @)</label><input id="tiktokUsername" value="${esc(config.tiktokUsername)}">
<small>Hiermee leest het programma de live-chat mee.</small>
<label>Korte productnamen (één per regel: <code>stukje van productnaam = korte naam</code>)</label>
<textarea id="aliases" rows="4" placeholder="Booster Bundle = 30th Celebration bundel">${esc(aliases)}</textarea>
<button onclick="saveCfg()">Opslaan</button>

<h2>Labelprinter (Dymo)</h2>
<p>Labels gaan rechtstreeks via DYMO Connect naar de printer. DYMO Connect moet daarvoor geïnstalleerd zijn; het hoeft niet open te staan.</p>
<div id="dymo">Printers zoeken…</div>
<label>Label verschuiven – horizontaal in mm (min = naar links, plus = naar rechts)</label>
<input id="labelShiftX" inputmode="decimal" value="${esc(config.labelShiftX ?? 0)}" style="max-width:160px">
<label>Label verschuiven – verticaal in mm (min = omhoog, plus = omlaag)</label>
<input id="labelShiftY" inputmode="decimal" value="${esc(config.labelShiftY ?? 0)}" style="max-width:160px">
<br><button onclick="post('/api/config',{labelShiftX:parseFloat(labelShiftX.value.replace(',','.'))||0,labelShiftY:parseFloat(labelShiftY.value.replace(',','.'))||0}).then(()=>post('/api/print',{name:'Sanne \u00b7 #1064',product:'30th Celebration bundel',no:'test',shop:'The TCG Plug'})).then(r=>msg(r.ok?'Testlabel verstuurd naar '+r.printer:'Mislukt: '+r.error))">Opslaan en testlabel printen</button>

<h2>Updates</h2>
<p id="upd">Zoeken naar updates\u2026</p>
<button id="updBtn" hidden onclick="this.disabled=true;msg('Bijwerken\u2026 niet afsluiten');post('/api/update',{}).then(r=>{ if(r.ok){ msg('Bijgewerkt naar versie '+r.version+'. Het programma start opnieuw, deze pagina vernieuwt vanzelf.'); setTimeout(()=>location.reload(),9000);} else { msg('Bijwerken mislukt: '+r.error); this.disabled=false; } })">Bijwerken</button>
<details style="margin-top:.8rem"><summary style="cursor:pointer;color:#a89b82">Update-adres wijzigen</summary>
<label>Update-adres</label><input id="updateUrl" value="${esc(config.updateUrl || DEFAULT_UPDATE_URL)}" placeholder="https://raw.githubusercontent.com/gebruiker/map/main/">
<button onclick="post('/api/config',{updateUrl:updateUrl.value.trim()}).then(()=>location.reload())">Opslaan</button></details>

<h2>3. Testen</h2>
<p>Open het dashboard op <a href="/" target="_blank" style="color:#f6d47a">http://localhost:${PORT}</a> en druk hier op de knop. Er moet dan een testklant in de wachtrij verschijnen.</p>
<button onclick="post('/api/test',{}).then(()=>msg('Testbestelling verstuurd'))">Testbestelling sturen</button>
<button onclick="post('/api/testchat',{}).then(()=>msg('Testberichten verstuurd'))">Testchat sturen</button>
<div id="msg"></div>
<script>
const msg = t => document.getElementById('msg').textContent = t;
fetch('/api/update').then(r=>r.json()).then(u=>{ const el=document.getElementById('upd');
  if (u.available){ el.innerHTML = 'Versie <b>'+u.current+'</b> \u2013 er is een nieuwe versie: <b>'+u.latest+'</b>' + (u.notes ? '<br><small>'+u.notes.replace(/[<>&]/g,'')+'</small>' : ''); document.getElementById('updBtn').hidden = false; }
  else el.textContent = 'Versie ' + u.current + (u.error ? ' \u2013 ' + u.error : ' \u2013 dit is de nieuwste versie'); });
fetch('/api/printers').then(r=>r.json()).then(r=>{ document.getElementById('dymo').textContent = r.ok ? (r.printers.length ? 'Gevonden: ' + r.printers.map(p=>p.name+(p.connected?' (verbonden)':' (niet verbonden)')).join(', ') : 'Geen Dymo gevonden in DYMO Connect') : r.error; });
const post = (u,b) => fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
function saveCfg(){
  const productAliases = {};
  document.getElementById('aliases').value.split('\\n').forEach(l=>{ const i=l.indexOf('='); if(i>0) productAliases[l.slice(0,i).trim()] = l.slice(i+1).trim(); });
  post('/api/config',{orderFilter:orderFilter.value,shopifyShop:shopifyShop.value.trim(),shopifyClientId:shopifyClientId.value.trim(),shopifyClientSecret:shopifyClientSecret.value.trim(),shopifyToken:shopifyToken.value.trim(),tiktokUsername:tiktokUsername.value.trim(),productAliases}).then(()=>{ msg('Opgeslagen \u2013 verbinden\u2026'); setTimeout(()=>location.reload(), 6000); });
}
function sendCode(){ post('/api/code',{code:code.value}).then(r=> r.ok ? location.href='/setup?ok=1' : msg('Koppelen mislukt: '+r.error)); }
</script></body></html>`;
}

server.listen(PORT, "127.0.0.1", () => {
  log(`The TCG Plug koppeling \u2013 versie ${VERSION}`);
  log(`Dashboard:     http://localhost:${PORT}`);
  log(`Instellingen:  http://localhost:${PORT}/setup`);
  log("Laat dit venster open tijdens de stream.");
  poll(); setInterval(poll, POLL_MS);
  startLive();
  if (!process.env.TCG_RESTART) openDashboard();
  setTimeout(() => checkUpdate().then(i => { if (i.available) log(`\ud83d\udd14 Er is een nieuwe versie (${i.latest}). Bijwerken via http://localhost:${PORT}/setup`); }), 3000);
});

// Opent het dashboard in Chrome of Edge met stil printen aan (labels gaan direct naar de standaardprinter).
function openDashboard() {
  const url = `http://localhost:${PORT}`;
  const profile = path.join(DATA, "browser");
  const args = ["--kiosk-printing", `--user-data-dir=${profile}`, "--no-first-run", `--app=${url}`];
  const env = process.env;
  const candidates = process.platform === "win32" ? [
    path.join(env["ProgramFiles"] || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
    path.join(env["LOCALAPPDATA"] || "", "Google/Chrome/Application/chrome.exe"),
    path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
    path.join(env["ProgramFiles"] || "C:\\Program Files", "Microsoft/Edge/Application/msedge.exe")
  ] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const exe = candidates.find(c => { try { return c && fs.existsSync(c); } catch { return false; } });
  if (exe) {
    spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
    log("Dashboard geopend met stil printen (labels gaan naar de standaardprinter)");
  } else {
    const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
    log("Chrome/Edge niet gevonden: dashboard geopend in de standaardbrowser (printen vraagt dan elke keer om bevestiging)");
  }
}
