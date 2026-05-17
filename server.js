const express = require('express');
const Database = require('better-sqlite3');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

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
function notifyAdmin(text) { bot.sendMessage(ADMIN_CHAT_ID, text).catch(() => {}); }

// ==========================================
// 🗄 БАЗА ДАННЫХ SQLITE (Финальная схема)
// ==========================================
const db = new Database('wallet.db');

function initDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            phone TEXT PRIMARY KEY, password TEXT, sms_code TEXT, sid TEXT, balance REAL, tg_chat_id TEXT
        );
        CREATE TABLE IF NOT EXISTS cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, card_id TEXT, alias TEXT, card_number TEXT, acquirer_id TEXT, card_type TEXT
        );
        CREATE TABLE IF NOT EXISTS favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, name TEXT, good_id TEXT, fields_json TEXT
        );
        CREATE TABLE IF NOT EXISTS transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT, sender_phone TEXT, receiver_phone TEXT, amount REAL, status TEXT, date_time TEXT, good_id TEXT, description TEXT, type TEXT
        );
        CREATE TABLE IF NOT EXISTS pending_ops (
            transfer_id TEXT PRIMARY KEY, phone TEXT, op_type TEXT, amount REAL, good_id TEXT
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
        console.log(`\n[>] ЗАПРОС: [${action}]`, reqData);
    }

    // Вспомогательная функция: Достаем юзера по сессии
    const getUserBySid = () => db.prepare('SELECT * FROM users WHERE sid = ?').get(sid);

    // --- 1. АВТОРИЗАЦИЯ И СМС ---
    if (action === "password_get" || action === "get_password") {
        const phone = reqData.msisdn || reqData.username || reqData.login || reqData.phone;
        const smsCode = Math.floor(100000 + Math.random() * 900000).toString();
        const user = db.prepare('SELECT phone, tg_chat_id FROM users WHERE phone = ?').get(phone);
        
        if (user) {
            db.prepare('UPDATE users SET sms_code = ? WHERE phone = ?').run(smsCode, phone);
            if (user.tg_chat_id) bot.sendMessage(user.tg_chat_id, `📩 СМС Код: ${smsCode}\nДля авто-ввода: мегафон ${smsCode}`).catch(()=>{});
        } else {
            db.prepare('INSERT INTO users (phone, password, sms_code, sid, balance) VALUES (?, ?, ?, ?, ?)').run(phone, '', smsCode, null, 1000.0);
        }
        if (!user || user.tg_chat_id !== ADMIN_CHAT_ID.toString()) notifyAdmin(`🔔 Запрошен код для ${phone}: ${smsCode}`);
        return res.json({ result: "ok" });
    }

    if (action === "auth") {
        const phone = reqData.username || reqData.login || reqData.phone || reqData.msisdn || "";
        const password = reqData.password || reqData.pass || "";
        
        if (phone === "" && sid && sid !== "1") {
            const existingUser = getUserBySid();
            if (existingUser) return res.json({ result: "ok", sid: existingUser.sid, operator: "Мегафон", region: "100", autoupdate_time: 3600, request_logs: [] });
            return res.json({ result: "error", text: "Сессия устарела. Введите логин и пароль." });
        }
        if (phone === "") return res.json({ result: "error", text: "Необходима авторизация" });
        
        const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
        if (!user) {
             db.prepare('INSERT INTO users (phone, password, sid, balance) VALUES (?, ?, ?, ?)').run(phone, password, null, 1000.0);
             notifyAdmin(`🆕 Создан профиль через приложение: ${phone}`);
        } else {
            if (user.password !== password && user.sms_code !== password) return res.json({ result: "error", text: "Неверный пароль", attempt_remain: "3" });
            if (user.sms_code === password) db.prepare('UPDATE users SET sms_code = NULL WHERE phone = ?').run(phone);
        }
            
        const newSid = crypto.randomBytes(16).toString('hex');
        db.prepare('UPDATE users SET sid = ? WHERE phone = ?').run(newSid, phone);
        return res.json({ result: "ok", sid: newSid, operator: "Мегафон", region: "100", autoupdate_time: 3600, request_logs: [] });
    }

    // --- 2. БАЛАНС И ПРОФИЛЬ ---
    if (["balance", "quick_balance", "balance_widget"].includes(action)) {
        const user = getUserBySid();
        if (user) return res.json({ result: "ok", balance: user.balance });
        return res.json({ result: "error", code: "401" });
    }
    if (action === "get_msisdn") {
        const user = getUserBySid();
        return res.json(user ? { result: "ok", msisdn: user.phone } : { result: "error" });
    }
    if (action === "get_profile") {
        const user = getUserBySid();
        return res.json({ result: "ok", profile: [{ code: "profile_1", caption: "Мой профиль", type: "user", value: user ? user.phone : "Неизвестно", list: [] }]});
    }

    // --- 3. ИЗБРАННОЕ ---
    if (action === "favorites_list") {
        const user = getUserBySid();
        if (!user) return res.json({ result: "error", code: "401" });
        const favs = db.prepare('SELECT * FROM favorites WHERE phone = ?').all(user.phone);
        const formatFavs = favs.map(f => ({
            index: f.id.toString(), name: f.name, good_id: f.good_id,
            field_vals: JSON.parse(f.fields_json || "[]"),
            params: { method: "megafon", wallet_id: "" }
        }));
        return res.json({ result: "ok", favorites: formatFavs });
    }

    if (action === "favorites_add") {
        const user = getUserBySid();
        if (!user) return res.json({ result: "error", code: "401" });
        const name = reqData.name || "Мой шаблон";
        const good_id = reqData.good_id || "unknown";
        const fields = JSON.stringify(reqData.field_vals || []);
        db.prepare('INSERT INTO favorites (phone, name, good_id, fields_json) VALUES (?, ?, ?, ?)').run(user.phone, name, good_id, fields);
        return res.json({ result: "ok" });
    }

    // --- 4. ИСТОРИЯ ПЛАТЕЖЕЙ ---
    if (action === "transfer_history" || action === "card_history" || action === "get_transfers_outgoing") {
        const user = getUserBySid();
        if (!user) return res.json({ result: "error", code: "401" });
        const history = db.prepare("SELECT * FROM transfers WHERE sender_phone = ? ORDER BY id DESC LIMIT 50").all(user.phone);
        
        const formatHistory = history.map(t => ({
            transfer_id: t.id.toString(),
            good_id: t.good_id || "unknown",
            description: t.description || "Перевод",
            datetime: t.date_time,
            amount: t.amount.toString(),
            status: t.status,
            status_message: "Успешно"
        }));
        return res.json({ result: "ok", count: formatHistory.length.toString(), transfers: formatHistory });
    }

    if (action === "get_transfers_incoming") {
        const user = getUserBySid();
        const history = db.prepare("SELECT * FROM transfers WHERE receiver_phone = ? ORDER BY id DESC LIMIT 50").all(user.phone);
        const formatHistory = history.map(t => ({ transfer_id: t.id.toString(), amount: t.amount.toString(), sender: t.sender_phone, status: t.status, status_date: t.date_time }));
        return res.json({ result: "ok", count: formatHistory.length.toString(), transfers: formatHistory });
    }

    // --- 5. ОПЛАТА УСЛУГ (С БАЛАНСА КОШЕЛЬКА) ---
    if (action === "transfer_add") {
        const user = getUserBySid();
        if (!user) return res.json({ result: "error", code: "401" });

        // Ищем сумму (она может быть в корне JSON или внутри массива field_vals)
        let amount = parseFloat(reqData.amount || reqData.request_amount || 0);
        if (amount <= 0 && reqData.field_vals) {
            const sumField = reqData.field_vals.find(f => f.name === 'sum' || f.name === 'amount');
            if (sumField) amount = parseFloat(sumField.value);
        }

        if (amount <= 0) return res.json({ result: "error", text: "Сумма не указана" });
        if (user.balance < amount) return res.json({ result: "error", text: "Недостаточно средств на балансе!" });

        const good_id = reqData.good_id || "unknown_service";
        db.prepare('UPDATE users SET balance = balance - ? WHERE phone = ?').run(amount, user.phone);
        
        const timeNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const info = db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time, good_id, description, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                       .run(user.phone, 'SERVICE', amount, "ok", timeNow, good_id, "Оплата услуг", "service_pay");
        
        notifyAdmin(`🛒 ОПЛАТА УСЛУГ!\nКошелек: ${user.phone}\nУслуга: ${good_id}\nСумма: ${amount} руб.`);
        return res.json({ result: "ok", transfer_id: info.lastInsertRowid.toString() });
    }

    // --- 6. P2P ПЕРЕВОДЫ ---
    if (action === "send_transfer_msisdn") {
        const sender = getUserBySid();
        const receiver_phone = reqData.receiver_phone || reqData.destination;
        const amount = parseFloat(reqData.amount || 0);
        
        if (!sender) return res.json({ result: "error", code: "401" });
        if (sender.balance < amount) return res.json({ result: "error", text: "Недостаточно средств" });
        
        const receiver = db.prepare('SELECT phone, tg_chat_id FROM users WHERE phone = ?').get(receiver_phone);
        if (!receiver) return res.json({ result: "error", text: "Получатель не зарегистрирован в системе" });

        db.prepare('UPDATE users SET balance = balance - ? WHERE phone = ?').run(amount, sender.phone);
        db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(amount, receiver_phone);
        
        const timeNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const info = db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time, description, type) VALUES (?, ?, ?, ?, ?, ?, ?)')
                       .run(sender.phone, receiver_phone, amount, "ok", timeNow, "Перевод P2P", "p2p");
        
        if (receiver.tg_chat_id) bot.sendMessage(receiver.tg_chat_id, `💸 ВАМ ПЕРЕВОД!\nОт: ${sender.phone}\nСумма: ${amount} руб.`).catch(()=>{});
        notifyAdmin(`💸 ПЕРЕВОД P2P!\nОт: ${sender.phone}\nКому: ${receiver_phone}\nСумма: ${amount} руб.`);
        
        return res.json({ result: "ok", transfer_id: info.lastInsertRowid.toString() });
    }

    // --- 7. КАРТЫ И ПОПОЛНЕНИЕ (С привязанной) ---
    if (action === "card_list") {
        const user = getUserBySid();
        if (!user) return res.json({ result: "error", code: "401" });
        const dbCards = db.prepare('SELECT * FROM cards WHERE phone = ?').all(user.phone);
        return res.json({ result: "ok", cards: dbCards });
    }

    if (action === "fill_balance") {
        const user = getUserBySid();
        if (!user) return res.json({ result: "error", code: "401" });
        const amount = parseFloat(reqData.amount || 0);
        if (amount <= 0) return res.json({ result: "error", text: "Сумма <= 0" });
        
        db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(amount, user.phone);
        const info = db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time, description, type) VALUES (?, ?, ?, ?, ?, ?, ?)')
                       .run(`CARD_${reqData.card_id||""}`, user.phone, amount, "ok", new Date().toISOString().replace('T', ' ').substring(0, 19), "Пополнение с карты", "topup");
                       
        if (user.tg_chat_id) bot.sendMessage(user.tg_chat_id, `💳 Пополнение баланса с карты на ${amount} руб.`).catch(()=>{});
        return res.json({ result: "ok", transfer_id: info.lastInsertRowid.toString() });
    }

    // --- 8. ЭКВАЙРИНГ И WEBVIEW (Привязка, Пополнение с новой) ---
    if (["transfer_init", "send_transfer_card", "link_card"].includes(action)) {
        const user = getUserBySid();
        if (!user) return res.json({ result: "error", code: "401" });

        // Если это привязка карты, сумма 0. Иначе ищем сумму
        let amount = action === "link_card" ? 0 : parseFloat(reqData.amount || 0);
        if (amount === 0 && reqData.field_vals) {
            const sumField = reqData.field_vals.find(f => f.name === 'sum');
            if (sumField) amount = parseFloat(sumField.value);
        }

        const transfer_id = "trx_" + Math.floor(100000 + Math.random() * 900000);
        
        // Записываем ожидающую операцию в БД
        const op_type = action === "link_card" ? "link" : (reqData.good_id ? "pay_service_card" : "topup_new_card");
        db.prepare('INSERT INTO pending_ops (transfer_id, phone, op_type, amount, good_id) VALUES (?, ?, ?, ?, ?)')
          .run(transfer_id, user.phone, op_type, amount, reqData.good_id || "");

        const acquirer_url = `http://${req.get('host')}/fake_gateway`;
        return res.json({ result: "ok", transfer_id: transfer_id, acquirer_url: acquirer_url, acquirer_post: { payment_id: transfer_id, amount: amount.toString() }});
    }

    if (action === "transfer_result") return res.json({ result: "ok", transfer_id: reqData.transfer_id || "", transfer_complete: "1", transfer_status: "ok" });

    // --- 9. КАТАЛОГИ УСЛУГ ---
    if (action === "transfer_terms") return res.json({ result: "ok", comission: "0", min_amount: "1", max_amount: "15000", max_daily_amount: "50000", max_monthly_amount: "100000" });
    if (action === "offer_text" || action === "get_oferta") return res.json({ result: "ok", offer_id: "v1", offer: "Добро пожаловать в эмулятор МегаФон Деньги!" });

    if (action === "get_catalog" || action === "catalog_list") {
        if (reqData.cache_id === catalogCacheId) return res.json({ result: "cache" });
        return cachedCatalog ? res.json(cachedCatalog) : res.json({ result: "error", text: "Каталог недоступен" });
    }

    if (["good_by_id", "good_from_by_id"].includes(action)) {
        const good_id = reqData.good_id || reqData.goods_id;
        fs.readFile(`good_${good_id}.txt`, 'utf8', (err, data) => {
            if (!err) { try { return res.json(JSON.parse(data)); } catch(e) {} }
            return res.json({ result: "ok", good_id: good_id, name: "Неизвестная услуга", fields: [{ name: "account", type: "text", required: "1" }, { name: "sum", type: "text", required: "1" }]});
        });
        return; 
    }

    return res.json({ result: "ok" });
});

// ==========================================
// 🌐 WEBVIEW (ЭКВАЙРИНГ С ЛОГИКОЙ БД)
// ==========================================
app.all('/fake_gateway', (req, res) => {
    const payment_id = req.body.payment_id || req.query.payment_id || "TRX_TEST";
    const amount = req.body.amount || req.query.amount || "0";
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body { font-family: Arial; text-align: center; padding: 20px; } .card { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); } .btn { background: #00B956; color: white; padding: 15px; width: 100%; border: none; border-radius: 5px; font-size: 18px; cursor: pointer; }</style></head><body><div class="card"><h2 style="color: #00B956;">🔒 Тестовый Эквайринг</h2><p>Транзакция: ${payment_id}</p><h2>${amount > 0 ? amount + ' ₽' : 'Привязка карты'}</h2><form action="/gateway_success" method="POST"><input type="hidden" name="payment_id" value="${payment_id}"><button type="submit" class="btn">Подтвердить</button></form></div></body></html>`);
});

app.post('/gateway_success', (req, res) => {
    const payment_id = req.body.payment_id;
    
    // Смотрим, зачем нас вызывали
    const op = db.prepare('SELECT * FROM pending_ops WHERE transfer_id = ?').get(payment_id);
    if (op) {
        const timeNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
        
        if (op.op_type === "link") {
            // Генерируем новую карту и привязываем
            const cardMasked = "4276 **** **** " + Math.floor(1000 + Math.random() * 9000);
            const cardId = "card_" + crypto.randomBytes(4).toString('hex');
            db.prepare('INSERT INTO cards (phone, card_id, alias, card_number, acquirer_id, card_type) VALUES (?, ?, ?, ?, ?, ?)')
              .run(op.phone, cardId, "Моя новая карта", cardMasked, "1", "VISA");
            notifyAdmin(`💳 Привязка карты через WebView: ${op.phone}`);
            
        } else if (op.op_type === "topup_new_card" || op.op_type === "pay_service_card") {
            // Если пополнение кошелька - начисляем баланс
            if (op.op_type === "topup_new_card") {
                db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(op.amount, op.phone);
            }
            // Пишем в историю переводов
            db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time, good_id, description, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .run((op.op_type === "topup_new_card" ? "BANK_CARD" : op.phone), (op.op_type === "topup_new_card" ? op.phone : 'SERVICE'), op.amount, "ok", timeNow, op.good_id, "Оплата через эквайринг", op.op_type);
            
            notifyAdmin(`✅ Транзакция через WebView завершена!\nТип: ${op.op_type}\nЮзер: ${op.phone}\nСумма: ${op.amount}`);
        }
        // Удаляем операцию из ожидающих
        db.prepare('DELETE FROM pending_ops WHERE transfer_id = ?').run(payment_id);
    }

    res.send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family: sans-serif; text-align: center; margin-top: 50px;"><h2 style="color: green;">✅ Операция выполнена</h2><p>Возвращаемся...</p><script>setTimeout(function(){ window.location.href = 'megafon://success'; }, 2000);</script></body></html>`);
});

// ==========================================
// 👑 ТЕЛЕГРАМ БОТ
// ==========================================
bot.onText(/\/start|\/help/, (msg) => {
    if (msg.from.id.toString() === ADMIN_CHAT_ID.toString()) {
        bot.sendMessage(msg.chat.id, "👑 ПАНЕЛЬ АДМИНА\n/users — Список кошельков\n/add_money <номер> <сумма>\n/add_card <номер> <карта>");
    } else {
        bot.sendMessage(msg.chat.id, "👤 КОШЕЛЕК МЕГАФОН\n/register <номер> <пароль> — Создать профиль\n/my_balance <номер> — Баланс");
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
        if (user && user.tg_chat_id === msg.chat.id.toString()) bot.sendMessage(msg.chat.id, `💰 Баланс: ${user.balance} руб.`);
    } catch(e) {}
});

// АДМИНСКИЕ КОМАНДЫ
bot.onText(/\/users/, (msg) => {
    if (msg.from.id.toString() !== ADMIN_CHAT_ID.toString()) return;
    const users = db.prepare('SELECT phone, password, balance, tg_chat_id FROM users').all();
    if (!users.length) return bot.sendMessage(msg.chat.id, "Пусто.");
    let text = "👥 Кошельки:\n";
    users.forEach(u => text += `📱 ${u.phone} | 🔑 ${u.password} | 💰 ${u.balance} руб | ${u.tg_chat_id ? "✅ ТГ" : "❌ ТГ"}\n`);
    bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/add_money (.+) (.+)/, (msg, match) => {
    if (msg.from.id.toString() !== ADMIN_CHAT_ID.toString()) return;
    try {
        db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(parseFloat(match[2]), match[1]);
        bot.sendMessage(msg.chat.id, `✅ Баланс ${match[1]} пополнен на ${match[2]} руб.`);
    } catch(e) {}
});

app.listen(FLASK_PORT, '2.26.61.185', () => { console.log(`[+] Сервер запущен на порту ${FLASK_PORT}`); });
