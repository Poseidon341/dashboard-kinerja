# Persiapan Migrasi MySQL — Tahap 1 (Master Unit, RMFT, RKA)

Dokumen ini menjelaskan validasi offline dan langkah yang perlu disiapkan sebelum impor ke MySQL. Skrip validasi tidak membuka koneksi database dan tidak menjalankan SQL.

## Sumber yang dicakup

- `data/source-archive/uker_list.json` — master unit/cabang.
- `data/source-archive/rmft_list.json` — master RMFT dan kode unit.
- `data/source-archive/tabel_rka.json` — kategori RKA per kode unit dengan nilai bulanan JAN–DEC.

Sumber JSON adalah input read-only. Skrip menghasilkan laporan terpisah di `reports/mysql-migration-stage1-validation.json` dan mempertahankan seluruh baris, termasuk baris yang memiliki kunci duplikat.

## Menjalankan validasi offline

Dari direktori proyek `dashboard-kinerja`:

```powershell
node scripts/validate-migration-prep.mjs
```

Laporan ditulis ke lokasi default `reports/mysql-migration-stage1-validation.json`. Lokasi alternatif dapat ditentukan dengan `--out`:

```powershell
node scripts/validate-migration-prep.mjs --out reports/validation-review.json
```

Exit code `1` berarti skrip menemukan kolom wajib yang hilang, struktur yang tidak sesuai, atau nilai bulanan RKA yang formatnya tidak dikenali. Nilai kosong yang memang berupa string kosong dihitung terpisah dan bukan dianggap nol. Format string RKA yang dikenali untuk validasi adalah angka Indonesia: titik sebagai pemisah ribuan dan koma sebagai desimal; nilai sumber tidak dikonversi balik atau ditulis ulang.

## Hasil validasi saat dokumen dibuat

Hasil yang tepat untuk versi file sumber saat ini dicatat di laporan JSON. Pemeriksaan awal menemukan 611 baris master unit, 192 baris RMFT, dan 4.577 baris RKA. Nilai bulanan RKA berisi campuran number JSON, string angka, dan string kosong. Terdapat kode unit RMFT yang tidak ditemukan pada master; skrip akan melaporkannya per PN/kode tanpa mencoba mencocokkan nama. Angka ini harus dibaca dari laporan hasil eksekusi, bukan dijadikan mapping otomatis.

## Urutan persiapan impor berikutnya

1. Arsipkan salinan sumber secara read-only dan catat SHA-256, ukuran, serta waktu modifikasi. Laporan validasi juga menyertakan checksum setiap sumber.
2. Tinjau semua duplikasi dan relasi yang dilaporkan. Jangan menghapus atau menggabungkan baris hanya karena kode/kategori atau nilai tampak sama.
3. Konfirmasi kamus kode unit yang tidak cocok dari pemilik data. Nama unit hanya boleh dipakai sebagai bukti tambahan setelah ditinjau; tidak menjadi pengganti otomatis untuk kode.
4. Siapkan definisi skema untuk batch impor, staging mentah, dimensi kantor dengan histori, dimensi kategori RKA, dan target bulanan. Belum ada tabel atau SQL dibuat pada tahap ini.
5. Pada tahap impor yang disetujui, muat dahulu ke staging dengan `batch_id` dan nomor baris sumber. Simpan nilai mentah, termasuk string asli dan sel kosong.
6. Ubah bulan JAN–DEC menjadi record target per bulan hanya pada tabel terkurasi setelah format angka dan kategori disetujui. Jangan melakukan konversi nominal atau pembulatan saat staging.
7. Jalankan rekonsiliasi jumlah baris, kunci, null/kosong/nol, distribusi kategori, dan total per kode unit serta bulan terhadap JSON sumber.
8. Publikasikan batch hanya setelah seluruh selisih dapat dijelaskan. Simpan batch lama agar cutover dapat dibatalkan tanpa menghapus data.

## Pemetaan kode yang boleh divalidasi dari sumber saat ini

- `rmft_list.json` → `uker_list.json`: `Kode Uker` dibandingkan dengan `BRANCH CODE`.
- `tabel_rka.json` → `uker_list.json`: `KODE UKER` dibandingkan dengan `BRANCH CODE`.
- `MAIN BRANCH CODE` pada master unit diperiksa terhadap daftar kode KC, tetapi pemeriksaan ini tidak membuktikan relasi UNIT ke KCP.
- Tidak ada pemetaan berbasis nama yang dibuat oleh skrip.

## Belum diputuskan

- Sumber otoritatif untuk memperbaiki kode RMFT/RKA yang tidak cocok dengan master.
- Apakah ada histori perubahan kode, nama, area, atau struktur unit yang perlu diimpor.
- Presisi dan skala final untuk DECIMAL MySQL setelah semua nilai RKA diperiksa.
- Apakah kategori RKA tertentu sebanding dengan segmen aktual tertentu; validasi file tidak menetapkan aturan bisnis.
