# Dashboard Funding

Dashboard Funding adalah aplikasi React + Vite dengan backend Node.js. Pada konfigurasi runtime yang didokumentasikan di sini, dashboard mengambil data melalui API backend yang membaca MySQL. Frontend tidak memuat dataset JSON atau workbook secara langsung.

## Persyaratan

- Node.js 22 atau lebih baru
- MySQL yang sudah berisi skema dan data Dashboard Funding
- Port MySQL dan kredensial yang disediakan secara lokal oleh administrator

Jangan unggah file dataset, workbook, kredensial, atau file `.env` ke repository.

## Instalasi lokal

```powershell
npm ci
Copy-Item .env.example .env
```

Buka `.env` lokal dan isi `MYSQL_USER` serta `MYSQL_PASSWORD` dengan kredensial yang disediakan untuk lingkungan Anda. Jangan masukkan nilai rahasia ke perintah terminal, dokumentasi, atau Git.

Contoh konfigurasi nonrahasia yang disiapkan di `.env.example` memakai host `127.0.0.1`, port `3308`, database `dashboard_funding_test`, dan port API `8788`. Pastikan database yang dikonfigurasi adalah database yang memang diizinkan untuk lingkungan lokal Anda. `.env` diabaikan oleh Git.

Periksa koneksi dan database yang dipilih:

```powershell
npm.cmd run db:health
```

Perintah tersebut hanya memeriksa koneksi. Migrasi dan impor data tidak berjalan otomatis saat aplikasi dimulai.

## Menjalankan backend dan frontend

Buka dua terminal dari folder proyek.

Terminal backend:

```powershell
npm.cmd run shadow:server
```

Backend mendengarkan pada `127.0.0.1:8788` secara default. Atur `SHADOW_API_PORT` jika port tersebut dipakai.

Terminal frontend:

```powershell
npm.cmd run dev
```

Buka URL lokal yang ditampilkan Vite, biasanya `http://localhost:5173`. Vite meneruskan `/api/funding/*` dan `/api/appraisal/*` ke backend shadow yang dikonfigurasi. Data runtime dashboard dibaca melalui API tersebut.

`npm.cmd run appraisal:server` adalah server kompatibilitas lama. Jika server tersebut memang dijalankan, sumbernya hanya dapat dikonfigurasi secara lokal melalui `APPRAISAL_SPREADSHEET_ID`; nilai itu tidak ditanam di source code atau dikirim dalam respons API. Untuk dashboard MySQL, gunakan `shadow:server` seperti di atas.

## Pemeriksaan kode

```powershell
npm.cmd run build
npm.cmd run test:funding-position-api
npm.cmd run test:funding-reference-api
npm.cmd run test:shadow-api
```

Tes API tersebut memakai stub/fixture dan tidak mengimpor atau mengubah data MySQL.

## File lokal yang tidak masuk Git

`.gitignore` mengecualikan `node_modules/`, `dist/`, `data/source-archive/`, `data/import/`, laporan hasil proses, dataset JSON/CSV, workbook Excel, kredensial, log, file sementara, serta file backup. Kode aplikasi, migration SQL, konfigurasi aman, `package.json`, dan `package-lock.json` tetap dapat dilacak.
