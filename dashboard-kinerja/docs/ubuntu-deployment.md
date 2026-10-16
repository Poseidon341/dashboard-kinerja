# Deployment Dashboard Funding di Ubuntu

Panduan ini menyiapkan **build Vite → Nginx → backend Shadow API → MySQL**. `npm run dev` dan `vite preview` bukan server production. Jangan mulai sebelum pemilik data menyetujui lokasi, isi, dan backup database production. Panduan ini tidak menjalankan migrasi atau impor.

## 1. Putuskan lokasi database

`MYSQL_HOST=127.0.0.1` pada Ubuntu menunjuk ke **Ubuntu itu sendiri**, bukan laptop Windows. MySQL tidak diasumsikan sudah tersedia.

- Disarankan: sediakan MySQL pada Ubuntu atau host privat yang terkelola, lalu migrasikan database melalui backup/restore terencana dan uji kesetaraan data. Proses ini membutuhkan persetujuan terpisah; jangan menyalin database uji sebagai production tanpa verifikasi.
- Jika MySQL tetap di laptop Windows: hubungkan server melalui jaringan privat/VPN dan TLS MySQL dengan CA yang tepercaya (`MYSQL_SSL_CA_FILE`). Jangan membuka port MySQL ke internet. Laptop harus selalu hidup dan koneksi harus stabil; opsi ini perlu persetujuan pemilik data dan administrator jaringan.

Backend menolak semua target kecuali `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE` **persis sama** dengan `DASHBOARD_PRODUCTION_DB_HOST`, `DASHBOARD_PRODUCTION_DB_PORT`, `DASHBOARD_PRODUCTION_DB_NAME` ketika `DASHBOARD_RUNTIME_ENV=production`. Nilai kosong, wildcard, database/port lain, dan perubahan target hanya pada `MYSQL_*` ditolak. Backend juga memeriksa `DATABASE()` serta `@@port` setelah koneksi. Mode development tanpa `DASHBOARD_RUNTIME_ENV=production` tetap hanya menerima `dashboard_funding_test` pada loopback port 3308. Importer CLI lama tetap dibatasi oleh guard-nya sendiri; opt-in production hanya dipakai pipeline Admin yang sudah terautentikasi.

Database production harus berisi migration 001–003 serta snapshot master dan fakta yang lengkap. API Posisi Dana saat ini mensyaratkan snapshot dasar 1.039.742 baris, dengan 1.038.051 resolved dan 1.691 unresolved. Jika data belum dipindah dan diverifikasi, API akan menolak memuat data; perubahan guard tidak membuat data tersedia secara otomatis.

Gunakan akun MySQL khusus yang hanya memiliki izin pada skema yang disetujui. Selama Admin Upload belum disetujui untuk menulis production, pakai hak baca saja. Jika Admin Upload kemudian diaktifkan, berikan hanya izin tulis yang diperlukan pada tabel staging, batch, dimensi tanggal, fakta, dan publikasi; jangan berikan `DROP`, `TRUNCATE`, atau hak administrator server. Kode saat ini memakai satu pool MySQL untuk API baca dan upload Admin, sehingga pemisahan kredensial baca/tulis belum tersedia.

## 2. Siapkan aplikasi dan environment

Gunakan Node.js yang cocok dengan `package.json`/Vite (Vite terpasang memerlukan Node `^20.19.0 || >=22.12.0`). Contoh direktori di bawah adalah `/opt/dashboard-funding/current`; sesuaikan user dan lokasi sebelum pemasangan.

```bash
node --version
sudo useradd --system --home /opt/dashboard-funding --shell /usr/sbin/nologin dashboardfunding
sudo install -d -m 0755 -o dashboardfunding -g dashboardfunding /opt/dashboard-funding/current
sudo install -d -m 0700 -o root -g root /etc/dashboard-funding
```

Salin **source code** ke `/opt/dashboard-funding/current` melalui mekanisme rilis yang disetujui; jangan sertakan `.env`, workbook, JSON privat, atau backup. Di direktori aplikasi:

```bash
cd /opt/dashboard-funding/current
npm ci
npm run build
```

Tes snapshot Uker, RMFT, dan RKA membutuhkan workbook privat yang tidak masuk Git. Pada mesin pengujian, set `DASHBOARD_TEST_WORKBOOK_PATH` ke path absolut `dashboard_funding.xlsx` di luar checkout, lalu jalankan `node --test scripts/*.test.mjs`. Jangan menyalin workbook ke rilis atau repository. Tes upload yang lain memakai data sintetis.

Salin [.env.production.example](../.env.production.example) ke `/etc/dashboard-funding/backend.env`, set izin root-only, lalu isi dengan editor interaktif. Jangan menaruh password atau hash asli di perintah shell, repo, unit systemd, atau tiket. Jangan menyalin `.env` Windows.

```bash
sudo install -m 0600 -o root -g root .env.production.example /etc/dashboard-funding/backend.env
sudoedit /etc/dashboard-funding/backend.env
```

Set `MYSQL_*` sesuai target database **yang benar-benar tersedia**; isi allowlist production dengan host, port, dan nama database yang sama. Jika DB berada di host non-loopback, set `MYSQL_SSL_CA_FILE` ke CA server yang dapat dibaca user service; backend menolak koneksi production remote tanpa CA. Set `DASHBOARD_PUBLIC_ORIGIN` ke URL HTTPS final, misalnya `https://funding.example.com` (tanpa path). Untuk mengaktifkan Admin, isi user dan hash scrypt yang dibuat lokal melalui `node scripts/generate-admin-hash.mjs`; jangan gunakan contoh sebagai kredensial nyata. Nilai Admin kosong membuat login Admin tidak tersedia.

## 3. Jalankan backend sebagai service

Tinjau [unit systemd](../deploy/dashboard-funding-api.service), khususnya `WorkingDirectory`, `ExecStart`, dan user. Setelah disetujui, pasang unit dan jalankan:

```bash
sudo install -m 0644 deploy/dashboard-funding-api.service /etc/systemd/system/dashboard-funding-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now dashboard-funding-api
systemctl status dashboard-funding-api --no-pager
journalctl -u dashboard-funding-api -n 50 --no-pager
```

Backend mendengarkan hanya pada `127.0.0.1:8788` (atau `SHADOW_API_PORT` yang dipilih). Jangan buka port backend atau MySQL melalui firewall publik. `server/index.js` adalah server Google Sheets legacy; untuk dashboard MySQL jalankan `server/shadow.js` saja.

Periksa target dan koneksi tanpa menampilkan payload data:

```bash
curl --silent --output /dev/null --write-out 'Funding API HTTP %{http_code}\n' http://127.0.0.1:8788/api/funding/master/offices
curl --silent --output /dev/null --write-out 'Posisi API HTTP %{http_code}\n' http://127.0.0.1:8788/api/funding/positions
curl --silent --output /dev/null --write-out 'Admin tanpa login HTTP %{http_code}\n' http://127.0.0.1:8788/api/admin/session
```

Harapkan `401 data_auth_required` untuk Funding tanpa sesi Admin dan `401` untuk Admin tanpa sesi. Setelah sesi Admin valid, Funding dapat mengembalikan `200` bila data tersedia. `403 funding_target_not_allowed` berarti target database tidak cocok. `503` berarti koneksi, skema, atau data belum siap.

## 4. Sajikan frontend melalui Nginx dan Cloudflare Tunnel

Tinjau [konfigurasi Nginx](../deploy/dashboard-funding.nginx.conf). Ubah `server_name`, path `dist`, dan port API bila perlu. Contoh ini mendengarkan hanya pada loopback port 8080, menyajikan berkas build, meneruskan `/api/` ke backend, serta memakai fallback `index.html` untuk React. Ukuran body 350 MB mengikuti batas backend; batas Cloudflare atau paket layanan dapat lebih kecil.

```bash
sudo install -m 0644 deploy/dashboard-funding.nginx.conf /etc/nginx/sites-available/dashboard-funding
sudo ln -s /etc/nginx/sites-available/dashboard-funding /etc/nginx/sites-enabled/dashboard-funding
sudo nginx -t
sudo systemctl reload nginx
curl --silent --output /dev/null --write-out 'Frontend HTTP %{http_code}\n' http://127.0.0.1:8080/
```

Konfigurasikan satu public hostname Cloudflare Tunnel yang diarahkan ke `http://127.0.0.1:8080`, bukan ke Vite port 5173 atau backend 8788. Pada production, endpoint data Funding, Appraisal, dan Shadow memerlukan sesi Admin yang diverifikasi backend. Login PN lama belum memiliki bukti identitas tambahan; dashboard PN production tetap tertutup sampai metode otorisasi PN disetujui dan diimplementasikan. Jangan membuka akses umum sebelum itu. Backend Admin tetap meminta login terpisah, token CSRF, Origin HTTPS yang sama dengan `DASHBOARD_PUBLIC_ORIGIN`, dan mengirim cookie `HttpOnly; SameSite=Strict; Secure`.

Nginx mengirim seluruh `/api/` ke backend yang sama sehingga frontend memakai URL relatif dan tidak membutuhkan proxy Vite. Jangan mengarahkan `/api/appraisal/*` ke server Google Sheets legacy. Untuk upload besar, periksa batas body Cloudflare, kapasitas disk sementara, dan waktu proses. Upload yang lebih besar dari batas Cloudflare harus memakai jalur privat yang disetujui, bukan membuka database atau backend ke internet.

## 5. Verifikasi dan pemulihan

Sebelum membuka akses umum: pastikan seluruh endpoint Funding, Detail Unit Kerja, RKA, Prognosa, Appraisal, serta login Admin melalui HTTPS. Cocokkan jumlah sumber dan KPI dengan database asal. Uji upload, retry, ganti periode, rollback pointer publikasi, dan kegagalan transaksi **pada database terisolasi** terlebih dahulu; jangan menggunakan database asli untuk percobaan. Snapshot lama tidak dihapus oleh pipeline Admin; riwayat publikasi menyimpan batch sebelumnya untuk prosedur pemulihan terkontrol.

Jika rilis gagal, kembalikan build/source code sebelumnya dan restart service; jangan menjalankan DROP/TRUNCATE. Jika publikasi data keliru, tinjau `dashboard_domain_publication_history` dan pulihkan pointer batch hanya dengan prosedur database yang disetujui dan backup yang telah diuji. Rollback DDL atau data tidak otomatis.
