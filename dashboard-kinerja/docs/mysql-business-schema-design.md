# Rancangan Skema Bisnis MySQL — Dashboard Funding

**Status:** dokumen rancangan untuk review. DDL di bawah hanya contoh teks dan tidak dijalankan. Tidak ada tabel, sumber, atau aplikasi yang diubah oleh dokumen ini.

## 1. Prinsip rancangan

- MySQL menjadi sumber runtime terpusat setelah suatu domain diimpor, divalidasi, disetujui, dan dialihkan melalui backend/API. Sumber upstream tetap disimpan sebagai arsip/import input sampai cutover disetujui.
- Setiap domain memiliki staging dan fakta/dimensi yang sesuai bentuk sumbernya. Metadata batch dapat dipakai bersama, tetapi tidak ada satu tabel data generik untuk semua domain.
- Simpan batch sumber immutable, checksum, nomor baris/cell, status validasi, dan metadata konversi. Jangan menghapus baris identik sebelum grain sumber dipastikan.
- Nominal keuangan menggunakan `DECIMAL`; jangan menyimpan angka format tampilan. Pertahankan nilai raw terpisah dari nilai normalisasi.
- Bedakan kosong/`NULL` dari `0`. Nilai kosong yang berupa string sumber tetap tercatat sebagai bentuk raw dan tidak otomatis dianggap nol.
- Dimensi bisnis yang belum terbukti—terutama relasi kantor dan kategori—boleh belum termapping. Status `unmatched`, `ambiguous`, atau `unverified` harus terlihat.
- Semua waktu proses disimpan sebagai UTC `DATETIME(3)`; tanggal posisi dan bulan target memakai `DATE`. Tanggal observasi snapshot master disimpan terpisah dari tanggal efektif bisnis. Tanggal efektif tidak diisi dari waktu impor kecuali sumber menyatakannya.

## 2. Audit ulang sumber aktual

| Sumber | Fakta struktur/akses yang diperiksa | Implikasi untuk skema |
|---|---|---|
| `data/source-archive/segmen_data.json` | 1.039.742 baris; 7 field: `Posisi`, `Segmentasi BPR`, `Produk`, `Nama Cabang`, `Nama Uker`, `Jumlah Rekening`, `Saldo`. Ada 66 tanggal dari 31/12/2025 sampai 04/10/2026. Label segmen: MIKRO, RITEL, KORPORASI; produk: TABUNGAN, DEPOSITO, GIRO. Tidak ada field kode unit. `Saldo` adalah string pada 1.020.714 baris dan JSON number pada 19.028 baris; pemeriksaan kompatibel dengan parser UI menemukan semua nilai dapat dikonversi. String contoh memakai koma sebagai pemisah ribuan. | Raw label dan lexeme nilai perlu dipertahankan. Join ke kantor lewat nama saja belum merupakan pemetaan terverifikasi. Saldo dibuat `DECIMAL`, tapi unit/skala sumber dicatat nullable sampai dikonfirmasi. Posisi terbaru ditentukan dengan parse tanggal `DD/MM/YYYY`, bukan sort string. |
| `data/source-archive/tabel_rka.json` | 4.577 baris; field identitas `NO URUT`, `RKA KEY`, `MATA ANGGARAN`, `KODE UKER`, dan JAN–DEC. Ada 17 kategori, 589 kode unit. 54.216 sel bulan berupa nilai numerik/angka yang dapat diparse; 708 sel kosong, masing-masing 118 pada JAN–JUN dan tidak ada kosong JUL–DEC. Ada campuran JSON number dan string; string mencakup pemisah ribuan titik dan desimal koma. Validasi sebelumnya menemukan tidak ada duplikasi pasangan kode unit/kategori, dan kode RKA seluruhnya ada di master saat itu. | Raw row dan nilai bulan asli dipertahankan; curated table menormalkan bulan menjadi tanggal awal bulan dan nilai DECIMAL. Jangan menyamakan kategori target Retail dengan aktual Mikro tanpa keputusan pemilik. |
| `data/source-archive/uker_list.json` | 611 baris: 46 KC, 35 KCP, 530 UNIT. `BRANCH CODE` unik; field kode bertipe JSON number. `MAIN BRANCH CODE` pada seluruh record menunjuk ke kode KC yang tersedia. `Rural Urban` kosong untuk 530 baris. Master tidak membuktikan parent UNIT→KCP. | Identitas unit dapat dimodelkan dengan surrogate PK dan unique source code. Simpan histori nama/area/tipenya. Simpan hubungan parent terpisah dari label dan tandai bukti serta periode efektif. |
| `data/source-archive/rmft_list.json` | 192 baris; field `No`, `PN`, `Nama`, `JG`, `Jabatan`, `Kode Uker`. PN unik dalam snapshot yang diperiksa. Dua RMFT menggunakan kode unit 854 yang tidak ada pada master unit: PN 5255261 dan 90186233. | PN disimpan sebagai `VARCHAR` agar format identitas tidak bergantung pada representasi angka. Assignment kantor boleh unresolved; jangan map menurut nama. |
| `data/source-archive/prognosa_data.json` | Memuat metadata sumber, waktu konversi, nama empat sheet, label periode, cached formula counts, dan row/cell bersumber. Sheet: KOMITMEN SBO (51 row, A1:CF51, 84 kolom, 2.065 formula/cached), KOMITMEN BO (130, A1:CT130, 98 kolom, 5.097), Per AH (45, A1:CU45, 99 kolom, 3.042), PER RMFT (193, A1:L193, 12 kolom, 1.146). Header bertingkat pada tiga sheet pertama (baris 1–3); PER RMFT header baris 1. Metadata `currencyUnit` dan `pipelineWeekDateRanges` null. | Simpan raw row dan sel/cell address. Nilai formula yang ada adalah cached result; JSON tidak memberi formula bisnis untuk direkonstruksi. Simpan nama sheet, row kind, label kolom, periode dan nilai apa adanya; jangan asumsikan semua kolom ada di setiap sheet. |
| Workbook Prognosa lokal | `Pipeline dan Komitmen September 2026 Region 13 Malang.xlsx` dapat diakses di Downloads; ukuran saat pemeriksaan 1.130.391 byte, sama dengan metadata JSON. SHA-256 saat pemeriksaan: `7DA7EA0F0619FB394819D4FCB53A4867C8F5C294409620C97309CE16A5AA8C9A`. Skrip converter hanya memilih empat sheet di atas; tidak mengimpor NOMINATIF. | Arsip file immutable dan checksum dicatat per batch. Impor berikutnya membaca workbook secara lokal/backend. Formula tidak dihitung ulang oleh converter saat ini. |
| Google Sheets Appraisal | Backend ada di `server/index.js`; mencari sheet dengan pola nama bulanan `Master Data … (RO|KP)`, membaca range dengan `valueRenderOption=UNFORMATTED_VALUE`, dan memvalidasi header dari `OUTPUT_HEADERS`. Namun permintaan read-only ke endpoint lokal `/api/appraisal/sources` saat audit mengembalikan HTTP 502 `sheets_unavailable`. Header/data live tidak berhasil diperiksa. | Rancangan Appraisal di bawah berdasar kontrak kode saja. Jumlah sheet, periode aktif, isi/format header aktual, serta kesesuaian schema live belum terverifikasi. |
| Kandidat bukan sumber aktif | `src/data.ts` berisi data statis/random dan tidak ditemukan pada jalur runtime. `src/compress.py` merujuk file input yang tidak ditemukan. `src/Dashboard.tsx.bak` bukan komponen aktif. | Jangan masukkan sebagai data bisnis sampai pemilik/peran sumbernya dibuktikan. |

**Catatan parser posisi:** UI saat ini mencari field dengan substring nama kolom lalu membuang semua karakter `Saldo` selain angka dan tanda minus. Sumber menggunakan pemisah ribuan koma. Importer tidak boleh menyalin helper UI tanpa mempertahankan raw value dan menambahkan validasi string kosong, tanda, overflow, dan ketepatan DECIMAL. Audit ini tidak menetapkan satuan mata uang.

**Header Prognosa yang berhasil dibaca:** workbook dan JSON memuat blok/label seperti `KOMITMEN POSISI 31 OKTOBER 2026`, `RKA`, komitmen Oktober/November/Desember, MTD/YTD, `PIPELINE W1`–`PIPELINE W5`, `TOTAL PIPELINE 12-31 OKT`, `11 OKTOBER 2026`, `GAP KOMITMEN`, dan `KECUKUPAN PIPELINE`. Posisi dan urutan kolom berbeda per sheet; daftar ini bukan pemetaan metrik. Parser harus menyimpan header berjenjang, label kolom persis, koordinat cell, dan nilai cache dari tiap sheet.

**Jejak implementasi saat ini:** `src/Dashboard.tsx` memuat `prognosa_data.json` (~410), `tabel_rka.json` (~499), dan `segmen_data.json` (~544), serta memanggil `/api/appraisal/data` (~256) dan `/api/appraisal/sources` (~823). `src/averageMetrics.ts` memuat helper average harian. `scripts/convert-prognosa.mjs` membatasi konversi ke empat sheet yang disetujui. Kontrak header Appraisal di `server/index.js` berada pada `PROFILE_HEADERS`, `KPI_METRICS`, dan `OUTPUT_HEADERS` (~14–40); handler sumber dan data ada sekitar baris 247–258. Endpoint target lain pada matriks belum ada pada checkout ini; `/api` diproxy melalui `vite.config.ts`.

Kontrak kode Appraisal mengharapkan field profil `Nama RM`, PN, Kode KC, Kantor Cabang, Kode Uker, Unit Kerja, Jabatan, dan JG; kemudian 13 kelompok KPI dengan kolom target/actual/realization/score, diakhiri `Score` dan `Tier`. Ini adalah ekspektasi parser kode, **bukan hasil verifikasi header Google Sheets live**.

**Batas audit Appraisal:** backend sengaja mengembalikan error generik `sheets_unavailable`; sebab upstream yang tepat (jaringan, izin, atau kegagalan provider lain) tidak dapat dipastikan dari response. Kode menahan log error provider agar tidak mengekspos konteks autentikasi. Tidak ada kredensial yang dibaca atau dicantumkan dalam dokumen.

## 3. ERD tekstual

```text
dashboard_source_registry 1 ──< dashboard_import_batch
dashboard_import_batch   1 ──< dashboard_import_object
dashboard_import_batch   1 ──< dashboard_import_issue
dashboard_import_batch   1 ──< dashboard_domain_publication (pointer batch aktif)
dashboard_import_batch   1 ──< dashboard_domain_publication_history (event publish/rollback)
dashboard_schema_migrations (versi DDL, terpisah dari batch bisnis)

dashboard_import_object 1 ──< dashboard_stg_position_row
dashboard_import_object 1 ──< dashboard_stg_office_row
dashboard_import_object 1 ──< dashboard_stg_rmft_row
dashboard_import_object 1 ──< dashboard_stg_rka_row
dashboard_import_object 1 ──< dashboard_stg_prognosis_row
dashboard_import_object 1 ──< dashboard_stg_appraisal_row

dashboard_dim_office 1 ──< dashboard_dim_office_version
dashboard_dim_office 1 ──< dashboard_office_relationship (child atau parent, efektif tanggal)
dashboard_dim_rmft 1 ──< dashboard_rmft_assignment >── dashboard_dim_office

dashboard_dim_date ──< dashboard_fact_position_daily >── dashboard_dim_office (nullable/unresolved)
                                  ├── dashboard_dim_segment
                                  └── dashboard_dim_product
dashboard_dim_office ──< dashboard_fact_rka_target >── dashboard_dim_rka_category
dashboard_dim_date ──< dashboard_fact_rka_target
dashboard_stg_prognosis_row ──< dashboard_fact_prognosis_value
dashboard_dim_rmft ──< dashboard_fact_appraisal_snapshot ──< dashboard_fact_appraisal_metric
```

## 4. Katalog tabel bisnis

### 4.1 Kendali impor dan validasi

Fondasi yang benar-benar tersedia ada di `server/migrations/001_import_metadata.sql`; definisi di bawah adalah kontrak dasar, bukan rancangan ulang tabel tersebut. Migration runner (`server/migrate.js`) mewajibkan `CREATE TABLE IF NOT EXISTS dashboard_*`, menolak `ALTER`, `DROP`, `TRUNCATE`, dan `DELETE`, serta memeriksa kolom metadata yang sudah ditentukan. DDL bisnis berikutnya harus berupa tabel pendamping baru atau membutuhkan revisi runner yang ditinjau terpisah. Apakah fondasi sudah diterapkan pada database tidak diverifikasi di tahap dokumen ini.

`server/db.js` mengatur `decimalNumbers: false`, `supportBigNumbers: true`, dan `bigNumberStrings: true`. Karena itu hasil `DECIMAL`/integer besar dari driver diterima backend sebagai string; API harus mempertahankan representasi tersebut atau mengonversi hanya pada boundary yang diuji terhadap formatter/perhitungan lama. Jangan memakai `Number()` untuk kalkulasi presisi tinggi tanpa keputusan parity. `package.json` saat ini memuat dua deklarasi dependency `mysql2` (`^3.14.5` dan `^3.24.5`); normalisasi dependency perlu dibahas terpisah sebelum perubahan dependency, tidak menjadi perubahan skema tahap ini.

- `dashboard_schema_migrations`: `version INT UNSIGNED PK`, nama file, SHA-256 migration, waktu penerapan.
- `dashboard_source_registry`: `source_id BIGINT UNSIGNED PK`; `source_key VARCHAR(100) UNIQUE`; jenis, nama, lokasi logis, status aktif, timestamp. Tidak menyimpan secret.
- `dashboard_import_batch`: gunakan persis kolom dasar migration: `batch_id CHAR(36) PK`, FK `source_id`, `status`, `source_checksum`, `started_at`, `finished_at`, `rows_read`, `rows_staged`, `rows_rejected`, `created_at` dan indeks yang ada. `parser_version`, `source_modified_at`, ukuran sumber, durasi, atau ringkasan validasi **tidak ada** pada tabel dasar.
- `dashboard_import_object`: gunakan persis kolom dasar migration: `object_id BIGINT UNSIGNED PK`, FK `batch_id`, `object_name`, `object_type`, `source_checksum`, `source_row_count`, `metadata`, `created_at`. Kolom `object_key` dan unique key per objek **tidak ada** pada tabel dasar.
- `dashboard_import_issue`: `issue_id BIGINT UNSIGNED PK`; FK batch; severity, issue code, nama object, nomor row, kolom, pesan aman, konteks terbatas. Index `(batch_id, severity)` dan `(issue_code)`. Jangan salin payload pribadi/credential ke pesan isu.

Untuk menghindari perubahan tabel foundation, metadata tambahan dan kontrol publikasi diusulkan sebagai tabel pendamping baru: `dashboard_import_batch_detail`, `dashboard_import_object_identity`, `dashboard_import_idempotency`, `dashboard_domain_publication`, dan `dashboard_domain_publication_history` (detail constraint dan DDL contoh di bawah). Semua tabel domain memakai prefix `dashboard_` agar lolos whitelist migration runner. Runner saat ini hanya menegakkan kolom wajib pada empat tabel foundation; migration pendamping tetap harus ditambahkan ke verifikasi skema sebelum diterapkan. Batch gagal maupun yang pernah aktif tidak dihapus.

### 4.2 Dimensi dan histori

- `dashboard_dim_date`: `calendar_date DATE PK`, tahun/bulan/hari, awal/akhir bulan. Fakta posisi memakai `position_date DATE` sebagai FK langsung ke `dashboard_dim_date.calendar_date`; indeks fakta juga memakai `position_date`. Ini menghindari campuran `date_key` dan `position_date`.
- `dashboard_dim_office`: `office_id BIGINT UNSIGNED PK`, `source_system VARCHAR(50)`, `source_code VARCHAR(32)`, unique `(source_system, source_code)`. Kode sumber dapat berupa KC/KCP/UNIT; sumber posisi yang tidak memiliki kode tidak dipaksakan menjadi FK.
- `dashboard_dim_office_version`: `office_version_id BIGINT UNSIGNED PK`, FK office, `office_type`, `office_name`, `area_name`, kode/kelas cabang sumber, `rural_urban`, `observed_at DATETIME(3)`, `valid_from DATE NULL`, `valid_to DATE NULL`, `source_object_id`. Unique `(office_id, observed_at)`; index `(office_type, area_name, observed_at)`. `valid_from/to` hanya diisi jika tanggal efektif tersedia dari sumber/otoritas.
- `dashboard_office_relationship`: `relationship_id BIGINT UNSIGNED PK`, FK `child_office_id`, `parent_office_id`, tipe hubungan, `observed_at`, periode efektif nullable, evidence/source object, status verifikasi. Unique snapshot `(child, parent, type, observed_at)`; index `(child, observed_at)` dan `(parent, observed_at)`. Tidak membuat edge UNIT→KCP sebelum bukti resmi ada. Aturan anti-overlap periode efektif divalidasi aplikasi.
- `dashboard_dim_segment`: PK surrogate dan unique label sumber; `MIKRO`, `RITEL`, `KORPORASI` disimpan sebagai nilai berbeda.
- `dashboard_dim_product`: PK surrogate dan unique label sumber `TABUNGAN`, `DEPOSITO`, `GIRO`.
- `dashboard_dim_rka_category`: PK surrogate, label `MATA ANGGARAN` persis, source system, `observed_at`, periode berlaku nullable. Index `(source_category, observed_at)`. Relasi kategori ke KPI/produk/segmen membutuhkan tabel bridge berversi dengan status persetujuan; tidak menyamakan Retail dengan Mikro.
- `dashboard_rka_metric_mapping`: PK surrogate; FK kategori; key metrik UI, filter produk/segmen yang nullable, status `unresolved/proposed/approved/rejected`, referensi keputusan, waktu observasi dan periode efektif nullable. Unique key per kategori/metrik/scope/observasi; hanya mapping `approved` yang boleh digunakan API. Saat ini belum ada pasangan kategori → metrik yang disahkan.
- `dashboard_dim_rmft`: `rmft_id BIGINT UNSIGNED PK`, `pn VARCHAR(32)`, unique `(source_system, pn)`, nama, JG, jabatan.
- `dashboard_rmft_assignment`: `assignment_id BIGINT UNSIGNED PK`, FK RMFT dan office nullable, raw unit code, valid-from/to, mapping status dan source object. Index `(rmft_id, valid_from)` dan `(office_id, valid_from)`.

Histori snapshot master dibuat dengan baris versi baru dan waktu observasi. Sumber yang tersedia tidak membuktikan histori sebelum snapshot pertama; jangan merekonstruksi tanggal efektif lama. Jangan memperbarui snapshot/assignment lama secara in-place.

### 4.3 Staging khusus sumber

Semua staging memiliki FK `batch_id` dan `object_id`, `source_row_number`, status parsing, waktu ingest dan nomor baris/sel. Simpan raw payload tanpa dedup. Untuk mempertahankan bentuk sumber persis, simpan arsip file byte-for-byte dan raw record/cell text; `JSON` hasil re-serialisasi saja tidak selalu mempertahankan lexeme angka asli.

- `dashboard_stg_position_row`: tanggal raw/parsed, label segmen/produk/cabang/uker, raw saldo, parsed DECIMAL nullable, raw jumlah rekening, parsed count, `raw_record LONGTEXT`, status mapping/parse. Unique `(object_id, source_row_number)`.
- `dashboard_stg_office_row`: raw JSON/text record dan nilai kode, nama, tipe, main branch code, area, class, rural/urban.
- `dashboard_stg_rmft_row`: raw record, PN, nama, jabatan/JG, kode uker dan status relasi.
- `dashboard_stg_rka_row`: raw record, `NO URUT`, `RKA KEY`, mata anggaran, kode uker, raw month values, hasil parse sementara/status. Tidak memakai nilai parse untuk mengganti raw.
- `dashboard_stg_prognosis_row`: sheet, nomor baris, `raw_row JSON/LONGTEXT`, rentang/kolom, header levels, checksum object. Sheet rows/detail/total dipertahankan sebagai sumber.
- `dashboard_stg_appraisal_row`: source type/sheet/periode, nomor baris, array cell/raw record, header fingerprint, status schema. Dapat dibuat saat akses Sheets kembali tersedia.

FK dari staging ke tabel dimensi tidak wajib; staging harus dapat menyimpan record yang belum termapping.

### 4.4 Fakta terkurasi

- `dashboard_fact_position_daily`: grain **satu row sumber**, sebelum aturan agregasi. PK surrogate; FK batch/object/`position_date`; dimensi office nullable, segment, product; raw office labels; `account_count BIGINT NULL`; `balance DECIMAL` nullable dengan presisi/scale dikunci setelah profil angka penuh; `amount_unit_code VARCHAR(24) NULL`; status parse/mapping; source row. Unique `(object_id, source_row_number)` menjaga retry untuk objek yang sama, bukan menghapus record dengan saldo sama. Index `(position_date, segment_id, product_id)`, `(office_id, position_date)`, `(batch_id)`.
- `dashboard_fact_rka_target`: grain **satu sumber row × bulan**. PK surrogate; FK batch/object/office nullable/category; `target_month DATE`; `target_value DECIMAL` nullable dengan presisi/scale ditetapkan setelah profiling; `amount_unit_code NULL`; raw source row number. Index `(target_month, category_id, office_id)` dan `(office_id, target_month)`. Preserve row number sebagai unique import key. Jangan gabungkan target beda category.
- `dashboard_fact_prognosis_value`: grain **satu sel sumber**. PK surrogate; FK batch/object, sheet, row, source column/address, group label/type raw, metric/header label, period label raw, product nullable, `numeric_value DECIMAL(38,15) NULL` sebagai kandidat yang mempertahankan contoh hasil cache seperti `1179.8220833333337`, `raw_cell_value LONGTEXT`, tipe raw, cached-formula flag, row-kind `detail/subtotal/grand_total/unknown`, unit nullable. Simpan workbook asli dan checksum. Impor angka harus memeriksa rentang/scale sebelum konversi; jika tidak muat, pertahankan raw, set nilai curated `NULL`, dan catat issue—jangan membulatkan diam-diam. `DECIMAL(38,15)` tetap harus lulus profil seluruh nilai workbook sebelum final. Index `(batch_id, sheet_name, source_row_number)`, `(sheet_name, metric_code, period_label)`. Formula/total mapping baru dikurasi setelah header/label dan arti bisnis diverifikasi.
- `dashboard_fact_appraisal_snapshot`: grain **satu row Google Sheets per sheet snapshot**; PK surrogate; FK batch/object; `source_period DATE`/bulan, source type, `pn VARCHAR(32)`, profile fields, tier raw, tier parsed nullable, score `DECIMAL(18,6) NULL`, source row. Unique `(object_id, source_row_number)`; index `(source_period, source_type, pn)`. PN duplicate antar row tetap terdeteksi, bukan di-collapse.
- `dashboard_dim_appraisal_metric`: `metric_id PK`, header metric source persis, kode stabil, unit/jenis nullable, versi effective. Unit hanya ditetapkan setelah dikonfirmasi.
- `dashboard_fact_appraisal_metric`: FK snapshot + metric; `target_value`, `actual_value`, `realization_value`, `score_value DECIMAL(24,6) NULL`; unique `(snapshot_id, metric_id)`. Nilai kosong dipertahankan nullable.

Skala `DECIMAL` nominal Posisi/RKA dan metrik Appraisal belum ditetapkan final; lakukan pemindaian presisi dan batas nilai atas seluruh sumber sebelum DDL final. Untuk Prognosa, scale 6 terbukti tidak cukup bagi nilai contoh di atas. `DECIMAL(38,15)` adalah kandidat untuk angka cache Prognosa, bukan persetujuan universal. Jika raw JSON/proses converter sudah mengubah cell menjadi number, arsip workbook tetap menjadi sumber byte asli; jalur impor harus membaca nilai cache asli atau mencatat keterbatasan serialisasi. Nilai Average, gap, percent dan KPI dihitung dari nilai numerik mentah sesuai rumus aplikasi, bukan angka format.

## 5. Contoh DDL untuk review — jangan dijalankan pada tahap ini

DDL ini ilustrasi tabel pendamping baru dan fakta Posisi. Tabel `dashboard_source_registry`, `dashboard_import_batch`, `dashboard_import_object`, `dashboard_import_issue`, dan `dashboard_schema_migrations` **sudah memiliki kontrak foundation tersendiri** di `001_import_metadata.sql`/`server/migrate.js`; jangan membuat definisi alternatif. Contoh di bawah hanya untuk review, tidak dieksekusi. Migration runner saat ini mensyaratkan setiap file migration hanya membuat tabel baru `dashboard_*`; seluruh kolom wajib hasil runner perlu ditambahkan saat domain migration kelak dirancang.

```sql
-- Object identity deterministik tanpa menambah kolom ke tabel foundation.
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_import_object_identity (
  object_id BIGINT UNSIGNED NOT NULL,
  batch_id CHAR(36) NOT NULL,
  object_key VARCHAR(255) NOT NULL,
  PRIMARY KEY (object_id),
  UNIQUE KEY uq_object_identity_batch_key (batch_id, object_key),
  KEY idx_object_identity_batch (batch_id),
  CONSTRAINT fk_object_identity_object FOREIGN KEY (object_id)
    REFERENCES dashboard_import_object (object_id),
  CONSTRAINT fk_object_identity_batch FOREIGN KEY (batch_id)
    REFERENCES dashboard_import_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Metadata yang tidak tersedia pada dashboard_import_batch disimpan terpisah.
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_import_batch_detail (
  batch_id CHAR(36) NOT NULL,
  parser_version VARCHAR(64) NOT NULL,
  source_modified_at DATETIME(3) NULL,
  source_size_bytes BIGINT UNSIGNED NULL,
  validation_summary JSON NULL,
  PRIMARY KEY (batch_id),
  CONSTRAINT fk_batch_detail_batch FOREIGN KEY (batch_id)
    REFERENCES dashboard_import_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Satu konten + parser version menghasilkan batch yang sama; parser baru boleh reprocess.
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_import_idempotency (
  idempotency_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  source_checksum CHAR(64) NOT NULL,
  parser_version VARCHAR(64) NOT NULL,
  batch_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (idempotency_id),
  UNIQUE KEY uq_import_content_parser (source_id, source_checksum, parser_version),
  UNIQUE KEY uq_import_idempotency_batch (batch_id),
  CONSTRAINT fk_idempotency_source FOREIGN KEY (source_id)
    REFERENCES dashboard_source_registry (source_id),
  CONSTRAINT fk_idempotency_batch FOREIGN KEY (batch_id)
    REFERENCES dashboard_import_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pointer aktif adalah satu row per domain dan scope; scope misalnya periode/type Appraisal.
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_domain_publication (
  domain_key VARCHAR(64) NOT NULL,
  scope_key VARCHAR(128) NOT NULL DEFAULT 'default',
  batch_id CHAR(36) NULL,
  publication_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  published_at DATETIME(3) NULL,
  PRIMARY KEY (domain_key, scope_key),
  CONSTRAINT fk_publication_batch FOREIGN KEY (batch_id)
    REFERENCES dashboard_import_batch (batch_id),
  KEY idx_publication_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only audit trail untuk publish dan rollback; previous_batch_id boleh NULL pada publish pertama.
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_domain_publication_history (
  publication_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  domain_key VARCHAR(64) NOT NULL,
  scope_key VARCHAR(128) NOT NULL,
  previous_batch_id CHAR(36) NULL,
  new_batch_id CHAR(36) NOT NULL,
  publication_version BIGINT UNSIGNED NOT NULL,
  action VARCHAR(16) NOT NULL,
  actor VARCHAR(128) NULL,
  reason VARCHAR(500) NULL,
  event_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (publication_event_id),
  UNIQUE KEY uq_publication_event_version (domain_key, scope_key, publication_version),
  KEY idx_publication_history_scope_time (domain_key, scope_key, event_at),
  CONSTRAINT fk_publication_history_previous FOREIGN KEY (previous_batch_id)
    REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_publication_history_new FOREIGN KEY (new_batch_id)
    REFERENCES dashboard_import_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_date (
  calendar_date DATE NOT NULL,
  calendar_year SMALLINT UNSIGNED NOT NULL,
  calendar_month TINYINT UNSIGNED NOT NULL,
  calendar_day TINYINT UNSIGNED NOT NULL,
  month_start DATE NOT NULL,
  month_end DATE NOT NULL,
  PRIMARY KEY (calendar_date),
  KEY idx_dim_date_month (calendar_year, calendar_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_stg_position_row (
  stg_position_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  raw_record LONGTEXT NOT NULL,
  source_position_text VARCHAR(32) NULL,
  parsed_position_date DATE NULL,
  source_segment VARCHAR(128) NULL,
  source_product VARCHAR(128) NULL,
  source_branch_label VARCHAR(255) NULL,
  source_office_label VARCHAR(255) NULL,
  source_account_count_text VARCHAR(64) NULL,
  parsed_account_count BIGINT NULL,
  source_balance_text VARCHAR(128) NULL,
  parsed_balance DECIMAL(38,15) NULL,
  amount_unit_code VARCHAR(24) NULL,
  parse_status VARCHAR(24) NOT NULL,
  mapping_status VARCHAR(24) NOT NULL,
  PRIMARY KEY (stg_position_id),
  UNIQUE KEY uq_stg_position_source_row (object_id, source_row_number),
  KEY idx_stg_position_batch_status (batch_id, parse_status),
  CONSTRAINT fk_stg_position_batch FOREIGN KEY (batch_id)
    REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_stg_position_object FOREIGN KEY (object_id)
    REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Grain tetap satu row sumber; date key, kolom tanggal, FK, dan indeks konsisten memakai DATE.
-- DECIMAL scale posisi/RKA wajib disetujui setelah profiling raw seluruh sumber.
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_office (
  office_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_system VARCHAR(50) NOT NULL,
  source_code VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (office_id),
  UNIQUE KEY uq_office_source_code (source_system, source_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_segment (
  segment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_label VARCHAR(128) NOT NULL,
  PRIMARY KEY (segment_id),
  UNIQUE KEY uq_segment_source_label (source_label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_product (
  product_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_label VARCHAR(128) NOT NULL,
  PRIMARY KEY (product_id),
  UNIQUE KEY uq_product_source_label (source_label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_fact_position_daily (
  position_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  position_date DATE NOT NULL,
  office_id BIGINT UNSIGNED NULL,
  segment_id BIGINT UNSIGNED NULL,
  product_id BIGINT UNSIGNED NULL,
  source_segment_label VARCHAR(128) NULL,
  source_product_label VARCHAR(128) NULL,
  source_branch_label VARCHAR(255) NULL,
  source_office_label VARCHAR(255) NULL,
  source_account_count_text VARCHAR(64) NULL,
  account_count BIGINT NULL,
  source_balance_text VARCHAR(128) NULL,
  balance DECIMAL(38,15) NULL,
  amount_unit_code VARCHAR(24) NULL,
  mapping_status VARCHAR(24) NOT NULL,
  PRIMARY KEY (position_id),
  UNIQUE KEY uq_position_source_row (object_id, source_row_number),
  KEY idx_position_date_segment_product (position_date, segment_id, product_id),
  KEY idx_position_office_date (office_id, position_date),
  KEY idx_position_batch (batch_id),
  CONSTRAINT fk_position_batch FOREIGN KEY (batch_id)
    REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_position_object FOREIGN KEY (object_id)
    REFERENCES dashboard_import_object (object_id),
  CONSTRAINT fk_position_date FOREIGN KEY (position_date)
    REFERENCES dashboard_dim_date (calendar_date),
  CONSTRAINT fk_position_office FOREIGN KEY (office_id)
    REFERENCES dashboard_dim_office (office_id),
  CONSTRAINT fk_position_segment FOREIGN KEY (segment_id)
    REFERENCES dashboard_dim_segment (segment_id),
  CONSTRAINT fk_position_product FOREIGN KEY (product_id)
    REFERENCES dashboard_dim_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_office_version (
  office_version_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  office_id BIGINT UNSIGNED NOT NULL,
  office_type VARCHAR(16) NOT NULL,
  office_name VARCHAR(255) NOT NULL,
  area_name VARCHAR(128) NULL,
  main_branch_code VARCHAR(32) NULL,
  main_branch_class VARCHAR(32) NULL,
  rural_urban VARCHAR(32) NULL,
  observed_at DATETIME(3) NOT NULL,
  valid_from DATE NULL,
  valid_to DATE NULL,
  source_object_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (office_version_id),
  UNIQUE KEY uq_office_version_observed (office_id, observed_at),
  CONSTRAINT fk_office_version_office FOREIGN KEY (office_id)
    REFERENCES dashboard_dim_office (office_id),
  CONSTRAINT fk_office_version_object FOREIGN KEY (source_object_id)
    REFERENCES dashboard_import_object (object_id),
  KEY idx_office_version_type_area (office_type, area_name),
  KEY idx_office_version_main_code (main_branch_code, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_rka_category (
  category_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_category VARCHAR(255) NOT NULL,
  source_system VARCHAR(50) NOT NULL,
  observed_at DATETIME(3) NOT NULL,
  valid_from DATE NULL,
  valid_to DATE NULL,
  PRIMARY KEY (category_id),
  UNIQUE KEY uq_rka_category_version (source_system, source_category, observed_at),
  KEY idx_rka_category_label (source_category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_fact_rka_target (
  rka_target_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  office_id BIGINT UNSIGNED NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  target_month DATE NOT NULL,
  source_value_text VARCHAR(128) NULL,
  target_value DECIMAL(38,15) NULL,
  amount_unit_code VARCHAR(24) NULL,
  PRIMARY KEY (rka_target_id),
  UNIQUE KEY uq_rka_source_month (object_id, source_row_number, target_month),
  KEY idx_rka_month_category_office (target_month, category_id, office_id),
  CONSTRAINT fk_rka_month FOREIGN KEY (target_month)
    REFERENCES dashboard_dim_date (calendar_date),
  CONSTRAINT fk_rka_office FOREIGN KEY (office_id) REFERENCES dashboard_dim_office (office_id),
  CONSTRAINT fk_rka_category FOREIGN KEY (category_id)
    REFERENCES dashboard_dim_rka_category (category_id),
  CONSTRAINT fk_rka_batch FOREIGN KEY (batch_id)
    REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_rka_object FOREIGN KEY (object_id)
    REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

`dashboard_domain_publication` hanya menunjuk batch yang sudah divalidasi; aplikasi memeriksa status serta rekonsiliasi sebelum perubahan pointer. Publikasi/rollback wajib satu transaksi InnoDB: kunci row pointer, validasi expected `publication_version`, tulis history event dan perbarui pointer/version. Bila transaksi gagal, keduanya rollback bersama. History bersifat append-only; rollback adalah event baru yang menunjuk ke batch sebelumnya, bukan menghapus event/fakta. FK saja tidak dapat menjamin status batch `validated`/`published`, sehingga prasyarat status dan count diverifikasi di service sebelum commit.

Row pointer awal dibuat oleh runtime (bukan migration seed): `(domain_key, scope_key)` dengan `batch_id=NULL`, `publication_version=0`. Proses publish memastikan row ada, lalu `SELECT ... FOR UPDATE`; hanya batch dengan status tervalidasi dan seluruh rekonsiliasi lolos yang dapat dipublikasikan. API membaca batch dari pointer ini saja. Scope harus stabil dan terdokumentasi—contoh Appraisal `YYYY-MM:RO` atau `YYYY-MM:KP`; untuk data snapshot tunggal gunakan `default`.

Unique `(source_id, source_checksum, parser_version)` menjadikan retry konten yang sama memakai batch yang sama; parser version baru membuat batch baru. Jika batch masih berjalan atau gagal karena gangguan sementara, worker melanjutkan batch/object yang sama secara idempoten; jika parser/transformasi diperbaiki, gunakan versi parser baru dan batch baru. Konflik unique saat dua worker memulai konten yang sama harus membaca batch yang telah terdaftar, bukan membuat batch kedua. Untuk retry chunk, importer memakai kembali `object_id` dan unique `(object_id, source_row_number)` di staging/fakta. Duplikasi konten antar nomor baris tetap dipertahankan. Relasi `batch_id` pada identity dan object dasarnya harus diperiksa cocok oleh importer karena foundation tidak menyediakan composite FK pasangan itu.

DDL domain Prognosa, Appraisal, master/history, RKA, dan `dashboard_import_issue` masih berupa definisi katalog, bukan DDL lengkap pada contoh. Sebelum DDL domain disetujui, setiap tabel harus mendapat DDL executable tersendiri beserta semua FK/index, kemudian ditinjau terhadap parser dan skema foundation. Bentuk data yang unresolved tetap nullable/raw dan tidak diberi mapping buatan.

## 6. Pemetaan sumber → pipeline → staging → final → API → fitur

| Sumber | Pipeline impor | Staging | Tabel terkurasi | API runtime target | Fitur |
|---|---|---|---|---|---|
| `segmen_data.json` | Snapshot full awal; stream/chunk, checksum; validasi raw dan parser saldo | `dashboard_stg_position_row` | `dashboard_fact_position_daily`, `dashboard_dim_date`, `dashboard_dim_product`, `dashboard_dim_segment`, mapping kantor | `/api/funding/summary`, `/trend`, `/filters` | Posisi Dana, grafik, kartu, filter; input Marginal dan Detail |
| `tabel_rka.json` | Snapshot full; simpan angka raw; parse month cell dan kategori | `dashboard_stg_rka_row` | `dashboard_fact_rka_target`, `dashboard_dim_rka_category`, `dashboard_rka_metric_mapping`, `dashboard_dim_office` | `/api/funding/summary`, `/api/marginal`, `/api/detail-units` | Target, gap/pencapaian yang telah terverifikasi, Marginal, Detail Unit |
| `uker_list.json` | Snapshot master; kode unik/relasi parent check | `dashboard_stg_office_row` | `dashboard_dim_office`, `dashboard_dim_office_version`, `dashboard_office_relationship` | `/api/master/offices`, `/api/funding/filters` | Semua filter, daftar unit, hierarki, assignment |
| `rmft_list.json` | Snapshot master; PN dan unit-code check | `dashboard_stg_rmft_row` | `dashboard_dim_rmft`, `dashboard_rmft_assignment` | `/api/master/rmft`, profil Appraisal | Appraisal dan filter RMFT |
| Workbook dan `prognosa_data.json` | Import offline/backend; empat sheet saja; checksum; cache formula result tidak dihitung ulang | `dashboard_stg_prognosis_row` | `dashboard_fact_prognosis_value` dan metadata sumber | `/api/prognosis`; eventual funding summary | Prognosa; sheet/kolom yang sah berdasarkan pilihan segmen |
| Google Sheets Appraisal | Poll/read-only server-side; snapshot per sheet/periode setelah akses pulih; header fingerprint | `dashboard_stg_appraisal_row` | `dashboard_fact_appraisal_snapshot`, `dashboard_fact_appraisal_metric`, `dashboard_dim_appraisal_metric` | Pertahankan `/api/appraisal/sources` dan `/api/appraisal/data`, kemudian backend MySQL | Tier, statistik produktivitas, detail dan histori |
| `src/data.ts` | Tidak ada hingga status placeholder dan penggunaan runtime dikonfirmasi | — | — | Tidak disajikan | Tidak dianggap sumber bisnis |

API di tabel adalah rekomendasi rancangan, bukan endpoint yang sudah tersedia selain dua endpoint Appraisal tersebut.

## 7. Import, batch, retry, publikasi, dan rollback

1. Catat sumber, file/sheet, checksum SHA-256, byte size, waktu modifikasi, versi parser dan baseline jumlah row sebelum parse.
2. `segmen_data.json` (~236 MB) diproses backend dengan parser streaming JSON; jangan memuat seluruh file ke React/browser atau membuat salinan re-serialized seolah raw byte-identical. Chunk staging disarankan 1.000–5.000 baris setelah benchmark memori/DB. Setiap baris membawa `object_id + source_row_number` untuk retry idempoten, tetapi duplikasi konten tetap disimpan.
3. Sumber file lokal tidak memberi CDC stabil. Perubahan file memicu batch snapshot baru; jangan mengklaim incremental sync. Jika kelak tersedia delta feed/timestamp baris resmi, buat pipeline incremental terpisah dan parity terhadap snapshot penuh.
4. Master dan RKA berukuran kecil dimuat snapshot per file; buat versi dimensi/histori. RKA JAN–DEC menjadi fakta bulanan setelah nilai raw tervalidasi.
5. Workbook Prognosa diimpor secara eksplisit ketika file baru diberikan. Bandingkan checksum; hanya sheet yang disetujui. Simpan formula cached result dan row/cell source.
6. Google Sheets Appraisal dapat dipoll dari backend setelah akses dipulihkan. Jika revision token/modified time tidak tersedia, ambil snapshot lalu bandingkan fingerprint. Jangan menghapus row histori ketika sumber tidak mengembalikan baris; catat snapshot dan kebijakan superseding.
7. Batch gagal atau warning kritis tetap di staging dan `dashboard_import_issue`. Jangan menjadi versi aktif sampai count, parse, mapping, dan rekonsiliasi lolos.
8. Status pada `dashboard_import_batch.status` mengikuti lifecycle yang diusulkan (`created`, `staging`, `validated`, `published`, `failed`); kolom foundation bertipe VARCHAR, sehingga service yang memvalidasi transisi status. Batch gagal tetap tersimpan dan tidak dipublikasikan.
9. Publikasi mengganti pointer `(domain_key, scope_key)` secara atomik. Rollback memilih batch valid terdahulu melalui event baru; jangan DROP/TRUNCATE fakta.
10. File JSON/XLSX tetap di arsip terkendali dengan checksum. Lokasi/retensi dan akses arsip ditetapkan operasional, bukan di `public/`.

## 8. Validasi kesetaraan sebelum runtime cutover

- **Semua import:** checksum, row counts, raw-vs-staged-vs-final, error rows, null/blank/zero, duplicate signatures dan parser version.
- **Idempotensi/publikasi:** checksum + parser version sama merujuk batch yang sama; retry chunk tidak membuat row kedua; konten serupa pada nomor sumber berbeda tetap disimpan. Batch gagal/invalid tidak pernah menjadi pointer aktif. Publisher per domain/scope diserialisasi; versi pointer bertambah satu; kegagalan sebelum commit tidak mengubah pointer maupun history. Rollback membuat event baru dan mengaktifkan batch lama tanpa menghapus batch/fakta.
- **Posisi:** rekonsiliasi nilai sumber/UI-compatible per tanggal × segmen × produk dan per label kantor yang cocok; cek nilai raw/DECIMAL tanpa rounding, zero preservation, rentang 66 tanggal, distribusi record serta row signature. Rekonsiliasi grand total bukan bukti join kantor benar.
- **RKA:** semua kode unit, kategori exact, 12 bulan, 708 empty cells saat baseline, parser titik-ribuan/koma-desimal, sum per kategori/kode/bulan dan cakupan unit valid. RKA Retail vs Mikro dipisahkan.
- **Master unit:** jumlah 611, keunikan kode, 46/35/530 tipe, parent KC, 530 Rural Urban kosong, histori dan orphan unit. Hierarki UNIT→KCP hanya diuji setelah sumber resmi diterima.
- **RMFT:** 192 PN, unique snapshot, relasi kode unit termasuk dua kode 854 unresolved, assignment efektif dan tanpa join nama.
- **Prognosa:** row count per sheet 51/130/45/193, source range, label/header, cell values, cached formula counts dan subtotal/grand total. Kosong vs 0; jangan mengubah skala/unit. Jangan menjumlahkan subtotal dengan detail.
- **Appraisal:** setelah API dapat diakses, bandingkan jumlah sheet/record per periode/RO-KP, header fingerprint, PN multiplicity, KPI numeric/null, tier raw dan stats. Sampai akses live pulih, parity Appraisal belum bisa disetujui.
- **UI/API:** shadow read dibanding sumber lama dengan filter identik; verifikasi response, KPI, tabel, grafik, loading/error, pagination, filter/reset, dan performa. Per feature cutover hanya setelah owner menandatangani parity.

## 9. Pertanyaan bisnis yang harus dikonfirmasi

1. Apakah ada pemetaan resmi kode untuk dua RMFT dengan `Kode Uker=854`? Jangan cocokkan nama sebagai pengganti.
2. Apa sumber resmi parent KCP bagi unit-unit UNIT? `MAIN BRANCH CODE` membuktikan parent KC, bukan parent KCP.
3. Bagaimana record posisi tanpa kode unit dipetakan ke master? Apakah ada kode posisi tambahan di feed lain atau kamus alias yang dikelola pemilik?
4. Apakah `KORPORASI` identik dengan segmen Wholesale untuk seluruh metrik dan periode dashboard? Jangan menyimpulkan dari label saja.
5. Apakah target `Retail Funding` berlaku terhadap aktual RITEL saja, RITEL+MIKRO, atau kategori lain? Konfirmasi juga kategori DPK/produk dan Average Daily.
6. Apa grain resmi setiap row posisi? Apakah dua row dengan nilai dan label identik dapat mewakili rekening/bucket berbeda? Jangan dedup sebelum ada jawabannya.
7. Apa unit dan skala nominal Posisi Dana, RKA, serta masing-masing metrik Prognosa? Metadata Forecast menyatakan `currencyUnit=null`.
8. Apa arti/definisi resmi setiap blok Prog: `KOMITMEN SBO`, `KOMITMEN BO`, `Per AH`, `PER RMFT`; apakah SBO tumpang tindih dengan BO; baris mana detail/subtotal/grand total?
9. Apakah cached formula result workbook adalah nilai otoritatif? Siapa yang merefresh formula, dan apakah formula expression perlu diarsipkan terpisah?
10. Apa rentang tanggal W1–W5 dan arti kolom tanggal/header yang muncul? Workbook tidak memberi metadata rentang W; jangan inferensi dari label mingguan.
11. Apa schema live Appraisal dan periode/sumber yang valid? Endpoint gagal 502 saat audit ini; pemilik data perlu memulihkan akses atau memberikan export read-only.
12. Apakah sheet Appraisal memuat unit, jabatan dan tier dengan header sama untuk setiap periode/sumber? Kode mengharuskan header tertentu tetapi sheet live belum dapat diperiksa.
13. Apa otorisasi pembaca dan retensi data Appraisal? PN login frontend yang terlihat di kode belum dengan sendirinya membuktikan autentikasi API terotorisasi.
14. Apa jadwal pemilik/trigger file lokal dan polling Sheets, zona waktu bisnis, serta masa retensi raw batch?
15. Apakah master unit/RMFT memiliki snapshot historis resmi, atau histori hanya mulai waktu cutover?

## 10. Urutan migrasi yang direkomendasikan

1. Jawab keputusan bisnis di atas dan tetapkan unit/precision nominal dengan pemilik data.
2. Review/terapkan migration metadata tahap fondasi hanya setelah backup MySQL 8.4.11 diverifikasi. Jangan mencampur DDL domain dan impor.
3. Staging serta validasi master unit/RMFT; selesaikan orphan mapping tanpa nama heuristik.
4. RKA staging/curation dengan kategori exact dan null semantics; validasi per kode, kategori, bulan.
5. Posisi Dana streaming full load, raw retention, recon, kemudian curated facts.
6. Prognosa snapshot per workbook, setelah cakupan group, nilai cached, unit dan labels dipastikan.
7. Appraisal setelah Google Sheets dapat dibaca, schema/live snapshot ditinjau, dan otorisasi ditetapkan.
8. Bangun API backend MySQL per domain, jalankan shadow parity tanpa mengalihkan UI.
9. Alihkan satu fitur sekali melalui feature flag, observasi, siapkan rollback ke API/snapshot lama, baru lanjut domain berikutnya.

**Tidak ada implementasi skema atau koneksi DB dilakukan dalam tahap rancangan ini.** Appraisal live belum dapat diverifikasi; parity seluruh fitur belum dapat dinyatakan selesai.
