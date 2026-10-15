# Fondasi MySQL dan pipeline impor

Fondasi ini menyediakan konfigurasi koneksi, health check, migration runner, serta migration metadata dan skema domain 001/002. Belum ada data bisnis yang diimpor dan frontend tetap memakai sumber runtime lama; endpoint Appraisal tetap membaca Google Sheets.

## Dependency

Backend memakai `mysql2` versi Promise API untuk connection pool dan prepared statements. Kredensial tidak berada di kode atau package manifest.

## Konfigurasi lokal

1. Salin `.env.example` menjadi `.env` lokal. Template development memakai `MYSQL_HOST=127.0.0.1`, `MYSQL_PORT=3308`, dan `MYSQL_DATABASE=dashboard_funding_test`. File `.env` telah dicakup oleh `.gitignore`. Untuk server Ubuntu gunakan `.env.production.example` dan [panduan deployment](ubuntu-deployment.md).
2. Isi `MYSQL_USER` dan `MYSQL_PASSWORD` secara lokal sesuai akun yang diberikan administrator MySQL. Jangan kirim nilainya melalui chat atau menambahkannya ke repository.
3. `MYSQL_PASSWORD` boleh kosong hanya jika administrator memang mengonfirmasi akun tanpa password; variabel tetap harus didefinisikan.
4. `MYSQL_CONNECTION_LIMIT` opsional, default 5, maksimum 50.
5. File `.env` dimuat oleh backend melalui dukungan environment file bawaan Node.js. Alternatifnya, injeksikan environment variable dari shell atau process manager.

Jangan menampilkan isi `.env`, environment dump, object konfigurasi pool, atau pesan driver mentah dalam log. Health check hanya mengeluarkan kategori error, kode driver yang aman, dan nama variabel yang belum diset.

## Pemeriksaan koneksi dan migrasi

```powershell
npm.cmd run db:health
```

Health check menjalankan `SELECT VERSION()` dan `SELECT DATABASE()` hanya bila semua variabel koneksi tersedia. Health check memastikan database aktif sama dengan nilai `MYSQL_DATABASE`. Jika konfigurasi belum lengkap, perintah melaporkan nama variabel yang belum diset tanpa mencoba koneksi. Respons sukses menampilkan versi server dan nama database yang terpilih, tanpa menampilkan username atau password.

Lihat rencana tanpa koneksi atau perubahan database:

```powershell
npm.cmd run db:migrate
```

Migration yang tersedia:

- `001_import_metadata.sql`: metadata sumber, batch impor, objek impor, dan isu validasi.
- `002_dashboard_business_schema.sql`: tabel pendamping batch/publikasi, dimensi, staging, dan fakta untuk Posisi Dana, RKA, Prognosa, serta Appraisal. Migration ini hanya membuat struktur; tidak menyisipkan data bisnis.
- `dashboard_schema_migrations`: ledger versi yang dibuat oleh runner saat mode apply.

Runner memakai advisory lock dan checksum versi. Sebelum migration berjalan, ia memvalidasi tabel yang sudah ada agar `CREATE TABLE IF NOT EXISTS` tidak dianggap sebagai bukti kesesuaian. Pemeriksaan membandingkan kumpulan kolom, tipe, nullability, auto-increment, engine, charset, primary key, indeks yang dinyatakan dalam DDL, dan foreign key. Tabel dari migration yang telah tercatat juga diverifikasi lagi setiap kali runner dijalankan. Bila skema tidak sesuai, proses berhenti tanpa mengubah atau memperbaiki tabel tersebut. Indeks tambahan yang bukan bagian DDL tidak ditolak; semua indeks dan foreign key yang dideklarasikan tetap harus cocok.

Runner hanya menerima statement `CREATE TABLE IF NOT EXISTS dashboard_*` pada file migration dan menolak operasi lain, termasuk `DROP`, `TRUNCATE`, `DELETE`, atau `ALTER`. Jangan menjalankan mode apply sampai target, backup, dan konflik skema ditinjau.

MySQL melakukan implicit commit untuk DDL; runner tidak dapat menjanjikan rollback otomatis. Jika proses berhenti di tengah, sebagian tabel bisa tertinggal dan versi migration belum tercatat. Pemeriksaan berikutnya akan mendeteksi tabel yang tidak sesuai; tinjau struktur parsial dan log sebelum retry. Jangan menghapus tabel parsial secara otomatis.

## Backup dan rollback

Sebelum migrasi DDL yang disetujui, operator harus mengambil backup database `dashboard_funding`, mencatat checksum artefak, dan menguji pemulihan ke instance non-produksi. Pada lingkungan yang diperiksa, service berjalan bernama `MySQL84_New`, listener ada pada port `3308`, dan binary MySQL Server/client 8.4.11 berada di `C:\MySQL84_New\bin`. Jangan mengandalkan nama service `MySQL84` atau client 8.0 dari `PATH` pada mesin ini.

Simpan kredensial pada login path lokal MySQL, bukan di command line, log, atau repository. Perintah berikut akan meminta password secara interaktif; jangan menambahkan password sebagai argumen:

```powershell
$mysqlBin = 'C:\MySQL84_New\bin'
& (Join-Path $mysqlBin 'mysql_config_editor.exe') set `
  --login-path=dashboard_funding_backup `
  --host=127.0.0.1 --port=3308 --user=ISI_USER_MYSQL `
  --password
```

Ganti `ISI_USER_MYSQL` dengan user lokal yang berwenang. Input password diminta oleh program dan tidak perlu ditulis pada baris perintah. File login path disimpan oleh MySQL di profil Windows pengguna, di luar repository. Batasi akses ke profil tersebut. Jangan menjalankan `mysql_config_editor print --all` pada sesi yang direkam.

Pastikan target, service, serta versi client sebelum backup:

```powershell
$mysqlBin = 'C:\MySQL84_New\bin'
$service = Get-Service -Name 'MySQL84_New' -ErrorAction Stop
if ($service.Status -ne 'Running') { throw 'Service MySQL84_New tidak berjalan.' }
$dumpPath = Join-Path $mysqlBin 'mysqldump.exe'
$dumpVersion = & $dumpPath --version
if ($LASTEXITCODE -ne 0 -or $dumpVersion -notmatch 'Ver 8\.4\.11\b') { throw 'mysqldump yang dipilih bukan versi 8.4.11.' }
$mysqlPath = Join-Path $mysqlBin 'mysql.exe'
& $mysqlPath --login-path=dashboard_funding_backup --protocol=TCP --host=127.0.0.1 --port=3308 --database=dashboard_funding --execute="SELECT VERSION() AS server_version, DATABASE() AS database_name"
if ($LASTEXITCODE -ne 0) { throw 'Pemeriksaan target MySQL gagal.' }

$backupDir = Join-Path $env:USERPROFILE 'Documents\DashboardFundingBackups'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $backupDir "dashboard_funding-$stamp.sql"
$hashPath = "$backupPath.sha256.txt"

New-Item -ItemType Directory -Force $backupDir | Out-Null
& $dumpPath `
  --login-path=dashboard_funding_backup --protocol=TCP --host=127.0.0.1 --port=3308 `
  --single-transaction --routines --triggers --events --hex-blob `
  --databases dashboard_funding "--result-file=$backupPath"
if ($LASTEXITCODE -ne 0) { throw "mysqldump gagal dengan exit code $LASTEXITCODE" }

$backup = Get-Item -LiteralPath $backupPath
if ($backup.Length -le 0) { throw 'File backup kosong.' }
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $backupPath).Hash
Set-Content -LiteralPath $hashPath -Value $hash -NoNewline -Encoding ascii
$recordedHash = (Get-Content -LiteralPath $hashPath -Raw).Trim()
$verifiedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $backupPath).Hash
if ($verifiedHash -ne $recordedHash) { throw 'Checksum backup tidak cocok.' }
Get-Item -LiteralPath $backupPath, $hashPath | Select-Object FullName, Length
Get-FileHash -Algorithm SHA256 -LiteralPath $backupPath
```

Hasil target harus menunjukkan `server_version` `8.4.11` dan `database_name` `dashboard_funding`. Setelah dump, `$LASTEXITCODE` harus `0`, file SQL harus berukuran lebih dari nol byte, dan hash yang dihitung ulang harus sama dengan isi file `.sha256.txt`. Simpan kedua file pada lokasi terlindungi yang terpisah dari workstation/database. Checksum membuktikan integritas file terhadap catatan hash, bukan kemampuan restore.

Untuk restore test kelak, gunakan hanya instance MySQL non-produksi yang terisolasi dan kredensial/login path yang diarahkan ke instance tersebut. Dump memakai `--databases dashboard_funding`, sehingga restore akan membuat/menggunakan nama schema itu; jangan arahkan perintah restore ke host/port produksi. Setelah restore test yang disetujui, pastikan exit code sukses, database dapat dipilih, dan jumlah/struktur tabel serta pemeriksaan data cocok dengan backup. Restore tidak dijalankan pada tahap ini dan instance uji belum dibuat.

Verifikasi binary yang dipakai bila path instalasi berubah:

```powershell
& 'C:\MySQL84_New\bin\mysqldump.exe' --version
Get-Service -Name MySQL84_New | Select-Object Name, Status
```

Tidak ada backup atau uji restore yang dijalankan oleh migration runner.

Migration 001 dan 002 bersifat aditif dan aplikasi belum dialihkan ke MySQL. Rollback operasional awal adalah menghentikan penggunaan tabel baru dan mempertahankannya untuk pemeriksaan. DDL tidak di-rollback otomatis. Bila pemulihan skema diperlukan, gunakan backup terverifikasi atau prosedur DBA yang disetujui setelah dampak ditinjau; jangan menghapus tabel otomatis.

Jika migration parsial gagal, hentikan proses, inventarisasi tabel/kolom/keys yang terbentuk dan bandingkan dengan kontrak migration. Runner baru mencatat versi setelah seluruh struktur lolos verifikasi. Jalankan ulang hanya setelah penyebab dipahami; jangan menghapus tabel parsial dengan `DROP`.

## Pipeline staging dan validasi

`server/import-validation.js` menyediakan validasi baris yang tidak membeberkan isi data serta pemrosesan `AsyncIterable` per chunk. Pemanggil harus menyediakan validator dan writer staging khusus domain. Fungsi mempertahankan nomor baris dan tidak menghapus duplikat.

Tabel metadata batch mencatat sumber, checksum, status, objek file/sheet, jumlah baris, dan isu. Importer per-domain tersedia untuk staging sumber yang telah dipetakan. Pembentukan fakta dan cutover runtime tetap merupakan langkah terpisah.

### Satu perintah untuk impor sumber dashboard

Gunakan koordinator tipis yang memanggil importer domain yang sudah ada, berurutan: unit kerja, RMFT, RKA, Posisi Dana, Prognosa, lalu Appraisal. Setiap importer tetap mengelola checksum, batch, validasi, retry, dan staging sesuai domainnya. Importer posisi membaca JSON besar secara streaming. Kegagalan menghentikan urutan; jalankan ulang untuk melanjutkan karena snapshot yang sudah staged idempoten.

```powershell
# .env lokal saat ini menunjuk database utama; override hanya untuk proses ini.
$previousDbName = $env:MYSQL_DATABASE
$env:MYSQL_DATABASE = 'dashboard_funding_test'
try {
  # Dry-run (default): SELECT target/status staging dan validasi sumber, tanpa menulis.
  npm.cmd run db:import:dashboard
  if ($LASTEXITCODE -ne 0) { throw 'Dry-run impor belum lolos.' }
} finally {
  if ($null -eq $previousDbName) { Remove-Item Env:MYSQL_DATABASE -ErrorAction SilentlyContinue }
  else { $env:MYSQL_DATABASE = $previousDbName }
}

# Hanya setelah dry-run ditinjau dan disetujui:
$previousDbName = $env:MYSQL_DATABASE
$env:MYSQL_DATABASE = 'dashboard_funding_test'
try {
  npm.cmd run db:import:dashboard -- --apply --confirm-target dashboard_funding_test
} finally {
  if ($null -eq $previousDbName) { Remove-Item Env:MYSQL_DATABASE -ErrorAction SilentlyContinue }
  else { $env:MYSQL_DATABASE = $previousDbName }
}
```

Koordinator menolak host nonlokal, port selain 3308, database selain `dashboard_funding_test`, dan memeriksa `DATABASE()` serta `@@port`. `--apply` tidak dijalankan otomatis. Importer dapat menyelesaikan stage/batch dan master sesuai perilaku yang sudah ada; perintah ini tidak membangun fakta Posisi Dana, memetakan ulang kantor, atau mengalihkan runtime dashboard.

Sumber workbook yang didukung saat ini hanya workbook Prognosa yang diproses converter khusus `scripts/convert-prognosa.mjs` menjadi `data/source-archive/prognosa_data.json`, dan hanya empat sheet yang disetujui: `KOMITMEN SBO`, `KOMITMEN BO`, `Per AH`, `PER RMFT`. Impor kemudian memakai `scripts/import-prognosis.mjs` dan menargetkan staging Prognosa. Tidak ada file CSV aktif di `public/`; CSV baru harus memiliki kontrak kolom dan pemetaan domain/tabel yang disetujui terlebih dahulu. Koordinator melaporkan CSV yang ditemukan sebagai blocker dan tidak mengimpornya ke tabel generik.

## Logging dan operasional

- Gunakan batch ID untuk menghubungkan log importer dengan metadata.
- Jangan mencatat password, payload mentah, data Appraisal personal, atau connection string.
- Catat kode error tersaring, domain, batch, nomor baris, dan kode isu.
- Batch tidak boleh menjadi aktif sebelum validasi lolos; pertahankan batch sebelumnya untuk rollback.
- Untuk Appraisal, worker/sinkronisasi MySQL tahap berikutnya harus menggantikan sumber runtime Google Sheets hanya setelah parity dan otorisasi disetujui. Endpoint saat ini belum dialihkan.
