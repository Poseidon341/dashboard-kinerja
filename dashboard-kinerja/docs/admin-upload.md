# Admin → Update Data

Fitur ini hanya menerima file `.xlsx` dengan sheet `segmen_data` dan kolom `Posisi`, `Segmentasi BPR`, `Produk`, `Nama Cabang`, `Nama Uker`, `Jumlah Rekening`, `Saldo`. RKA, Prognosa, master, dan Appraisal ditampilkan sebagai **Belum Tersedia** sampai aturan publikasi tiap domain disetujui. Sheet lain dalam workbook tidak diimpor melalui menu ini.

## Konfigurasi lokal

1. Pada mode development, backend hanya menerima MySQL lokal port 3308 dan `MYSQL_DATABASE=dashboard_funding_test`. Guard juga memeriksa `DATABASE()` dan `@@port`. Untuk production, gunakan allowlist target dan HTTPS sesuai [panduan Ubuntu](ubuntu-deployment.md); jangan aktifkan upload pada database asli sebelum uji terisolasi dan persetujuan pemilik data.
2. Dari terminal interaktif, jalankan `node scripts/generate-admin-hash.mjs`. Ketik kata sandi Admin; input tidak tampil. Simpan output hash pada `.env` lokal sebagai `DASHBOARD_ADMIN_PASSWORD_SCRYPT`, lalu isi `DASHBOARD_ADMIN_USER`. Jangan commit `.env` atau hash yang dipakai sungguhan. Password Admin ini terpisah dari login PN dashboard.
3. Jalankan `npm.cmd run shadow:server` dan `npm.cmd run dev`. Vite meneruskan `/api/admin` ke port shadow seperti API Funding. Server harus dijalankan dengan target database uji; jika `.env` menunjuk database lain, gunakan override environment **hanya untuk proses server** atau ubah konfigurasi lokal sendiri setelah meninjau target.

## Alur

Masuk ke dashboard → **Admin · Update Data** → login Admin → pilih Posisi Dana → unggah workbook → periksa validasi dan jumlah baris tiap periode → pilih Tambahkan untuk periode baru atau Ganti Data Periode untuk bulan lama → untuk penggantian, ketik `GANTI DATA PERIODE` → konfirmasi. Periode lama dibatalkan secara default. API membatasi file ke 350 MB, memeriksa signature ZIP, membaca worksheet bertahap, dan menolak baris invalid sebelum commit.

Checksum workbook + versi parser memakai idempotensi importer yang sudah ada. Staging dan kandidat fakta disimpan per chunk dengan identitas `(object_id, source_row_number)`. Kegagalan sebelum publikasi menyisakan batch/kandidat untuk retry, sementara dashboard tetap menggunakan pointer periode yang lama. Setelah seluruh fakta cocok dengan staging, pointer bulan terpilih dan riwayat publikasi diubah dalam **satu transaksi**. Snapshot lama tidak dihapus. Bulan lain tidak diubah. Tidak ada konversi satuan saldo; `amount_unit_code` tetap `NULL`.

Untuk memulihkan publikasi bulan yang pernah diganti, identifikasi batch sebelumnya melalui `dashboard_domain_publication_history` dan jalankan prosedur pemulihan terkontrol setelah memverifikasi kelengkapan fakta batch itu. Jika publikasi sebelumnya adalah snapshot dasar tanpa pointer bulan, pemulihan berarti mengosongkan pointer bulan agar fallback ke snapshot dasar; jangan menghapus fakta atau staging. Pemulihan ini belum tersedia sebagai tombol UI otomatis.

Status unggah yang sedang berjalan dan gagal tersimpan di memori proses API; riwayat **publikasi berhasil** tersimpan di `dashboard_domain_publication_history`. Mulai ulang server saat job berjalan akan menghentikan job, tetapi unggah file checksum sama dapat diproses ulang dengan idempotensi. Sesi Admin dan file preview sementara juga berada di memori/temporary directory dan kedaluwarsa.

## Batasan validasi

Jangan gunakan akun database utama untuk mencoba fitur ini. Tidak ada apply ke database uji dalam pengembangan kode ini; pengujian lokal memakai fixture dan mock. Uji unggah nyata serta ganti periode pada database **terisolasi** yang mempunyai migration 001–003 sebelum menggunakan `dashboard_funding_test` yang berisi data. Kartu posisi untuk bulan baru dapat membaca tanggal baru; target RKA untuk tahun setelah 2026 tetap `—` karena sumber target tahun tersebut belum tersedia. Perbandingan grafik lama Jun–Okt 2026 tetap ada; bulan baru muncul sebagai seri periode aktif.
