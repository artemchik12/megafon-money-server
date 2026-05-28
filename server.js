const express = require('express');
const Database = require('better-sqlite3');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ==========================================
// ⚙️ НАСТРОЙКИ СЕРВЕРА
// ==========================================
let config = {
    BOT_TOKEN: "ВАШ_ТОКЕН_ОТ_BOTFATHER",
    ADMIN_CHAT_ID: "ВАШ_CHAT_ID",
    PORT: 4444,
    DATABASE_PATH: "wallet.db",
    CATALOG_PATH: "catalog.txt"
};

if (fs.existsSync('config.json')) {
    try {
        const fileConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));
        config = { ...config, ...fileConfig };
        console.log("[+] Настройки успешно загружены из config.json");
    } catch (e) {
        console.log("[!] Ошибка чтения config.json, используются параметры по умолчанию:", e.message);
    }
} else {
    fs.writeFileSync('config.json', JSON.stringify(config, null, 4), 'utf8');
    console.log("[*] Создан стандартный Файл конфигурации config.json. Пожалуйста, настройте его.");
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('Connection', 'close');
    next();
});

const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });
function notifyAdmin(text) { 
    bot.sendMessage(config.ADMIN_CHAT_ID, text).catch(() => {}); 
}

// ==========================================
// 🔍 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (Нормализатор и Парсер)
// ==========================================
function normalizePhone(phone) {
    if (!phone) return "";
    let cleaned = phone.toString().replace(/\D/g, '');
    if (cleaned.length === 11 && cleaned.startsWith('8')) {
        cleaned = '7' + cleaned.substring(1);
    }
    return cleaned;
}

function extractRecipient(reqData) {
    let phone = reqData.recipient || reqData.receiver_phone || reqData.destination || reqData.account || "";
    if (phone === "") {
        const fieldsArr = reqData.fields || reqData.field_vals;
        if (Array.isArray(fieldsArr)) {
            const phoneField = fieldsArr.find(f => 
                f.name === 'account' || 
                f.name === 'phone' || 
                f.name === 'destination' || 
                f.name === 'receiver_phone' || 
                f.name === 'recipient'
            );
            if (phoneField) phone = phoneField.value;
        }
    }
    return normalizePhone(phone);
}

// ==========================================
// 🗄 БАЗА ДАННЫХ SQLITE
// ==========================================
const db = new Database(config.DATABASE_PATH);

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
if (fs.existsSync(config.CATALOG_PATH)) {
    try {
        cachedCatalog = JSON.parse(fs.readFileSync(config.CATALOG_PATH, 'utf8'));
        catalogCacheId = cachedCatalog.cache_id || catalogCacheId;
    } catch (e) {}
}

app.use(express.static('public'));

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
    const getUserBySid = () => db.prepare('SELECT * FROM users WHERE sid = ?').get(sid);

    if (!["balance", "quick_balance", "balance_widget"].includes(action)) {
        console.log(`\n[>] ЗАПРОС: [${action}]`);
    }

    try {
        // --- 1. АВТОРИЗАЦИЯ И СМС ---
        if (action === "password_get" || action === "get_password") {
            const rawPhone = reqData.msisdn || reqData.username || reqData.login || reqData.phone;
            const phone = normalizePhone(rawPhone);
            
            if (!phone) return res.json({ result: "error", text: "Не указан номер" });
            
            const user = db.prepare('SELECT phone, tg_chat_id FROM users WHERE phone = ?').get(phone);
            
            // Фикс: Больше не создаем учетную запись автоматически
            if (!user) {
                return res.json({ result: "error", text: "Номер не зарегистрирован. Пройдите регистрацию в Telegram-боте." });
            }
            
            const smsCode = Math.floor(100000 + Math.random() * 900000).toString();
            db.prepare('UPDATE users SET sms_code = ? WHERE phone = ?').run(smsCode, phone);
            if (user.tg_chat_id) bot.sendMessage(user.tg_chat_id, `📩 СМС Код: ${smsCode}\nДля авто-ввода: мегафон ${smsCode}`).catch(()=>{});
            return res.json({ result: "ok" });
        }

        if (action === "auth") {
            const rawPhone = reqData.username || reqData.login || reqData.phone || reqData.msisdn || "";
            const phone = normalizePhone(rawPhone);
            const password = reqData.password || reqData.pass || "";
            
            if (phone === "" && sid && sid !== "1") {
                const existingUser = getUserBySid();
                if (existingUser) return res.json({ result: "ok", sid: existingUser.sid, operator: "Мегафон", region: "100", autoupdate_time: 3600, request_logs: [] });
                return res.json({ result: "error", text: "Сессия устарела. Введите логин и пароль." });
            }
            if (phone === "") return res.json({ result: "error", text: "Необходима авторизация" });
            
            const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
            
            // Фикс: Больше не создаем учетную запись автоматически
            if (!user) {
                 return res.json({ result: "error", code: "401", text: "Номер не зарегистрирован. Пройдите регистрацию в Telegram-боте." });
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
            const name = reqData.name || "Мой шаблон";
            const good_id = reqData.good_id || "unknown";
            const fields = JSON.stringify(reqData.fields || reqData.field_vals || []);
            db.prepare('INSERT INTO favorites (phone, name, good_id, fields_json) VALUES (?, ?, ?, ?)').run(user.phone, name, good_id, fields);
            return res.json({ result: "ok" });
        }

        // --- 4. ИСТОРИЯ ПЛАТЕЖЕЙ ---
        if (["transfer_history", "card_history"].includes(action)) {
            const user = getUserBySid();
            if (!user) return res.json({ result: "error", code: "401" });
            const history = db.prepare("SELECT * FROM transfers WHERE sender_phone = ? OR receiver_phone = ? ORDER BY id DESC LIMIT 50").all(user.phone, user.phone);
            
            const formatHistory = history.map(t => ({
                transfer_id: t.id.toString(), bill_id: t.id.toString(), good_id: t.good_id || "service", description: t.description || "Операция",
                datetime: t.date_time, date: t.date_time, amount: t.amount, status: t.status, status_message: "Успешно"
            }));
            return res.json({ result: "ok", count: formatHistory.length.toString(), transfers: formatHistory });
        }
        if (["get_transfers_outgoing", "remittance_outgoing"].includes(action)) {
            const user = getUserBySid();
            if (!user) return res.json({ result: "error", code: "401" });
            const history = db.prepare("SELECT * FROM transfers WHERE sender_phone = ? AND type = 'p2p' ORDER BY id DESC LIMIT 50").all(user.phone);
            const formatHistory = history.map(t => ({ transfer_id: t.id.toString(), amount: t.amount.toString(), commission: "0", date: t.date_time, status: t.status, status_date: t.date_time, comment: t.description || "Перевод по номеру", recipient: t.receiver_phone }));
            return res.json({ result: "ok", count: formatHistory.length.toString(), transfers: formatHistory });
        }
        if (["get_transfers_incoming", "remittance_incoming", "remittance_incoming_update"].includes(action)) {
            const user = getUserBySid();
            if (!user) return res.json({ result: "error", code: "401" });
            const history = db.prepare("SELECT * FROM transfers WHERE receiver_phone = ? ORDER BY id DESC LIMIT 50").all(user.phone);
            const formatHistory = history.map(t => ({ transfer_id: t.id.toString(), amount: t.amount.toString(), sender: t.sender_phone, status: t.status, status_date: t.date_time, comment: t.description || "Входящий перевод" }));
            return res.json({ result: "ok", count: formatHistory.length.toString(), transfers: formatHistory });
        }

        // --- 5. ОПЛАТА УСЛУГ (С БАЛАНСА КОШЕЛЬКА) ---
        if (["transfer_add", "add_transfer", "pay_service", "pay", "transfer"].includes(action) || 
           (action === "transfer_init" && reqData.method === "megafon")) {
            
            const user = getUserBySid();
            if (!user) return res.json({ result: "error", code: "401" });

            let amount = parseFloat(reqData.amount || reqData.sum || reqData.request_amount || 0);

            const fieldsArr = reqData.fields || reqData.field_vals;
            if (amount <= 0 && Array.isArray(fieldsArr)) {
                const sumField = fieldsArr.find(f => f.name === 'sum' || f.name === 'amount');
                if (sumField) amount = parseFloat(sumField.value);
            }

            if (amount <= 0) return res.json({ result: "error", text: "Ошибка: Сервер не нашел сумму платежа!" });
            if (user.balance < amount) return res.json({ result: "error", text: "Недостаточно средств на балансе!" });

            const good_id = reqData.goods_id || reqData.good_id || "service";
            db.prepare('UPDATE users SET balance = balance - ? WHERE phone = ?').run(amount, user.phone);
            
            const timeNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
            const info = db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time, good_id, description, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                           .run(user.phone, 'SERVICE', amount, "ok", timeNow, good_id, "Оплата услуги", "service_pay");
            
            notifyAdmin(`🛒 ОПЛАТА УСЛУГ!\nКошелек: ${user.phone}\nУслуга: ${good_id}\nСумма: ${amount} руб.`);
            return res.json({ result: "ok", transfer_id: info.lastInsertRowid.toString() });
        }

        // --- 6. P2P ПЕРЕВОДЫ (С БАЛАНСА КОШЕЛЬКА) ---
        if (action === "send_transfer_msisdn") {
            const sender = getUserBySid();
            const receiver_phone = extractRecipient(reqData);
            
            let amount = parseFloat(reqData.amount || reqData.sum || 0);
            
            if (!sender) return res.json({ result: "error", code: "401" });
            if (receiver_phone === "") return res.json({ result: "error", text: "Не указан получатель платежа" });
            
            // Фикс: Переводы доступны только на 7926
            if (!receiver_phone.startsWith("7926") || receiver_phone.length !== 11) {
                return res.json({ result: "error", text: "Переводы доступны только на номера МегаФон Москва (7926)" });
            }
            
            if (sender.balance < amount) return res.json({ result: "error", text: "Недостаточно средств" });
            
            let receiver = db.prepare('SELECT phone, tg_chat_id FROM users WHERE phone = ?').get(receiver_phone);
            
            if (!receiver) {
                db.prepare('INSERT INTO users (phone, password, sid, balance) VALUES (?, ?, ?, ?)').run(receiver_phone, '', null, 0.0);
                receiver = { phone: receiver_phone, tg_chat_id: null };
                notifyAdmin(`🔔 Авто-создан новый профиль для получателя перевода: ${receiver_phone}`);
            }

            db.prepare('UPDATE users SET balance = balance - ? WHERE phone = ?').run(amount, sender.phone);
            db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(amount, receiver_phone);
            
            const timeNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
            const info = db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time, description, type) VALUES (?, ?, ?, ?, ?, ?, ?)')
                           .run(sender.phone, receiver_phone, amount, "ok", timeNow, "Перевод по номеру", "p2p");
            
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
        if (action === "fill_balance" || action === "refill_balance") {
            const user = getUserBySid();
            if (!user) return res.json({ result: "error", code: "401" });
            
            let amount = parseFloat(reqData.amount || reqData.sum || 0);

            if (amount <= 0) return res.json({ result: "error", text: "Сумма <= 0" });
            
            db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(amount, user.phone);
            const info = db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time, description, type) VALUES (?, ?, ?, ?, ?, ?, ?)')
                           .run(`CARD_${reqData.card_id||""}`, user.phone, amount, "ok", new Date().toISOString().replace('T', ' ').substring(0, 19), "Пополнение с карты", "topup");
                           
            if (user.tg_chat_id) bot.sendMessage(user.tg_chat_id, `💳 Пополнение баланса с карты на ${amount} руб.`).catch(()=>{});
            return res.json({ result: "ok", transfer_id: info.lastInsertRowid.toString() });
        }

        // --- 8. ЭКВАЙРИНГ И WEBVIEW ---
        if (["transfer_init", "send_transfer_card", "link_card"].includes(action)) {
            const user = getUserBySid();
            if (!user) return res.json({ result: "error", code: "401" });

            let amount = action === "link_card" ? 0 : parseFloat(reqData.amount || reqData.sum || reqData.request_amount || 0);
            
            const fieldsArr = reqData.fields || reqData.field_vals;
            if (amount === 0 && Array.isArray(fieldsArr)) {
                const sumField = fieldsArr.find(f => f.name === 'sum' || f.name === 'amount');
                if (sumField) amount = parseFloat(sumField.value);
            }

            const transfer_id = "trx_" + Math.floor(100000 + Math.random() * 900000);
            let op_type = "topup_new_card";
            let target = ""; 

            if (action === "link_card") {
                op_type = "link";
            } else {
                const extracted = extractRecipient(reqData);
                if (extracted !== "") {
                    op_type = "p2p_card";
                    target = extracted;
                } else if (reqData.goods_id || reqData.good_id) {
                    op_type = "pay_service_card";
                    target = reqData.goods_id || reqData.good_id;
                }
            }

            db.prepare('INSERT INTO pending_ops (transfer_id, phone, op_type, amount, good_id) VALUES (?, ?, ?, ?, ?)').run(transfer_id, user.phone, op_type, amount, target);
            const acquirer_url = `http://${req.get('host')}/fake_gateway`;
            return res.json({ result: "ok", transfer_id: transfer_id, acquirer_url: acquirer_url, acquirer_post: { payment_id: transfer_id, amount: amount.toString() }});
        }

        if (action === "transfer_result") return res.json({ result: "ok", transfer_id: reqData.transfer_id || "", transfer_complete: "1", transfer_status: "ok", error_message: "✅ Платеж успешно проведен!" });

        // --- 9. КАТАЛОГИ УСЛУГ ---
        if (action === "transfer_terms" || action === "get_transfer_terms") return res.json({ result: "ok", comission: "0", min_amount: "1", max_amount: "15000", max_daily_amount: "50000", max_monthly_amount: "100000" });
        if (action === "offer_text" || action === "get_oferta") return res.json({ result: "ok", offer_id: "v1", offer: "Добро пожаловать в эмулятор МегаФон Деньги!" });

        if (action === "get_catalog" || action === "catalog_list") {
            if (reqData.cache_id === catalogCacheId) return res.json({ result: "cache" });
            return cachedCatalog ? res.json(cachedCatalog) : res.json({ result: "error", text: "Каталог недоступен" });
        }

        if (["good_by_id", "good_from_by_id"].includes(action)) {
            const good_id = reqData.good_id || reqData.goods_id;
            fs.readFile(`good_${good_id}.txt`, 'utf8', (err, data) => {
                if (!err) { try { return res.json(JSON.parse(data)); } catch(e) {} }
                return res.json({ result: "ok", good_id: good_id, name: "Услуга", fields: [{ name: "account", type: "text", required: "1" }, { name: "sum", type: "text", required: "1" }]});
            });
            return; 
        }

        // --- 10. ВЫВОД СРЕДСТВ ---
        if (action === "get_transfer_receive_methods") {
            if (fs.existsSync('transfer_methods.txt')) {
                 return res.json(JSON.parse(fs.readFileSync('transfer_methods.txt', 'utf8')));
            }
            return res.json({ result: "ok", methods: [
                { method: "card", description: "Вывод на карту", fields: [{ name: "card_number", description: "Номер карты", type: "number", limit: "16", required: "1" }] },
                { method: "bank_account", description: "Вывод на счет", fields: [{ name: "account", description: "Номер счета", type: "number", limit: "20", required: "1" }, { name: "bik", description: "БИК", type: "number", limit: "9", required: "1" }] }
            ]});
        }

        // --- 11. СПИСОК РЕГИОНОВ ---
        if (action === "get_regions" || action === "mobstudio.mfexpress.get_regions") {
            return res.json({
                result: "ok",
                regions: [
                    { region_id: "100", region_name: "Столичный" },
                    { region_id: "101", region_name: "Кавказский" },
                    { region_id: "102", region_name: "Поволжский" },
                    { region_id: "103", region_name: "Северо-Западный" },
                    { region_id: "104", region_name: "Центральный" },
                    { region_id: "105", region_name: "Сибирский" },
                    { region_id: "106", region_name: "Дальневосточный" },
                    { region_id: "107", region_name: "Уральский" }
                ]
            });
        }

        // --- 12. ОТПРАВКА КВИТАНЦИИ (ЧЕКА) ---
        if (action === "transfer_receipt") {
            const email = reqData.email || "не указан";
            const transfer_id = reqData.transfer_id || "неизвестно";
            const user = getUserBySid();
            const phoneStr = user ? user.phone : "Неизвестный";
            notifyAdmin(`🧾 ЗАПРОС КВИТАНЦИИ!\nКошелек: ${phoneStr}\nТранзакция: ${transfer_id}\nОтправлено на Email: ${email}`);
            return res.json({ result: "ok", text: "Квитанция успешно отправлена на указанный адрес." });
        }

        // --- 13. ПОЛУЧЕНИЕ ВХОДЯЩЕГО ПЕРЕВОДА (Вывод средств) ---
        if (action === "receive_transfer") {
            const user = getUserBySid();
            if (!user) return res.json({ result: "error", code: "401" });

            const transferId = reqData.transfer_id || "1";
            const method = reqData.method || "msisdn";

            const tx = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
            let amount = 500; 

            if (tx) {
                amount = tx.amount;
                db.prepare('UPDATE transfers SET status = ? WHERE id = ?').run('ok', transferId);
            }

            let methodText = "На счет телефона (баланс кошелька)";
            
            if (method === "msisdn") {
                db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(amount, user.phone);
            } else if (method === "card") {
                const fields = reqData.fields || [];
                const cardField = Array.isArray(fields) ? fields.find(f => f.name === 'card') : null;
                const cardNum = cardField ? cardField.value : "неизвестно";
                methodText = `На банковскую карту (${cardNum})`;
            } else if (method === "unistream") {
                methodText = "Наличными в отделении Юнистрим";
            }

            notifyAdmin(`📥 ПЕРЕВОД ПОЛУЧЕН!\nКошелек: ${user.phone}\nСумма: ${amount} руб.\nСпособ получения: ${methodText}`);

            return res.json({
                result: "ok",
                transfer_id: transferId,
                error_message: `✅ Перевод на сумму ${amount} руб. успешно получен!`
            });
        }

        // =========================================================
        // 🚨 ЛОВУШКА НЕИЗВЕСТНЫХ МЕТОДОВ
        // =========================================================
        console.log(`\n===========================================`);
        console.log(`[❌] НЕОБРАБОТАННЫЙ МЕТОД: ${action}`);
        console.log(`Данные:`, reqData);
        console.log(`===========================================\n`);
        
        return res.json({ result: "error", text: `Метод ${action} не обработан сервером` });

    } finally {
        // Очистка соединения
    }
});

// ==========================================
// 🌐 WEBVIEW (ЭКВАЙРИНГ В РУБЛЯХ)
// ==========================================
app.all('/fake_gateway', (req, res) => {
    const payment_id = req.body.payment_id || req.query.payment_id || "TRX_TEST";
    const amount = req.body.amount || req.query.amount || "0";
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body { font-family: Arial; text-align: center; padding: 20px; } .card { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); } .btn { background: #00B956; color: white; padding: 15px; width: 100%; border: none; border-radius: 5px; font-size: 18px; cursor: pointer; }</style></head><body><div class="card"><h2 style="color: #00B956;">🔒 Тестовый Эквайринг</h2><p>Транзакция: ${payment_id}</p><h2>${amount > 0 ? parseFloat(amount) + ' ₽' : 'Привязка карты'}</h2><form action="/gateway_success" method="POST"><input type="hidden" name="payment_id" value="${payment_id}"><button type="submit" class="btn">Подтвердить</button></form></div></body></html>`);
});

app.post('/gateway_success', (req, res) => {
    const payment_id = req.body.payment_id;
    const op = db.prepare('SELECT * FROM pending_ops WHERE transfer_id = ?').get(payment_id);
    
    if (op) {
        const timeNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
        if (op.op_type === "link") {
            const cardMasked = "4276 **** **** " + Math.floor(1000 + Math.random() * 9000);
            const cardId = "card_" + crypto.randomBytes(4).toString('hex');
            db.prepare('INSERT INTO cards (phone, card_id, alias, card_number, acquirer_id, card_type) VALUES (?, ?, ?, ?, ?, ?)').run(op.phone, cardId, "Новая карта", cardMasked, "1", "VISA");
        } else if (op.op_type === "topup_new_card") {
            db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(op.amount, op.phone);
            db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time, description, type) VALUES (?, ?, ?, ?, ?, ?, ?)').run("BANK_CARD", op.phone, op.amount, "ok", timeNow, "Пополнение с карты", "topup");
        } else if (op.op_type === "p2p_card") {
            const receiver_phone = op.good_id;
            
            // Фикс 7926 при оплате с карты
            if (!receiver_phone.startsWith("7926") || receiver_phone.length !== 11) {
                notifyAdmin(`⚠️ Попытка перевода с карты на некорректный номер: ${receiver_phone}`);
                return;
            }

            const receiverExists = db.prepare('SELECT phone FROM users WHERE phone = ?').get(receiver_phone);
            if (!receiverExists) {
                db.prepare('INSERT INTO users (phone, password, sid, balance) VALUES (?, ?, ?, ?)').run(receiver_phone, '', null, 0.0);
                notifyAdmin(`🔔 Авто-создан кошелек получателя при переводе с карты: ${receiver_phone}`);
            }

            db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(op.amount, receiver_phone);
            db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time, description, type) VALUES (?, ?, ?, ?, ?, ?, ?)').run(op.phone, receiver_phone, op.amount, "ok", timeNow, "Перевод с банк. карты", "p2p");
            
            const receiver = db.prepare('SELECT tg_chat_id FROM users WHERE phone = ?').get(receiver_phone);
            if (receiver && receiver.tg_chat_id) bot.sendMessage(receiver.tg_chat_id, `💸 ВАМ ПЕРЕВОД С КАРТЫ!\nОт: ${op.phone}\nСумма: ${op.amount} руб.`).catch(()=>{});
        } else if (op.op_type === "pay_service_card") {
            db.prepare('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time, good_id, description, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(op.phone, "SERVICE", op.amount, "ok", timeNow, op.good_id, "Оплата услуги с карты", "service_pay");
        }
        db.prepare('DELETE FROM pending_ops WHERE transfer_id = ?').run(payment_id);
    }
    res.send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family: sans-serif; text-align: center; margin-top: 50px;"><h2 style="color: green;">✅ Операция выполнена</h2><p>Возвращаемся...</p><script>setTimeout(function(){ window.location.href = 'megafon://success'; }, 2000);</script></body></html>`);
});

// ==========================================
// 👑 ТЕЛЕГРАМ БОТ
// ==========================================
bot.onText(/\/start|\/help/, (msg) => {
    if (msg.from.id.toString() === config.ADMIN_CHAT_ID.toString()) {
        bot.sendMessage(msg.chat.id, "👑 ПАНЕЛЬ АДМИНА\n/users — Список кошельков\n/add_money <номер> <сумма>\n/add_card <номер> <карта>");
    } else {
        bot.sendMessage(msg.chat.id, "👤 КОШЕЛЕК МЕГАФОН\n/register <номер> <пароль> — Создать профиль\n/my_balance <номер> — Баланс");
    }
});

bot.onText(/\/register/, (msg) => {
    const parts = msg.text.split(' ');
    if (parts.length !== 3) return bot.sendMessage(msg.chat.id, "⚠️ Формат: /register 7926000000 123456");
    const phone = normalizePhone(parts[1]), password = parts[2], tgChatId = msg.chat.id.toString();
    
    // Фикс 7926
    if (!phone.startsWith("7926") || phone.length !== 11) {
        return bot.sendMessage(msg.chat.id, "❌ Регистрация доступна только для номеров начинающихся с 7926.");
    }

    try {
        const user = db.prepare('SELECT phone FROM users WHERE phone = ?').get(phone);
        if (user) {
            db.prepare('UPDATE users SET password = ?, tg_chat_id = ? WHERE phone = ?').run(password, tgChatId, phone);
            bot.sendMessage(msg.chat.id, `🔄 Телеграм привязан к ${phone}, пароль обновлен.`);
        } else {
            db.prepare('INSERT INTO users (phone, password, sms_code, sid, balance, tg_chat_id) VALUES (?, ?, NULL, NULL, ?, ?)').run(phone, password, 1000.0, tgChatId);
            bot.sendMessage(msg.chat.id, `✅ Кошелек ${phone} создан!\nВам начислено: 1000 руб.`);
        }
    } catch(e) {}
});

bot.onText(/\/my_balance (.+)/, (msg, match) => {
    try {
        const phone = normalizePhone(match[1]);
        const user = db.prepare('SELECT balance, tg_chat_id FROM users WHERE phone = ?').get(phone);
        if (user && user.tg_chat_id === msg.chat.id.toString()) bot.sendMessage(msg.chat.id, `💰 Баланс: ${user.balance} руб.`);
    } catch(e) {}
});

bot.onText(/\/users/, (msg) => {
    if (msg.from.id.toString() !== config.ADMIN_CHAT_ID.toString()) return;
    const users = db.prepare('SELECT phone, password, balance, tg_chat_id FROM users').all();
    if (!users.length) return bot.sendMessage(msg.chat.id, "Пусто.");
    let text = "👥 Кошельки:\n";
    users.forEach(u => text += `📱 ${u.phone} | 🔑 ${u.password} | 💰 ${u.balance} руб | ${u.tg_chat_id ? "✅ ТГ" : "❌ ТГ"}\n`);
    bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/add_money (.+) (.+)/, (msg, match) => {
    if (msg.from.id.toString() !== config.ADMIN_CHAT_ID.toString()) return;
    try {
        const phone = normalizePhone(match[1]);
        db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(parseFloat(match[2]), phone);
        bot.sendMessage(msg.chat.id, `✅ Баланс ${match[1]} пополнен.`);
    } catch(e) {}
});


// ==========================================
// 🖥 WEB-ИНТЕРФЕЙС (ПАНЕЛЬ АДМИНИСТРАТОРА)
// ==========================================
app.get('/api/admin/stats', (req, res) => {
    try {
        const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        const totalBalance = db.prepare('SELECT SUM(balance) as sum FROM users').get().sum || 0;
        const totalTransfers = db.prepare('SELECT COUNT(*) as count FROM transfers').get().count;
        res.json({ totalUsers, totalBalance, totalTransfers });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', (req, res) => {
    try {
        const users = db.prepare('SELECT phone, password, balance, tg_chat_id FROM users').all();
        const cards = db.prepare('SELECT * FROM cards').all();
        const result = users.map(u => {
            const userCards = cards.filter(c => c.phone === u.phone).map(c => ({ card_number: c.card_number, alias: c.alias, card_type: c.card_type }));
            return { ...u, cards: userCards };
        });
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/add_money', (req, res) => {
    const { phone, amount } = req.body;
    try {
        const normPhone = normalizePhone(phone);
        db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?').run(parseFloat(amount), normPhone);
        res.json({ result: 'ok' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/add_card', (req, res) => {
    const { phone, card_number, alias } = req.body;
    try {
        const normPhone = normalizePhone(phone);
        let cardType = "MasterCard";
        if (card_number.startsWith("4")) cardType = "VISA";
        else if (card_number.startsWith("2")) cardType = "MIR";
        
        const cardMasked = card_number.length >= 12 ? `${card_number.substring(0, 4)} **** **** ${card_number.slice(-4)}` : card_number;
        const cardId = "card_" + crypto.randomBytes(4).toString('hex');
        
        db.prepare('INSERT INTO cards (phone, card_id, alias, card_number, acquirer_id, card_type) VALUES (?, ?, ?, ?, ?, ?)')
          .run(normPhone, cardId, alias || "Новая карта", cardMasked, "1", cardType);
        res.json({ result: 'ok' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Панель управления МегаФон Деньги</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #121212; color: #e0e0e0; margin: 0; padding: 20px; }
            .container { max-width: 1200px; margin: 0 auto; }
            header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #00B956; padding-bottom: 10px; margin-bottom: 30px; }
            h1 { color: #00B956; margin: 0; }
            .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 40px; }
            .stat-card { background-color: #1e1e1e; border: 1px solid #333; padding: 20px; border-radius: 8px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
            .stat-card h3 { margin: 0 0 10px 0; color: #888; font-size: 14px; text-transform: uppercase; }
            .stat-card p { margin: 0; font-size: 28px; font-weight: bold; color: #00B956; }
            .table-container { background-color: #1e1e1e; border: 1px solid #333; border-radius: 8px; padding: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
            h2 { color: #00B956; margin-top: 0; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; text-align: left; }
            th, td { padding: 12px; border-bottom: 1px solid #333; }
            th { color: #888; text-transform: uppercase; font-size: 12px; }
            tr:hover { background-color: #252525; }
            .btn { background-color: #00B956; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: bold; margin-right: 5px; transition: background 0.2s; }
            .btn:hover { background-color: #009e49; }
            .btn-blue { background-color: #0056b3; }
            .btn-blue:hover { background-color: #004085; }
            .card-badge { display: inline-block; background-color: #333; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-right: 5px; border: 1px solid #444; }
        </style>
    </head>
    <body>
        <div class="container">
            <header>
                <h1>🟢 МегаФон Деньги</h1>
                <div>Web Админка v1.0</div>
            </header>

            <div class="stats-grid">
                <div class="stat-card">
                    <h3>Всего кошельков</h3>
                    <p id="stat-users">0</p>
                </div>
                <div class="stat-card">
                    <h3>Общий баланс</h3>
                    <p id="stat-balance">0 ₽</p>
                </div>
                <div class="stat-card">
                    <h3>Всего транзакций</h3>
                    <p id="stat-transfers">0</p>
                </div>
            </div>

            <div class="table-container">
                <h2>📱 Список пользователей</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Номер (Логин)</th>
                            <th>Пароль</th>
                            <th>Баланс</th>
                            <th>Telegram Chat ID</th>
                            <th>Привязанные карты</th>
                            <th>Действия</th>
                        </tr>
                    </thead>
                    <tbody id="users-tbody">
                        <tr><td colspan="6" style="text-align: center; color: #888;">Загрузка данных...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <script>
            async function loadStats() {
                try {
                    const res = await fetch('/api/admin/stats');
                    const data = await res.json();
                    document.getElementById('stat-users').innerText = data.totalUsers;
                    document.getElementById('stat-balance').innerText = data.totalBalance.toLocaleString() + ' ₽';
                    document.getElementById('stat-transfers').innerText = data.totalTransfers;
                } catch (e) { console.error(e); }
            }

            async function loadUsers() {
                try {
                    const res = await fetch('/api/admin/users');
                    const users = await res.json();
                    const tbody = document.getElementById('users-tbody');
                    tbody.innerHTML = '';

                    users.forEach(u => {
                        const tr = document.createElement('tr');
                        let cardsHtml = '';
                        if (u.cards && u.cards.length > 0) {
                            u.cards.forEach(c => {
                                cardsHtml += \`<span class="card-badge">\${c.card_type} (\${c.card_number.slice(-4)})</span>\`;
                            });
                        } else {
                            cardsHtml = '<span style="color: #666; font-size: 12px;">Нет карт</span>';
                        }

                        tr.innerHTML = \`
                            <td style="font-weight: bold; color: #00B956;">\${u.phone}</td>
                            <td><code>\${u.password || 'Нет'}</code></td>
                            <td style="font-weight: bold;">\${u.balance.toLocaleString()} ₽</td>
                            <td>\${u.tg_chat_id ? '✅ ' + u.tg_chat_id : '❌'}</td>
                            <td>\${cardsHtml}</td>
                            <td>
                                <button class="btn" onclick="addMoney('\${u.phone}')">💰 Пополнить</button>
                                <button class="btn btn-blue" onclick="addCard('\${u.phone}')">💳 Выдать карту</button>
                            </td>
                        \`;
                        tbody.appendChild(tr);
                    });
                } catch (e) { console.error(e); }
            }

            async function addMoney(phone) {
                const amount = prompt("Введите сумму пополнения для " + phone + ":");
                if (!amount || isNaN(amount)) return;

                const res = await fetch('/api/admin/add_money', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone, amount })
                });
                if (res.ok) {
                    loadStats();
                    loadUsers();
                }
            }

            async function addCard(phone) {
                const cardNumber = prompt("Введите 16-значный номер карты для " + phone + ":");
                if (!cardNumber || cardNumber.length < 12) return;
                const alias = prompt("Введите название карты (например, Сбербанк):", "Моя карта");

                const res = await fetch('/api/admin/add_card', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone, card_number: cardNumber, alias })
                });
                if (res.ok) {
                    loadUsers();
                }
            }

            loadStats();
            loadUsers();
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.use((req, res, next) => {
    req.getDb = () => db;
    next();
});

function get_db_connection() {
    return {
        close: () => {} 
    };
}

app.listen(config.PORT, '0.0.0.0', () => { console.log(`[+] Сервер запущен на порту \${config.PORT}`); });
