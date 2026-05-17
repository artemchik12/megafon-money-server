const express = require('express');
const Database = require('better-sqlite3');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const fs = require('fs');

// ==========================================
// ⚙️ НАСТРОЙКИ СЕРВЕРА
// ==========================================
const BOT_TOKEN = "ВАШ_ТОКЕН_ОТ_BOTFATHER";
const ADMIN_CHAT_ID = "ВАШ_CHAT_ID";
const FLASK_PORT = 4444;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Отключаем Keep-Alive, чтобы старый Android не вис
app.use((req, res, next) => {
    res.setHeader('Connection', 'close');
    next();
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function notifyAdmin(text) {
    bot.sendMessage(ADMIN_CHAT_ID, text).catch(() => {});
}

// ==========================================
// 🗄 БАЗА ДАННЫХ SQLITE (Обновленная)
// ==========================================
const db = new Database('wallet.db');

function initDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            phone TEXT PRIMARY KEY,
            password TEXT,
            sms_code TEXT,
            sid TEXT,
            balance REAL,
            tg_chat_id TEXT
        );
        CREATE TABLE IF NOT EXISTS transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_phone TEXT,
            receiver_phone TEXT,
            amount REAL,
            status TEXT,
            date_time TEXT
        );
        CREATE TABLE IF NOT EXISTS cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT,
            card_id TEXT,
            alias TEXT,
            card_number TEXT,
            acquirer_id TEXT,
            card_type TEXT
        );
    `);
    console.log("[+] База данных SQLite готова.");
}
initDb();

let cachedCatalog = null;
let catalogCacheId = "20121203175300398"; 
if (fs.existsSync('catalog.txt')) {
    try {
        cachedCatalog = JSON.parse(fs.readFileSync('catalog.txt', 'utf8'));
        catalogCacheId = cachedCatalog.cache_id || catalogCacheId;
        console.log("[+] Каталог услуг загружен в оперативную память.");
    } catch (e) {}
}

// ==========================================
// 📞 EXPRESS API МЕГАФОНА
// ==========================================
app.post('/api/odp', (req, res) => {
    const reqStr = req.body.request;
    if (!reqStr) return res.json({ result: "error", text: "Empty request" });

    let reqData;
    try { reqData = JSON.parse(reqStr); } catch (e) { return res.json({ result: "error", text: "Invalid JSON" }); }

    const action = reqData.request || reqData.method || reqData.action || "unknown";
    const sid = reqData.sid;
    
    if (!["balance", "quick_balance", "balance_widget"].includes(action)) {
        console.log(`\n[>] ПРИШЕЛ ЗАПРОС: [${action}]`);
    }

    // --- 1. АВТОРИЗАЦИЯ И СМС ---
    if (action === "password_get" || action === "get_password") {
        const phone = reqData.msisdn || reqData.username || reqData.login || reqData.phone;
        if (!phone) return res.json({ result: "error", text: "Нет номера" });

        const smsCode = Math.floor(100000 + Math.random() * 900000).toString();
        const user = db.prepare('SELECT phone, tg_chat_id FROM users WHERE phone = ?').get(phone);
        
        if (user) {
            // Пишем СМС код во временную колонку, НЕ трогая основной пароль!
            db.prepare('UPDATE users SET sms_code = ? WHERE phone = ?').run(smsCode, phone);
            
            const msgText = `📩 Ваш СМС-Код для входа!\nКод: ${smsCode}\nТекст для авто-ввода: мегафон ${smsCode}`;
            
            // Если этот кошелек привязан к Телеграму юзера, отправляем ему
            if (user.tg_chat_id) {
                bot.sendMessage(user.tg_chat_id, msgText).catch(() => {});
            }
            
            // Если это не админ запрашивает, уведомим админа для контроля
            if (user.tg_chat_id !== ADMIN_CHAT_ID.toString()) {
                notifyAdmin(`🔔 Пользователь ${phone} запросил код входа.`);
            }
        } else {
            // Если номер неизвестный, создаем его (но мы не знаем его ТГ)
            db.prepare('INSERT INTO users (phone, password, sms_code, sid, balance) VALUES (?, ?, ?, ?, ?)').run(phone, '', smsCode, null, 1000.0);
            notifyAdmin(`📩 НОВЫЙ ЗАПРОС!\nКто-то запросил код для незареганного номера ${phone}.\nСМС Код: ${smsCode}`);
        }
        return res.json({ result: "ok" });
    }

    if (action === "auth") {
        const phone = reqData.username || reqData.login || reqData.phone || reqData.msisdn || "";
        const password = reqData.password || reqData.pass || "";
        
        if (phone === "" && sid && sid !== "1") {
            const existingUser = db.prepare('SELECT * FROM users WHERE sid = ?').get(sid);
            if (existingUser) return res.json({ result: "ok", sid: existingUser.sid, operator: "Мегафон", region: "100", autoupdate_time: 3600, request_logs: [] });
            return res.json({ result: "error", text: "Сессия устарела. Введите логин и пароль." });
        }
        
        if (phone === "") return res.json({ result: "error", text: "Необходима авторизация" });
        
        const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
        if (!user) {
             db.prepare('INSERT INTO users (phone, password, sid, balance) VALUES (?, ?, ?, ?)').run(phone, password, null, 1000.0);
             notifyAdmin(`🆕 Создан профиль через приложение: ${phone}`);
        } else {
            // ПРОВЕРКА ПАРОЛЯ: Подходит либо основной пароль, либо временный СМС-код
            if (user.password !== password && user.sms_code !== password) {
                return res.json({ result: "error", text: "Неверный пароль", attempt_remain: "3" });
            }
            
            // Если вошел по СМС-коду, стираем его (чтобы нельзя было использовать дважды)
            if (user.sms_code === password) {
                db.prepare('UPDATE users SET sms_code = NULL WHERE phone = ?').run(phone);
            }
        }
            
        const newSid = crypto.randomBytes(16).toString('hex');
        db.prepare('UPDATE users SET sid = ? WHERE phone = ?').run(newSid, phone);
        return res.json({ result: "ok", sid: newSid, operator: "Мегафон", region: "100", autoupdate_time: 3600, request_logs: [] });
    }

    // --- 2. БАЛАНС И ПРОФИЛЬ ---
    if (["balance", "quick_balance", "balance_widget"].includes(action)) {
        const user = db.prepare('SELECT balance FROM users WHERE sid = ?').get(sid);
        if (user) return res.json({ result: "ok", balance: user.balance });
        return res.json({ result: "error", code: "401" });
    }

    if (action === "get_msisdn") {
        const user = db.prepare('SELECT phone FROM users WHERE sid = ?').get(sid);
        return res.json(user ? { result: "ok", msisdn: user.phone } : { result: "error" });
    }

    if (action === "get_profile") {
        const user = db.prepare('SELECT phone FROM users WHERE sid = ?').get(sid);
        return res.json({ result: "ok", profile: [{ code: "profile_1", caption: "Мой профиль", type: "user", value: user ? user.phone : "Неизвестно", list: [] }]});
    }

    if (action === "offer_text" || action === "get_oferta") return res.json({ result: "ok", offer_id: "v1", offer: "Добро пожаловать в эмулятор МегаФон Деньги!/n Все бесплатно пока не крашнется сервер или я забуду его оплатить,если что пишите в ТГ @minatosabaru " });

    // --- 3. P2P ПЕРЕВОДЫ ---
    if (action === "send_transfer_msisdn") {
        const sender = db.prepare('SELECT * FROM users WHERE sid = ?').get(sid);
        const receiver_phone = reqData.receiver_phone || reqData.destination;
        const amount = parseFloat(reqData.amount || 0);
        
        if (!sender) return res.json({ result: "error", code: "401", text: "Не авторизован" });
        if (sender.balance < amount) return res.json({ result: "error", text: "Недостаточно средств" });
        
        const receiver = db.prepare('SELECT phone, tg_chat_id FROM users WHERE phone = ?').get(receiver_phone);
        if (!receiver) return res.json({ result: "error", text: "Получатель не найден" });

        db.prepare('UPDATE users SET balance = balance - ? WHERE phone = ?').run(amount, sender.phone);
        db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(amount, receiver_phone);
        
        const timeNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const info = db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time) VALUES (?, ?, ?, ?, ?)')
                       .run(sender.phone, receiver_phone, amount, "ok", timeNow);
        
        // Уведомление получателю перевода (если у него есть бот)
        if (receiver.tg_chat_id) {
            bot.sendMessage(receiver.tg_chat_id, `💸 ВАМ ПЕРЕВОД!\nОт: ${sender.phone}\nСумма: ${amount} руб.`).catch(()=>{});
        }
        notifyAdmin(`💸 ПЕРЕВОД!\nОт: ${sender.phone}\nКому: ${receiver_phone}\nСумма: ${amount} руб.`);
        
        return res.json({ result: "ok", transfer_id: info.lastInsertRowid.toString() });
    }

    // --- 4. КАРТЫ И ПОПОЛНЕНИЕ ---
    if (action === "card_list") {
        const user = db.prepare('SELECT phone FROM users WHERE sid = ?').get(sid);
        if (!user) return res.json({ result: "error", code: "401" });
        const dbCards = db.prepare('SELECT * FROM cards WHERE phone = ?').all(user.phone);
        return res.json({ result: "ok", cards: dbCards });
    }

    if (action === "fill_balance") {
        const user = db.prepare('SELECT * FROM users WHERE sid = ?').get(sid);
        if (!user) return res.json({ result: "error", code: "401" });
        const amount = parseFloat(reqData.amount || 0);
        const card_id = reqData.card_id || "unknown";
        if (amount <= 0) return res.json({ result: "error", text: "Сумма <= 0" });
        
        db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(amount, user.phone);
        const info = db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time) VALUES (?, ?, ?, ?, ?)')
                       .run(`CARD_${card_id}`, user.phone, amount, "ok", new Date().toISOString());
                       
        if (user.tg_chat_id) bot.sendMessage(user.tg_chat_id, `💳 Пополнение баланса с карты на ${amount} руб.`).catch(()=>{});
        return res.json({ result: "ok", transfer_id: info.lastInsertRowid.toString() });
    }

    // --- 5. ЭКВАЙРИНГ И WEBVIEW ---
    if (["transfer_init", "send_transfer_card", "link_card"].includes(action)) {
        const amount = reqData.amount || "500";
        const transfer_id = "trx_" + Math.floor(100000 + Math.random() * 900000);
        const acquirer_url = `http://${req.get('host')}/fake_gateway`;
        return res.json({ result: "ok", transfer_id: transfer_id, acquirer_url: acquirer_url, acquirer_post: { payment_id: transfer_id, amount: amount.toString() }});
    }

    if (action === "transfer_result") return res.json({ result: "ok", transfer_id: reqData.transfer_id || "", transfer_complete: "1", transfer_status: "ok" });

    // --- 6. КАТАЛОГИ УСЛУГ ---
    if (action === "transfer_terms") return res.json({ result: "ok", comission: "0", min_amount: "1", max_amount: "15000", max_daily_amount: "50000", max_monthly_amount: "100000" });

    if (action === "get_catalog" || action === "catalog_list") {
        if (reqData.cache_id === catalogCacheId) return res.json({ result: "cache" });
        return cachedCatalog ? res.json(cachedCatalog) : res.json({ result: "error", text: "Каталог недоступен" });
    }

    if (["good_by_id", "good_from_by_id"].includes(action)) {
        const good_id = reqData.good_id || reqData.goods_id;
        const fileName = `good_${good_id}.txt`;
        fs.readFile(fileName, 'utf8', (err, data) => {
            if (!err) { try { return res.json(JSON.parse(data)); } catch(e) {} }
            return res.json({ result: "ok", good_id: good_id, name: "Неизвестная услуга", fields: [{ name: "account", type: "text", required: "1" }, { name: "sum", type: "text", required: "1" }]});
        });
        return; 
    }

    // --- 7. ПУСТЫЕ МАССИВЫ (Чтобы UI не падал) ---
    if (action === "transfer_history" || action === "card_history") return res.json({ result: "ok", transfers: [] });
    if (action === "favorites_list") return res.json({ result: "ok", favorites: [] });
    if (action === "get_transfers_incoming" || action === "get_transfers_outgoing") return res.json({ result: "ok", count: "0", transfers: [] });

    return res.json({ result: "ok" });
});

// ==========================================
// 🌐 WEBVIEW (ЭКВАЙРИНГ)
// ==========================================
app.all('/fake_gateway', (req, res) => {
    const payment_id = req.body.payment_id || req.query.payment_id || "TRX_TEST";
    const amount = req.body.amount || req.query.amount || "0";
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body { font-family: Arial; text-align: center; padding: 20px; } .card { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); } .btn { background: #00B956; color: white; padding: 15px; width: 100%; border: none; border-radius: 5px; font-size: 18px; cursor: pointer; }</style></head><body><div class="card"><h2 style="color: #00B956;">🔒 Тестовый Эквайринг</h2><p>Заказ: ${payment_id}</p><h2>${amount} ₽</h2><form action="/gateway_success" method="POST"><input type="hidden" name="payment_id" value="${payment_id}"><button type="submit" class="btn">Подтвердить оплату</button></form></div></body></html>`);
});
app.post('/gateway_success', (req, res) => {
    res.send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family: sans-serif; text-align: center; margin-top: 50px;"><h2 style="color: green;">✅ Операция выполнена</h2><p>Возвращаемся...</p><script>setTimeout(function(){ window.location.href = 'megafon://success'; }, 2000);</script></body></html>`);
});

// ==========================================
// 👑 ТЕЛЕГРАМ БОТ
// ==========================================
bot.onText(/\/start|\/help/, (msg) => {
    if (msg.from.id.toString() === ADMIN_CHAT_ID.toString()) {
        bot.sendMessage(msg.chat.id, "👑 ПАНЕЛЬ АДМИНА\n/users — Список кошельков\n/add_money <номер> <сумма>\n/add_card <номер> <карта>");
    } else {
        bot.sendMessage(msg.chat.id, "👤 КОШЕЛЕК МЕГАФОН\n/register <номер> <пароль> — Создать/привязать кошелек\n/my_balance <номер> — Проверить баланс");
    }
});

bot.onText(/\/register/, (msg) => {
    const parts = msg.text.split(' ');
    if (parts.length !== 3) return bot.sendMessage(msg.chat.id, "⚠️ Формат: /register 79260000000 123456");
    const phone = parts[1], password = parts[2], tgChatId = msg.chat.id.toString();
    try {
        const user = db.prepare('SELECT phone FROM users WHERE phone = ?').get(phone);
        if (user) {
            db.prepare('UPDATE users SET password = ?, tg_chat_id = ? WHERE phone = ?').run(password, tgChatId, phone);
            bot.sendMessage(msg.chat.id, `🔄 Телеграм привязан к ${phone}, пароль обновлен.`);
        } else {
            db.prepare('INSERT INTO users (phone, password, sms_code, sid, balance, tg_chat_id) VALUES (?, ?, NULL, NULL, ?, ?)').run(phone, password, 1000.0, tgChatId);
            bot.sendMessage(msg.chat.id, `✅ Кошелек ${phone} создан!\nВам начислено: 1000 руб.`);
        }
    } catch(e) { bot.sendMessage(msg.chat.id, "Ошибка"); }
});

bot.onText(/\/my_balance (.+)/, (msg, match) => {
    try {
        const user = db.prepare('SELECT balance, tg_chat_id FROM users WHERE phone = ?').get(match[1]);
        if (user && user.tg_chat_id === msg.chat.id.toString()) {
            bot.sendMessage(msg.chat.id, `💰 Баланс: ${user.balance} руб.`);
        } else { bot.sendMessage(msg.chat.id, "❌ Нет доступа."); }
    } catch(e) {}
});

// АДМИНСКИЕ КОМАНДЫ
bot.onText(/\/users/, (msg) => {
    if (msg.from.id.toString() !== ADMIN_CHAT_ID.toString()) return;
    const users = db.prepare('SELECT phone, password, balance, tg_chat_id FROM users').all();
    if (!users.length) return bot.sendMessage(msg.chat.id, "Пусто.");
    let text = "👥 Кошельки:\n";
    users.forEach(u => {
        const link = u.tg_chat_id ? "✅ ТГ" : "❌ ТГ";
        text += `📱 ${u.phone} | 🔑 ${u.password || 'Нет'} | 💰 ${u.balance} руб | ${link}\n`;
    });
    bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/add_money (.+) (.+)/, (msg, match) => {
    if (msg.from.id.toString() !== ADMIN_CHAT_ID.toString()) return;
    try {
        db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(parseFloat(match[2]), match[1]);
        bot.sendMessage(msg.chat.id, `✅ Баланс ${match[1]} пополнен на ${match[2]} руб.`);
    } catch(e) {}
});

bot.onText(/\/add_card (.+) (.+)/, (msg, match) => {
    if (msg.from.id.toString() !== ADMIN_CHAT_ID.toString()) return;
    try {
        const phone = match[1], cardRaw = match[2];
        const cardMasked = cardRaw.length >= 12 ? `${cardRaw.substring(0,4)} **** **** ${cardRaw.slice(-4)}` : cardRaw;
        const cardType = cardRaw.startsWith("4") ? "VISA" : "MasterCard";
        
        db.prepare('INSERT INTO cards (phone, card_id, alias, card_number, acquirer_id, card_type) VALUES (?, ?, ?, ?, ?, ?)')
          .run(phone, "card_" + crypto.randomBytes(4).toString('hex'), "Моя карта", cardMasked, "1", cardType);
        bot.sendMessage(msg.chat.id, `💳 Карта ${cardMasked} привязана!`);
    } catch(e) {}
});

app.listen(FLASK_PORT, '0.0.0.0', () => { console.log(`[+] Сервер запущен на порту ${FLASK_PORT}`); });
