# MegaFon Money backend emulator

A full-fledged standalone emulator server (backend) for the old Android application **MegaFon Money** (approximately 2012 year of release). The project was created as part of reverse engineering and the study of the architecture of mobile financial applications of the Android 2.3 - 4.x era.

The server emulates the old MegaFon API (`/api/odp'), allows the application to function fully on the local network, saves the wallet status to the SQLite database, and is managed via a Telegram bot.

## ✨ Features of the implemented server

- **Authorization and sessions:** 'sid` output, 401 error handling.
- **SMS emulation:** Generate one-time login passwords and send them to Telegram.
- **SQLite database:** Storage of profiles (`users`), transaction history (`transfers') and linked bank cards (`cards').
- **P2P Transfers:** Full-fledged transfers by phone number between wallets in the local database.
- **Adding money from a bank card:** Emulation of replenishment of the balance from the linked card (in 1 click).
- **Dynamic catalog:** Return of the original catalog of services (housing and communal services, Internet, games) from the dump `catalog.txt `and `good_*.txt` with dynamic rendering of input fields in the application.
- **Fake Acquiring (WebView):** Interception of payment initialization ('transfer_init') and rendering of the HTML page of the payment gateway directly inside the built-in browser of the application.
- **Telegram Admin Panel:** Full database management (money disbursement, registration, card binding, log monitoring) via a bot.

---

## Client Setup (APK Patching)

The original application is "hardwired" on the combat servers. To make it work with our emulator, you need to redirect traffic.

**Method 1: APK Modification (Recommended)**

0. [Скачайте](https://github.com/artemchik12/megafon-money-server/raw/refs/heads/main/%D0%94%D0%B5%D0%BD%D1%8C%D0%B3%D0%B8_1.1.0.apk ) APK
1. Decompile the APK using [Apktool](https://ibotpeaches .github.io/Apktool/):
   ```bash
   apktool d megafon.apk
   ```
2. Find the endpoint in the `smali` source (usually in `i.smali` or `AsyncTaskC1004i.smali'):
   `https://oplata.megafon.ru/api/odp?gzip=1`
3. Replace it with the IP address of the machine where it is running `server.js ` (for example, your IP on the local Wi-Fi network):
   `http://192.168.1.50:4444/api/odp`
4. Assemble the APK and sign it (for example, using `uber-apk-signer'):
   ```bash
   apktool b megafon -o megafon_mod.apk
   ```

**Method 2: DNS Interception**
If you have Root rights on Android/emulator, add to `/system/etc/hosts` the line:
``text
192.168.1.50 oplata.megafon.ru
``
* (In this case, start the server on port 443 and use HTTPS).*

---

## Disclaimer (Disclaimer)

This project was created ** solely for educational and research purposes**. 
- The project has nothing to do with PJSC MegaFon or MobStudio.
- The server does not contain real payment gateways, does not perform real financial transactions, and does not work with real bank cards. All the "money" inside the SQLite database is virtual (gaming).
- The author is not responsible for the use of this code. The use of the project for attacks, phishing or deception of users is strictly prohibited. The project aims to preserve the history of mobile development and explore legacy client-server architectures.
