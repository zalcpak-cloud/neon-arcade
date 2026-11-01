// Серверная часть Neon Arcade (Cloudflare Workers + Durable Object).
//  1) /invoice  — создаёт счёт на оплату Telegram Stars (только оформление),
//  2) /webhook  — подтверждает оплату Stars и отвечает на /start,
//  3) /ws       — общая комната «Ракеты» (WebSocket): все игроки в одном раунде.
//
// Переменные и секреты (см. INSTRUCTIONS.md):
//   BOT_TOKEN (secret), WEBHOOK_SECRET (secret), APP_URL (text), DEV_GUESTS (text, необязательно: "1" для теста вне Telegram)

import { RoomEngine } from "./rocket-engine.js";

// Цены должны совпадать с index.html. Цена берётся ЗДЕСЬ, на сервере, поэтому подделать её в приложении нельзя.
const CATALOG = {
  theme_ice:    { title: "Ледяная тема",  description: "Оформление приложения в ледяных тонах",  stars: 25 },
  theme_sunset: { title: "Тема «Закат»",  description: "Оформление приложения в тонах заката",   stars: 25 },
  theme_gold:   { title: "Золотая тема",  description: "Оформление приложения в золотых тонах",  stars: 50 },
  badge_bolt:   { title: "Значок ⚡",      description: "Значок рядом с названием",               stars: 25 },
  badge_crown:  { title: "Значок 👑",      description: "Значок рядом с названием",               stars: 50 },
  badge_gem:    { title: "Значок 💎",      description: "Значок рядом с названием",               stars: 100 }
};

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return r.json();
}

// Проверка, что данные входа действительно пришли от Telegram (подпись HMAC-SHA256)
async function verifyInitData(initData, token) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const data = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const enc = new TextEncoder();
    const k1 = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", k1, enc.encode(token));
    const k2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", k2, enc.encode(data));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
    if (hex !== hash) return null;
    const authDate = Number(params.get("auth_date"));
    if (!authDate || Date.now() / 1000 - authDate > 2 * 86400) return null;
    const u = JSON.parse(params.get("user") || "null");
    return u && u.id ? u : null;
  } catch (e) { return null; }
}

// ===== Durable Object: одна общая комната для всех игроков =====
export class RocketRoom {
  constructor(state, env) {
    this.env = env;
    this.engine = new RoomEngine();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Нужен WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const sess = { user: null, send: m => { try { server.send(JSON.stringify(m)); } catch (e) {} } };
    this.engine.attach(sess);

    let count = 0, windowStart = Date.now();
    server.addEventListener("message", async ev => {
      // защита от спама: не больше 30 сообщений в секунду
      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; count = 0; }
      if (++count > 30) { try { server.close(1008, "too many messages"); } catch (e) {} return; }

      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === "auth") {
        let u = null;
        if (msg.initData) u = await verifyInitData(String(msg.initData), this.env.BOT_TOKEN);
        else if (this.env.DEV_GUESTS === "1") u = { id: "g" + Math.floor(Math.random() * 1e9), first_name: "Гость" };
        if (!u) { sess.send({ t: "err", code: "auth", msg: "Откройте игру через Telegram" }); return; }
        this.engine.setUser(sess, { uid: u.id, name: u.first_name, photo: u.photo_url, hidden: !!msg.hide });
        return;
      }
      this.engine.onMessage(sess, msg);
    });
    const close = () => this.engine.detach(sess);
    server.addEventListener("close", close);
    server.addEventListener("error", close);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // Общая комната «Ракеты»
    if (url.pathname === "/ws") {
      const stub = env.ROCKET.get(env.ROCKET.idFromName("main"));
      return stub.fetch(request);
    }

    // 1) Приложение просит создать счёт на оплату в Stars
    if (url.pathname === "/invoice" && request.method === "POST") {
      let data;
      try { data = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const item = CATALOG[data.item];
      if (!item) return json({ error: "unknown item" }, 400);
      const res = await tg(env, "createInvoiceLink", {
        title: item.title,
        description: item.description,
        payload: data.item,
        provider_token: "",          // для Stars всегда пусто
        currency: "XTR",             // XTR = Telegram Stars
        prices: [{ label: item.title, amount: item.stars }]
      });
      if (!res.ok) return json({ error: res.description || "telegram error" }, 502);
      return json({ link: res.result });
    }

    // 2) Telegram присылает сюда события бота (webhook)
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();

      // Telegram обязательно ждёт подтверждения перед списанием Stars
      if (update.pre_checkout_query) {
        const id = update.pre_checkout_query.invoice_payload;
        await tg(env, "answerPreCheckoutQuery", {
          pre_checkout_query_id: update.pre_checkout_query.id,
          ok: Boolean(CATALOG[id]),
          error_message: "Товар не найден"
        });
      }

      // Ответ на /start с кнопкой запуска приложения
      const text = update.message && update.message.text;
      if (text && text.startsWith("/start")) {
        await tg(env, "sendMessage", {
          chat_id: update.message.chat.id,
          text: "⚡ Neon Arcade — игры на виртуальных монетах. Жми кнопку!",
          reply_markup: { inline_keyboard: [[{ text: "🎮 Играть", web_app: { url: env.APP_URL } }]] }
        });
      }
      // Поддержка по платежам (обязательно по правилам Telegram)
      if (text && text.startsWith("/paysupport")) {
        await tg(env, "sendMessage", {
          chat_id: update.message.chat.id,
          text: "По вопросам оплаты Stars напишите владельцу бота. Ответим и при необходимости вернём Stars."
        });
      }
      return new Response("ok");
    }

    return new Response("Neon Arcade backend works");
  }
};
