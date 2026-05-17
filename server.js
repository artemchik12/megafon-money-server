const express = require('express');
const Database = require('better-sqlite3');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto'); // Встроенный модуль (замена buggy uuid)
const fs = require('fs');

// ==========================================
// ⚙️ НАСТРОЙКИ СЕРВЕРА
// ==========================================
const BOT_TOKEN = "8604140755:AAH20rB8l6ZLsWjrV7Gqg6NPmhK-RuHtl1Q";
const ADMIN_CHAT_ID = "6669736809";
const FLASK_PORT = 4444;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
    // Приказываем старому Android закрывать сокет и не использовать Pooling
    res.setHeader('Connection', 'close');
    next();
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Безопасная отправка в ТГ (не блокирует сервер при сбоях сети)
function notifyAdmin(text) {
    bot.sendMessage(ADMIN_CHAT_ID, text).catch(err => {
        console.log("[!] Ошибка отправки в Telegram:", err.message);
    });
}

// ==========================================
// 🗄 БАЗА ДАННЫХ SQLITE
// ==========================================
const db = new Database('wallet.db');

function initDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            phone TEXT PRIMARY KEY,
            password TEXT,
            sid TEXT,
            balance REAL
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

// ==========================================
// 🚀 КЭШИРОВАНИЕ КАТАЛОГА В ОЗУ
// ==========================================
let cachedCatalog = null;
let catalogCacheId = "20121203175300398"; // Оригинальный ID из дампа МегаФона

if (fs.existsSync('catalog.txt')) {
    try {
        cachedCatalog = JSON.parse(fs.readFileSync('catalog.txt', 'utf8'));
        catalogCacheId = cachedCatalog.cache_id || catalogCacheId;
        console.log("[+] Каталог услуг загружен в оперативную память сервера.");
    } catch (e) {
        console.log("[!] Ошибка парсинга catalog.txt:", e.message);
    }
} else {
    console.log("[!] ВНИМАНИЕ: Файл catalog.txt не найден!");
}

// ==========================================
// 📞 EXPRESS API МЕГАФОНА
// ==========================================
app.post('/api/odp', (req, res) => {
    const reqStr = req.body.request;
    if (!reqStr) return res.json({ result: "error", text: "Empty request" });

    let reqData;
    try {
        reqData = JSON.parse(reqStr);
    } catch (e) {
        return res.json({ result: "error", text: "Invalid JSON" });
    }

    const action = reqData.request || reqData.method || reqData.action || "unknown";
    const sid = reqData.sid;
    
    // Не логируем спам-запросы, чтобы не засорять консоль
    if (!["balance", "quick_balance", "balance_widget"].includes(action)) {
        console.log(`\n[>] ПРИШЕЛ ЗАПРОС: [${action}]`);
    }

    // --- 1. АВТОРИЗАЦИЯ И СМС ---
    if (action === "password_get" || action === "get_password") {
        const phone = reqData.msisdn || reqData.username || reqData.login || reqData.phone;
        if (!phone) return res.json({ result: "error", text: "Нет номера" });

        const smsCode = Math.floor(100000 + Math.random() * 900000).toString();
        const user = db.prepare('SELECT phone FROM users WHERE phone = ?').get(phone);
        
        if (user) {
            db.prepare('UPDATE users SET password = ? WHERE phone = ?').run(smsCode, phone);
        } else {
            db.prepare('INSERT INTO users (phone, password, sid, balance) VALUES (?, ?, ?, ?)').run(phone, smsCode, null, 1000.0);
        }
        notifyAdmin(`📩 СМС Код для входа!\nНомер: ${phone}\nКод: ${smsCode}\nТекст для авто-ввода: мегафон ${smsCode}`);
        return res.json({ result: "ok" });
    }

    if (action === "auth") {
        const phone = reqData.username || reqData.login || reqData.phone || reqData.msisdn || "";
        const password = reqData.password || reqData.pass || "";
        
        // Авто-вход по живой сессии
        if (phone === "" && sid && sid !== "1") {
            const existingUser = db.prepare('SELECT * FROM users WHERE sid = ?').get(sid);
            if (existingUser) {
                return res.json({ result: "ok", sid: existingUser.sid, operator: "Мегафон", region: "100", autoupdate_time: 3600, request_logs: [] });
            } else {
                // ВАЖНО: Убран code: 401, чтобы не было бесконечной петли перезапросов!
                return res.json({ result: "error", text: "Сессия устарела. Введите логин и пароль." });
            }
        }
        
        if (phone === "") {
            return res.json({ result: "error", text: "Необходима авторизация" }); // Тоже без 401
        }
        
        const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
        if (!user) {
             db.prepare('INSERT INTO users (phone, password, sid, balance) VALUES (?, ?, ?, ?)').run(phone, password, null, 1000.0);
             notifyAdmin(`🆕 Создан профиль: ${phone}`);
        } else if (user.password !== password) {
            // Оригинальный сервер возвращал attempt_remain
            return res.json({ result: "error", text: "Неверный пароль", attempt_remain: "3" });
        }
            
        const newSid = crypto.randomBytes(16).toString('hex');
        db.prepare('UPDATE users SET sid = ? WHERE phone = ?').run(newSid, phone);
        notifyAdmin(`🔓 Успешный вход: ${phone}`);
        
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
        return res.json({
            result: "ok",
            profile: [{ code: "profile_1", caption: "Мой профиль", type: "user", value: user ? user.phone : "Неизвестно", list: [] }]
        });
    }

    if (action === "offer_text" || action === "get_oferta") {
        return res.json({ result: "ok", offer_id: "v1", offer: "Добро пожаловать в эмулятор МегаФон Деньги!" });
    }

    // --- 3. P2P ПЕРЕВОДЫ ---
    if (action === "send_transfer_msisdn") {
        const sender = db.prepare('SELECT * FROM users WHERE sid = ?').get(sid);
        const receiver_phone = reqData.receiver_phone || reqData.destination;
        const amount = parseFloat(reqData.amount || 0);
        
        if (!sender) return res.json({ result: "error", code: "401", text: "Не авторизован" });
        if (sender.balance < amount) return res.json({ result: "error", text: "Недостаточно средств" });
        
        const receiver = db.prepare('SELECT phone FROM users WHERE phone = ?').get(receiver_phone);
        if (!receiver) return res.json({ result: "error", text: "Получатель не найден" });

        db.prepare('UPDATE users SET balance = balance - ? WHERE phone = ?').run(amount, sender.phone);
        db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(amount, receiver_phone);
        
        const timeNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const info = db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time) VALUES (?, ?, ?, ?, ?)')
                       .run(sender.phone, receiver_phone, amount, "ok", timeNow);
        
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
                       
        notifyAdmin(`💳 ПОПОЛНЕНИЕ С КАРТЫ\nКошелек: ${user.phone}\nСумма: ${amount} руб.`);
        return res.json({ result: "ok", transfer_id: info.lastInsertRowid.toString() });
    }

    // --- 5. КАТАЛОГИ УСЛУГ (БЫСТРАЯ ОТДАЧА) ---
    if (action === "transfer_terms") {
        return res.json({ result: "ok", comission: "0", min_amount: "1", max_amount: "15000", max_daily_amount: "50000", max_monthly_amount: "100000" });
    }

    if (action === "get_catalog" || action === "catalog_list") {
        // Если телефон просит кэш и он у нас совпадает, отдаем "cache", чтобы телефон не завис от парсинга!
        if (reqData.cache_id === catalogCacheId) {
            return res.json({ result: "cache" });
        }
        if (cachedCatalog) {
            return res.json(cachedCatalog);
        } else {
            return res.json({ result: "error", text: "Каталог недоступен" });
        }
    }

    // Читаем конкретную услугу АСИНХРОННО (чтобы не блокировать сервер)
    if (["good_by_id", "good_from_by_id"].includes(action)) {
        const good_id = reqData.good_id || reqData.goods_id;
        const fileName = `good_${good_id}.txt`;
        
        fs.readFile(fileName, 'utf8', (err, data) => {
            if (!err) {
                try {
                    return res.json(JSON.parse(data));
                } catch(e) {}
            }
            return res.json({
                result: "ok", good_id: good_id, name: "Неизвестная услуга",
                fields: [
                    { name: "account", description: "Лицевой счет", type: "text", required: "1" },
                    { name: "sum", description: "Сумма", type: "text", required: "1" }
                ]
            });
        });
        return; // Важно: предотвращаем переход к заглушкам внизу
    }

    // --- 6. ЭКВАЙРИНГ И WEBVIEW ---
    if (["transfer_init", "send_transfer_card", "link_card"].includes(action)) {
        const amount = reqData.amount || "500";
        const transfer_id = "trx_" + Math.floor(100000 + Math.random() * 900000);
        const acquirer_url = `http://${req.get('host')}/fake_gateway`;
        return res.json({
            result: "ok", transfer_id: transfer_id, acquirer_url: acquirer_url,
            acquirer_post: { payment_id: transfer_id, amount: amount.toString(), description: "Оплата" }
        });
    }

    if (action === "transfer_result") return res.json({ result: "ok", transfer_id: reqData.transfer_id || "", transfer_complete: "1", transfer_status: "ok" });

    // --- 7. ПУСТЫЕ МАССИВЫ (Чтобы UI не падал) ---
    if (action === "transfer_history" || action === "card_history") return res.json({ result: "ok", transfers: [] });
    if (action === "favorites_list") return res.json({ result: "ok", favorites: [] });
    if (action === "get_transfers_incoming" || action === "get_transfers_outgoing") return res.json({ result: "ok", count: "0", transfers: [] });

    // Неизвестные методы отбиваем безопасным "ok"
    return res.json({ result: "ok" });
});

// ==========================================
// 🌐 WEBVIEW (ЭКВАЙРИНГ)
// ==========================================
app.all('/fake_gateway', (req, res) => {
    const payment_id = req.body.payment_id || req.query.payment_id || "TRX_TEST";
    const amount = req.body.amount || req.query.amount || "0";

    res.send(`
    <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    body { font-family: Arial; text-align: center; background: #f4f4f4; padding: 20px; }
    .card { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
    .btn { background: #00B956; color: white; padding: 15px; width: 100%; border: none; border-radius: 5px; font-size: 18px; cursor: pointer; }
    </style></head><body>
        <div class="card">
            <h2 style="color: #00B956;">🔒 Тестовый Эквайринг</h2>
            <p>Заказ: ${payment_id}</p><h2>${amount} ₽</h2>
            <form action="/gateway_success" method="POST">
                <input type="hidden" name="payment_id" value="${payment_id}">
                <button type="submit" class="btn">Подтвердить оплату</button>
            </form>
        </div>
    </body></html>`);
});

app.post('/gateway_success', (req, res) => {
    notifyAdmin(`💳 ЭКВАЙРИНГ!\nПользователь оплатил заказ ${req.body.payment_id}`);
    res.send(`
    <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h2 style="color: green;">✅ Операция выполнена</h2><p>Возвращаемся в приложение...</p>
        <script>setTimeout(function(){ window.location.href = 'megafon://success'; }, 2000);</script>
    </body></html>`);
});

// ==========================================
// 👑 ТЕЛЕГРАМ БОТ И АДМИН-ПАНЕЛЬ
// ==========================================

// 1. Выводим ошибки сети в консоль сервера (если Telegram недоступен)
bot.on("polling_error", (err) => console.log("[!] Ошибка Telegram-бота:", err.message));

// Функция проверки прав (Умная защита)
function isAdmin(msg) {
    if (msg.from.id.toString() === ADMIN_CHAT_ID.toString()) {
        return true;
    } else {
        // Если ID не совпал, бот подскажет правильный ID!
        bot.sendMessage(msg.chat.id, `⛔️ Отказано в доступе!\nВаш Telegram ID: <code>${msg.from.id}</code>\nВпишите его в переменную ADMIN_CHAT_ID в коде сервера.`, {parse_mode: "HTML"});
        return false;
    }
}

bot.onText(/\/start|\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, "🤖 <b>Система МегаФон Деньги</b>\n\n" +
                                 "Доступные команды:\n" +
                                 "📝 /register <номер> <пароль> — Регистрация\n" +
                                 "👥 /users — Список кошельков (Админ)\n" +
                                 "💰 /add_money <номер> <сумма> (Админ)\n" +
                                 "💳 /add_card <номер> <карта> [имя] (Админ)", {parse_mode: "HTML"});
});

// Команда регистрации доступна всем
bot.onText(/\/register (.+) (.+)/, (msg, match) => {
    try {
        const phone = match[1];
        const password = match[2];
        const user = db.prepare('SELECT phone FROM users WHERE phone = ?').get(phone);
        
        if (user) {
            db.prepare('UPDATE users SET password = ? WHERE phone = ?').run(password, phone);
            bot.sendMessage(msg.chat.id, `🔄 Пароль для ${phone} обновлен на: ${password}`);
        } else {
            db.prepare('INSERT INTO users (phone, password, sid, balance) VALUES (?, ?, ?, ?)').run(phone, password, null, 1000.0);
            bot.sendMessage(msg.chat.id, `✅ Кошелек ${phone} успешно зарегистрирован!\nПароль: ${password}\nБонусный баланс: 1000 руб.`);
        }
    } catch(e) { 
        bot.sendMessage(msg.chat.id, `❌ Ошибка: ${e.message}`); 
    }
});

// Админские команды
bot.onText(/\/users/, (msg) => {
    if (!isAdmin(msg)) return;
    
    const users = db.prepare('SELECT phone, password, balance FROM users').all();
    if (!users.length) return bot.sendMessage(msg.chat.id, "Пользователей пока нет.");
    
    let text = "👥 <b>База кошельков:</b>\n";
    users.forEach(u => text += `📱 ${u.phone} | 🔑 ${u.password} | 💰 ${u.balance} руб.\n`);
    bot.sendMessage(msg.chat.id, text, {parse_mode: "HTML"});
});

bot.onText(/\/add_money (.+) (.+)/, (msg, match) => {
    if (!isAdmin(msg)) return;
    
    try {
        const phone = match[1];
        const amount = parseFloat(match[2]);
        db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(amount, phone);
        bot.sendMessage(msg.chat.id, `✅ Баланс ${phone} пополнен на ${amount} руб.`);
    } catch(e) { 
        bot.sendMessage(msg.chat.id, "❌ Ошибка БД. Проверьте правильность номера."); 
    }
});

bot.onText(/\/add_card (.+) (.+)/, (msg, match) => {
    if (!isAdmin(msg)) return;
    
    try {
        const phone = match[1];
        const cardRaw = match[2];
        const alias = msg.text.split(' ').slice(3).join(' ') || "Моя карта"; // Имя карты (опционально)
        
        const cardMasked = cardRaw.length >= 12 ? `${cardRaw.substring(0,4)} **** **** ${cardRaw.slice(-4)}` : cardRaw;
        const cardType = cardRaw.startsWith("4") ? "VISA" : "MasterCard";
        const cardId = "card_" + crypto.randomBytes(4).toString('hex');
        
        db.prepare('INSERT INTO cards (phone, card_id, alias, card_number, acquirer_id, card_type) VALUES (?, ?, ?, ?, ?, ?)')
          .run(phone, cardId, alias, cardMasked, "1", cardType);
          
        bot.sendMessage(msg.chat.id, `💳 Карта ${cardMasked} (${cardType}) успешно привязана к кошельку ${phone}!`);
    } catch(e) { 
        bot.sendMessage(msg.chat.id, "❌ Ошибка привязки карты. Проверьте правильность номера кошелька."); 
    }
});

// Запуск сервера
app.listen(FLASK_PORT, '0.0.0.0', () => {
    console.log(`[+] Сервер запущен на порту ${FLASK_PORT}`);
});
