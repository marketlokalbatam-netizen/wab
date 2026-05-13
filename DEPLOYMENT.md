# Panduan Deploy Bot Setoran Harian ke VPS

> Panduan ini mencakup cara deploy lengkap ke VPS Linux (Ubuntu 20.04 / 22.04 / Debian 11+) menggunakan PM2 sebagai process manager dan Nginx sebagai reverse proxy.

---

## Daftar Isi

1. [Kebutuhan Sistem](#1-kebutuhan-sistem)
2. [Persiapan VPS](#2-persiapan-vps)
3. [Install Node.js](#3-install-nodejs)
4. [Install Chromium](#4-install-chromium)
5. [Install PM2](#5-install-pm2)
6. [Upload & Setup Aplikasi](#6-upload--setup-aplikasi)
7. [Konfigurasi Environment Variables](#7-konfigurasi-environment-variables)
8. [Jalankan dengan PM2](#8-jalankan-dengan-pm2)
9. [Setup Nginx (Reverse Proxy)](#9-setup-nginx-reverse-proxy)
10. [SSL dengan Certbot (HTTPS)](#10-ssl-dengan-certbot-https)
11. [Firewall](#11-firewall)
12. [Perintah Berguna](#12-perintah-berguna)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Kebutuhan Sistem

| Komponen     | Minimum             |
|--------------|---------------------|
| OS           | Ubuntu 20.04+       |
| RAM          | 1 GB (2 GB disarankan) |
| CPU          | 1 vCore             |
| Disk         | 5 GB free           |
| Node.js      | v18 atau v20        |
| Chromium     | Versi terbaru       |
| Database     | MySQL / MariaDB (bisa remote atau lokal) |

---

## 2. Persiapan VPS

Login ke VPS via SSH:

```bash
ssh root@IP_VPS_ANDA
```

Update sistem:

```bash
apt update && apt upgrade -y
```

Buat user non-root (opsional tapi disarankan):

```bash
adduser botuser
usermod -aG sudo botuser
su - botuser
```

---

## 3. Install Node.js

Gunakan NodeSource untuk Node.js 20 LTS:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verifikasi:

```bash
node -v   # harus v20.x.x
npm -v
```

---

## 4. Install Chromium

Chromium diperlukan oleh whatsapp-web.js untuk menjalankan browser headless.

```bash
sudo apt install -y chromium-browser
```

Cek path Chromium:

```bash
which chromium-browser
# contoh output: /usr/bin/chromium-browser
```

Catat path ini — akan digunakan di environment variable `CHROMIUM_PATH`.

> **Catatan:** Di beberapa distro path bisa `/usr/bin/chromium` atau `/snap/bin/chromium`. Sesuaikan dengan output `which` di atas.

---

## 5. Install PM2

PM2 adalah process manager untuk Node.js yang menjaga bot tetap berjalan dan otomatis restart saat crash.

```bash
sudo npm install -g pm2
```

Agar PM2 otomatis berjalan saat VPS reboot:

```bash
pm2 startup
# Jalankan perintah yang muncul dari output di atas (copy-paste)
```

---

## 6. Upload & Setup Aplikasi

### Cara 1: Menggunakan Git

```bash
cd ~
git clone https://github.com/USERNAME/NAMA_REPO.git bot-setoran
cd bot-setoran
npm install
```

### Cara 2: Upload Manual via SCP (dari komputer lokal)

```bash
# Jalankan dari komputer lokal:
scp -r /path/ke/folder/bot botuser@IP_VPS:/home/botuser/bot-setoran
```

Kemudian di VPS:

```bash
cd /home/botuser/bot-setoran
npm install
```

> `npm install` akan otomatis menjalankan `postinstall` yang menginstall Chrome versi puppeteer (jika dibutuhkan sebagai fallback).

---

## 7. Konfigurasi Environment Variables

Buat file `.env` di folder aplikasi:

```bash
nano /home/botuser/bot-setoran/.env
```

Isi dengan:

```env
# Port aplikasi (Nginx akan proxy ke port ini)
PORT=3000

# Password untuk login ke panel web
PANEL_PASSWORD=password_panel_rahasia

# Password untuk aksi admin (restart/logout bot)
RESTART_PASSWORD=password_aksi_rahasia

# Konfigurasi Database MySQL
DB_HOST=localhost
DB_USER=nama_user_db
DB_PASSWORD=password_db
DB_NAME=nama_database
DB_PORT=3306

# Path Chromium (dari hasil 'which chromium-browser')
CHROMIUM_PATH=/usr/bin/chromium-browser
```

Simpan: `Ctrl+X` → `Y` → `Enter`

Batasi akses file `.env`:

```bash
chmod 600 /home/botuser/bot-setoran/.env
```

---

## 8. Jalankan dengan PM2

### Buat file konfigurasi PM2

```bash
nano /home/botuser/bot-setoran/ecosystem.config.js
```

Isi:

```js
module.exports = {
  apps: [{
    name: 'bot-setoran',
    script: 'index.js',
    cwd: '/home/botuser/bot-setoran',
    env_file: '.env',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    restart_delay: 5000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
```

### Jalankan bot:

```bash
cd /home/botuser/bot-setoran
pm2 start ecosystem.config.js
pm2 save
```

### Cek status:

```bash
pm2 status
pm2 logs bot-setoran
```

---

## 9. Setup Nginx (Reverse Proxy)

Install Nginx:

```bash
sudo apt install -y nginx
```

Buat konfigurasi site:

```bash
sudo nano /etc/nginx/sites-available/bot-setoran
```

Isi (ganti `DOMAIN_ATAU_IP` dengan domain atau IP VPS Anda):

```nginx
server {
    listen 80;
    server_name DOMAIN_ATAU_IP;

    # Batas ukuran upload (opsional)
    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Penting untuk SSE (Log Aktivitas realtime)
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Aktifkan dan test:

```bash
sudo ln -s /etc/nginx/sites-available/bot-setoran /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Panel sekarang bisa diakses di: `http://DOMAIN_ATAU_IP`

---

## 10. SSL dengan Certbot (HTTPS)

> Hanya jika menggunakan domain (bukan bare IP).

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d NAMA_DOMAIN_ANDA
```

Certbot akan otomatis mengubah konfigurasi Nginx ke HTTPS. Sertifikat diperbarui otomatis setiap 90 hari.

---

## 11. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

> Port 3000 **tidak perlu** dibuka ke publik karena Nginx yang menjadi proxy. Biarkan tertutup.

---

## 12. Perintah Berguna

| Perintah | Fungsi |
|----------|--------|
| `pm2 status` | Lihat status semua proses |
| `pm2 logs bot-setoran` | Lihat log realtime di terminal |
| `pm2 restart bot-setoran` | Restart bot |
| `pm2 stop bot-setoran` | Stop bot |
| `pm2 delete bot-setoran` | Hapus dari PM2 |
| `pm2 monit` | Monitor CPU/RAM interaktif |
| `sudo systemctl status nginx` | Cek status Nginx |
| `sudo systemctl reload nginx` | Reload konfigurasi Nginx |
| `sudo nginx -t` | Test konfigurasi Nginx |

---

## 13. Troubleshooting

### Bot tidak bisa scan QR / Chromium crash

```bash
# Pastikan dependencies Chromium lengkap:
sudo apt install -y \
  libgbm-dev libasound2 libatk1.0-0 libcairo2 libcups2 \
  libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 \
  libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 \
  libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
  libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
  libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
  ca-certificates fonts-liberation libappindicator1 \
  libu2f-udev libvulkan1 xdg-utils wget
```

### Port 3000 sudah dipakai

```bash
# Ganti PORT di .env menjadi 3001, 3002, dll, lalu update di Nginx:
# proxy_pass http://127.0.0.1:3001;
pm2 restart bot-setoran
sudo systemctl reload nginx
```

### Sesi WhatsApp hilang setelah restart VPS

Sesi tersimpan di folder `.wwebjs_auth/`. Pastikan folder ini tidak dihapus. Jika hilang, scan QR ulang dari panel.

### Log SSE tidak realtime di Nginx

Pastikan konfigurasi Nginx untuk `/` sudah menyertakan:
```nginx
proxy_buffering off;
proxy_cache off;
chunked_transfer_encoding on;
proxy_set_header Connection '';
```

### Pesan tidak dibalas bot

1. Pastikan bot berstatus "Bot Aktif" di panel (`/`)
2. Cek log di panel (`/logs`) untuk pesan error
3. Pastikan grup WhatsApp sudah benar (bot harus jadi anggota)
4. Pastikan format pesan mengandung "Setoran Harian"
