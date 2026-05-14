import sqlite3
import json
import uuid
import threading
import random
import os
from datetime import datetime
from flask import Flask, request, jsonify
import telebot

# ==========================================
# ⚙️ НАСТРОЙКИ СЕРВЕРА
# ==========================================
BOT_TOKEN = "ВАШ_ТОКЕН_ОТ_BOTFATHER"  # Вставьте токен вашего бота
ADMIN_CHAT_ID = "ВАШ_CHAT_ID"         # Вставьте ваш Chat ID (узнать у @userinfobot)
FLASK_PORT = 4444                     # Порт сервера

app = Flask(__name__)
bot = telebot.TeleBot(BOT_TOKEN)

# ==========================================
# 🗄 БАЗА ДАННЫХ SQLITE
# ==========================================
def get_db_connection():
    conn = sqlite3.connect('wallet.db', check_same_thread=False)
    conn.row_factory = sqlite3.Row 
    return conn

def init_db():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users (
                    phone TEXT PRIMARY KEY,
                    password TEXT,
                    sid TEXT,
                    balance REAL
                 )''')
    c.execute('''CREATE TABLE IF NOT EXISTS transfers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sender_phone TEXT,
                    receiver_phone TEXT,
                    amount REAL,
                    status TEXT,
                    date_time TEXT
                 )''')
    c.execute('''CREATE TABLE IF NOT EXISTS cards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    phone TEXT,
                    card_id TEXT,
                    alias TEXT,
                    card_number TEXT,
                    acquirer_id TEXT,
                    card_type TEXT
                 )''')
    conn.commit()
    conn.close()
    print("[+] База данных SQLite успешно загружена.")

# ==========================================
# 🤖 TELEGRAM БОТ (УПРАВЛЕНИЕ)
# ==========================================
@bot.message_handler(commands=['start', 'help'])
def send_welcome(message):
    text = ("🤖 Привет! Я сервер-эмулятор МегаФон Деньги.\n\n"
            "Доступные команды:\n"
            "👥 /users — Список всех кошельков\n"
            "📝 /register <номер> <пароль> — Создать кошелек\n"
            "💰 /add_money <номер> <сумма> — Начислить деньги\n"
            "💳 /add_card <номер> <карта_16_цифр> [название] — Выдать карту")
    bot.reply_to(message, text)

@bot.message_handler(commands=['register'])
def register_user(message):
    try:
        parts = message.text.split()
        if len(parts) != 3:
            bot.reply_to(message, "⚠️ Формат: /register 79260000000 123456")
            return
        phone, password = parts[1], parts[2]
        conn = get_db_connection()
        user = conn.execute('SELECT phone FROM users WHERE phone = ?', (phone,)).fetchone()
        
        if user:
            conn.execute('UPDATE users SET password = ? WHERE phone = ?', (password, phone))
            bot.reply_to(message, f"🔄 Пароль для {phone} обновлен.")
        else:
            conn.execute('INSERT INTO users (phone, password, sid, balance) VALUES (?, ?, ?, ?)', 
                         (phone, password, None, 1000.0))
            bot.reply_to(message, f"✅ Кошелек {phone} зарегистрирован!\nПароль: {password}\nБаланс: 1000 руб.")
        conn.commit()
        conn.close()
    except Exception as e:
        bot.reply_to(message, f"❌ Ошибка: {e}")

@bot.message_handler(commands=['add_card'])
def add_card(message):
    try:
        parts = message.text.split(maxsplit=3)
        if len(parts) < 3:
            bot.reply_to(message, "⚠️ Формат: /add_card 79260000000 4276111122223333 Зарплатная")
            return
        phone, card_raw = parts[1], parts[2]
        alias = parts[3] if len(parts) > 3 else "Моя карта"
        
        card_type = "MasterCard"
        if card_raw.startswith("4"): card_type = "VISA"
        elif card_raw.startswith("2"): card_type = "MIR"
        
        card_masked = f"{card_raw[:4]} **** **** {card_raw[-4:]}" if len(card_raw) >= 12 else card_raw
        card_id = "card_" + str(uuid.uuid4().hex)[:8]

        conn = get_db_connection()
        if not conn.execute('SELECT phone FROM users WHERE phone = ?', (phone,)).fetchone():
            conn.close()
            bot.reply_to(message, f"❌ Кошелек {phone} не найден!")
            return
            
        conn.execute('''INSERT INTO cards (phone, card_id, alias, card_number, acquirer_id, card_type) 
                        VALUES (?, ?, ?, ?, ?, ?)''', (phone, card_id, alias, card_masked, "1", card_type))
        conn.commit()
        conn.close()
        bot.reply_to(message, f"💳 Карта {card_masked} ({card_type}) выдана кошельку {phone}!")
    except Exception as e:
        bot.reply_to(message, f"❌ Ошибка: {e}")

@bot.message_handler(commands=['users'])
def list_users(message):
    conn = get_db_connection()
    users = conn.execute('SELECT phone, password, balance FROM users').fetchall()
    conn.close()
    if not users:
        bot.reply_to(message, "Пользователей пока нет.")
        return
    text = "👥 Зарегистрированные кошельки:\n"
    for u in users:
        text += f"📱 {u['phone']} | 🔑 {u['password']} | 💰 {u['balance']} руб.\n"
    bot.reply_to(message, text)

@bot.message_handler(commands=['add_money'])
def add_money(message):
    try:
        parts = message.text.split()
        phone, amount = parts[1], float(parts[2])
        conn = get_db_connection()
        conn.execute('UPDATE users SET balance = balance + ? WHERE phone = ?', (amount, phone))
        conn.commit()
        conn.close()
        bot.reply_to(message, f"✅ Баланс {phone} пополнен на {amount} руб.")
    except Exception:
        bot.reply_to(message, "⚠️ Формат: /add_money 79260000000 500")

def run_bot():
    print("[+] Telegram-бот запущен в фоне.")
    bot.infinity_polling()

# ==========================================
# 🌐 WEBVIEW (ФЕЙКОВЫЙ ПЛАТЕЖНЫЙ ШЛЮЗ)
# ==========================================
@app.route('/fake_gateway', methods=['POST', 'GET'])
def fake_gateway():
    payment_id = request.form.get("payment_id", request.args.get("payment_id", "TRX_TEST"))
    amount = request.form.get("amount", request.args.get("amount", "0"))

    return f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Оплата картой</title>
        <style>
            body {{ font-family: Arial, sans-serif; text-align: center; background-color: #f4f4f4; padding: 20px; }}
            .card-box {{ background: white; border-radius: 10px; padding: 20px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); margin-top: 30px; }}
            h2 {{ color: #00B956; }}
            .price {{ font-size: 24px; font-weight: bold; margin: 20px 0; }}
            .btn {{ background-color: #00B956; color: white; padding: 15px; width: 100%; border: none; border-radius: 5px; font-size: 18px; cursor: pointer; }}
            .input-fake {{ border: 1px solid #ccc; padding: 12px; margin-bottom: 10px; width: 90%; border-radius: 5px; background: #eee; color: #777; }}
        </style>
    </head>
    <body>
        <div class="card-box">
            <h2>🔒 Тестовый Эквайринг</h2>
            <p>Заказ: {payment_id}</p>
            <div class="price">{amount} ₽</div>
            <input type="text" class="input-fake" value="4276 0000 0000 0000" readonly>
            <input type="text" class="input-fake" value="12/25" readonly style="width: 40%;">
            <input type="text" class="input-fake" value="CVC" readonly style="width: 40%;">
            <form action="/gateway_success" method="POST">
                <input type="hidden" name="payment_id" value="{payment_id}">
                <button type="submit" class="btn">Подтвердить оплату</button>
            </form>
        </div>
    </body>
    </html>
    """

@app.route('/gateway_success', methods=['POST'])
def gateway_success():
    payment_id = request.form.get("payment_id")
    bot.send_message(ADMIN_CHAT_ID, f"💳 ЭКВАЙРИНГ!\nПользователь успешно подтвердил платеж {payment_id} в окне WebView.")
    return """
    <html>
    <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h2 style="color: #00B956;">✅ Операция выполнена</h2>
        <p>Средства зачислены. Возвращаемся в приложение...</p>
        <div style="margin-top: 30px; font-size: 40px;">💸</div>
        <script>setTimeout(function(){ window.location.href = 'megafon://success'; }, 2000);</script>
    </body>
    </html>
    """

# ==========================================
# 📞 FLASK (ЭМУЛЯТОР API МЕГАФОНА)
# ==========================================
@app.route('/api/odp', methods=['POST'])
def odp_api():
    req_str = request.form.get('request')
    if not req_str:
        return jsonify({"result": "error", "text": "Empty request"})

    try:
        req_data = json.loads(req_str)
    except Exception:
        return jsonify({"result": "error", "text": "Invalid JSON"})

    print(f"\n[>] ПРИШЕЛ ЗАПРОС: {req_data}")
    
    action = req_data.get("method") or req_data.get("action") or req_data.get("request_type", "unknown")
    sid = req_data.get("sid")
    conn = get_db_connection()

    try:
        # --- 1. АВТОРИЗАЦИЯ И СМС ---
        if action == "mobstudio.mfexpress.get_password":
            phone = req_data.get("login") or req_data.get("phone")
            sms_code = str(random.randint(100000, 999999))
            
            user = conn.execute('SELECT phone FROM users WHERE phone = ?', (phone,)).fetchone()
            if user:
                conn.execute('UPDATE users SET password = ? WHERE phone = ?', (sms_code, phone))
            else:
                conn.execute('INSERT INTO users (phone, password, sid, balance) VALUES (?, ?, ?, ?)', 
                             (phone, sms_code, None, 1000.0))
            conn.commit()
            bot.send_message(ADMIN_CHAT_ID, f"📩 СМС Код для входа!\nНомер: {phone}\nКод: {sms_code}\nТекст для авто-ввода: мегафон {sms_code}")
            return jsonify({"result": "ok"})

        elif action == "mobstudio.mfexpress.auth":
            phone = req_data.get("login") or req_data.get("phone")
            password = req_data.get("password") or req_data.get("pass")
            user = conn.execute('SELECT * FROM users WHERE phone = ?', (phone,)).fetchone()
            
            if not user or str(user['password']) != str(password):
                return jsonify({"result": "error", "code": "401", "text": "Неверный пароль"})
                
            new_sid = str(uuid.uuid4().hex)
            conn.execute('UPDATE users SET sid = ? WHERE phone = ?', (new_sid, phone))
            conn.commit()
            bot.send_message(ADMIN_CHAT_ID, f"🔓 Вход в кошелек: {phone}")
            return jsonify({"result": "ok", "sid": new_sid, "operator": "Мегафон", "region": "100", "autoupdate_time": 3600, "request_logs":[]})

        # --- 2. БАЛАНС И ПРОФИЛЬ ---
        elif action in ["mobstudio.mfexpress.balance", "mobstudio.mfexpress.quick_balance", "mobstudio.mfexpress.balance_widget"]:
            user = conn.execute('SELECT balance FROM users WHERE sid = ?', (sid,)).fetchone()
            if user: return jsonify({"result": "ok", "balance": user['balance']})
            return jsonify({"result": "error", "code": "401", "text": "Не авторизован"})

        elif action == "mobstudio.mfexpress.get_msisdn":
            user = conn.execute('SELECT phone FROM users WHERE sid = ?', (sid,)).fetchone()
            return jsonify({"result": "ok", "msisdn": user['phone']} if user else {"result": "error"})

        # --- 3. P2P ПЕРЕВОДЫ ---
        elif action == "mobstudio.mfexpress.send_transfer_msisdn":
            sender = conn.execute('SELECT * FROM users WHERE sid = ?', (sid,)).fetchone()
            receiver_phone = req_data.get("receiver_phone") or req_data.get("destination") 
            amount = float(req_data.get("amount", 0))
            
            if not sender: return jsonify({"result": "error", "code": "401", "text": "Не авторизован"})
            if sender['balance'] < amount: return jsonify({"result": "error", "text": "Недостаточно средств"})
            if not conn.execute('SELECT phone FROM users WHERE phone = ?', (receiver_phone,)).fetchone():
                return jsonify({"result": "error", "text": "Получатель не найден"})

            conn.execute('UPDATE users SET balance = balance - ? WHERE phone = ?', (amount, sender['phone']))
            conn.execute('UPDATE users SET balance = balance + ? WHERE phone = ?', (amount, receiver_phone))
            cursor = conn.execute('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time) VALUES (?, ?, ?, ?, ?)', 
                                  (sender['phone'], receiver_phone, amount, "ok", datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            conn.commit()
            bot.send_message(ADMIN_CHAT_ID, f"💸 ПЕРЕВОД!\nОт: {sender['phone']}\nКому: {receiver_phone}\nСумма: {amount} руб.")
            return jsonify({"result": "ok", "transfer_id": str(cursor.lastrowid)})

        # --- 4. КАРТЫ ---
        elif action == "mobstudio.mfexpress.card_list":
            user = conn.execute('SELECT phone FROM users WHERE sid = ?', (sid,)).fetchone()
            if not user: return jsonify({"result": "error", "code": "401", "text": "Не авторизован"})
            db_cards = conn.execute('SELECT * FROM cards WHERE phone = ?', (user['phone'],)).fetchall()
            cards_list = [{"card_id": c["card_id"], "alias": c["alias"], "card_number": c["card_number"], 
                           "acquirer_id": c["acquirer_id"], "card_type": c["card_type"]} for c in db_cards]
            return jsonify({"result": "ok", "cards": cards_list})

        elif action == "mobstudio.mfexpress.fill_balance":
            user = conn.execute('SELECT * FROM users WHERE sid = ?', (sid,)).fetchone()
            if not user: return jsonify({"result": "error", "code": "401"})
            amount, card_id = float(req_data.get("amount", 0)), req_data.get("card_id", "unknown")
            if amount <= 0: return jsonify({"result": "error", "text": "Сумма <= 0"})
            
            conn.execute('UPDATE users SET balance = balance + ? WHERE phone = ?', (amount, user['phone']))
            cursor = conn.execute('INSERT INTO transfers (sender_phone, receiver_phone, amount, status, date_time) VALUES (?, ?, ?, ?, ?)', 
                                  (f"CARD_{card_id}", user['phone'], amount, "ok", datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            conn.commit()
            bot.send_message(ADMIN_CHAT_ID, f"💳 ПОПОЛНЕНИЕ С КАРТЫ\nКошелек: {user['phone']}\nСумма: {amount} руб.")
            return jsonify({"result": "ok", "transfer_id": str(cursor.lastrowid)})

        # --- 5. ЭКВАЙРИНГ И WEBVIEW ---
        elif action in ["mobstudio.mfexpress.transfer_init", "mobstudio.mfexpress.send_transfer_card", "mobstudio.mfexpress.link_card"]:
            amount = req_data.get("amount", "500")
            transfer_id = "trx_" + str(random.randint(100000, 999999))
            acquirer_url = f"http://{request.host}/fake_gateway"
            return jsonify({
                "result": "ok", "transfer_id": transfer_id, "acquirer_url": acquirer_url,
                "acquirer_post": {"payment_id": transfer_id, "amount": str(amount), "description": "Оплата услуг"}
            })

        elif action == "mobstudio.mfexpress.transfer_result":
            return jsonify({"result": "ok", "transfer_id": req_data.get("transfer_id", ""), "transfer_complete": "1", "transfer_status": "ok", "error_message": ""})

        # --- 6. ЧТЕНИЕ КАТАЛОГА ИЗ TXT ФАЙЛОВ ---
        elif action == "mobstudio.mfexpress.transfer_terms":
            return jsonify({"result": "ok", "comission": "0", "min_amount": "1", "max_amount": "15000", "max_daily_amount": "50000", "max_monthly_amount": "100000"})

        elif action == "mobstudio.mfexpress.catalog_list":
            if os.path.exists('catalog.txt'):
                with open('catalog.txt', 'r', encoding='utf-8') as f:
                    return jsonify(json.load(f))
            else:
                return jsonify({"result": "error", "text": "Файл catalog.txt не найден на сервере"})

        elif action in ["mobstudio.mfexpress.good_by_id", "mobstudio.mfexpress.good_from_by_id"]:
            # Приложение присылает good_id при клике на услугу
            good_id = req_data.get("good_id") or req_data.get("goods_id")
            file_name = f"good_{good_id}.txt"
            
            if os.path.exists(file_name):
                with open(file_name, 'r', encoding='utf-8') as f:
                    return jsonify(json.load(f))
            else:
                print(f"[!] Приложение запросило файл {file_name}, но он не найден. Возвращаем заглушку.")
                return jsonify({
                    "result": "ok",
                    "good_id": good_id,
                    "name": "Неизвестная услуга",
                    "fields": [
                        {"name": "account", "description": "Лицевой счет", "type": "text", "required": "1"},
                        {"name": "sum", "description": "Сумма", "type": "text", "required": "1"}
                    ]
                })

        # --- Неизвестный метод ---
        else:
            print(f"[!] Неизвестный метод API: {action}")
            return jsonify({"result": "ok"})

    finally:
        conn.close()


if __name__ == '__main__':
    # 1. Создаем файлы базы данных
    init_db()
    
    # 2. Запускаем Telegram-бота в отдельном потоке (daemon=True позволяет завершить поток при выходе)
    threading.Thread(target=run_bot, daemon=True).start()
    
    # 3. Проверяем наличие catalog.txt в директории
    if not os.path.exists('catalog.txt'):
        print("[!] ВНИМАНИЕ: Файл catalog.txt не найден! Раздел оплат может не загрузиться.")
        
    # 4. Запускаем основной HTTP-сервер
    print(f"[+] Сервер Flask запущен на http://0.0.0.0:{FLASK_PORT}")
    app.run(host='0.0.0.0', port=FLASK_PORT, debug=False)