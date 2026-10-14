import json
import os

file_awal = os.path.join('data', 'source-archive', 'segmen_data_mentah.json')
file_hasil = os.path.join('data', 'source-archive', 'segmen_data_compressed.json')

print("1. Sedang membaca file JSON mentah 159 MB...")
with open(file_awal, 'r', encoding='utf-8') as f:
    raw_data = json.load(f)

print(f"   -> Total baris awal: {len(raw_data)}")

seen = set()
cleaned_data = []

for row in raw_data:
    pos = str(row.get('Posisi', '')).strip()
    cabang = str(row.get('Nama Cabang', '')).strip()
    uker = str(row.get('Nama Uker', '')).strip()
    segmen = str(row.get('Segmentasi BPR', '')).strip()
    produk = str(row.get('Produk', '')).strip()
    
    if not pos or not uker:
        continue

    # 2. PERBAIKAN UTAMA SALDO: Membersihkan format .00 agar angka tidak bengkak
    saldo_raw = str(row.get('Saldo', '0')).strip()
    try:
        # Menghapus koma ribuan lalu mengubah ke integer murni untuk membuang .00
        val_str = saldo_raw.replace(',', '')
        saldo_clean = str(int(float(val_str)))
    except ValueError:
        saldo_clean = "0"

    row['Saldo'] = saldo_clean

    # 3. Mencegah duplikasi baris yang sama persis agar ukuran file kecil
    unique_key = (pos, cabang, uker, segmen, produk)
    if unique_key in seen:
        continue
    seen.add(unique_key)

    # Membuang kolom 'Jumlah Rekening' untuk menghemat tempat
    if 'Jumlah Rekening' in row:
        del row['Jumlah Rekening']

    cleaned_data.append(row)

print(f"   -> Total baris setelah dibersihkan & deduplikasi: {len(cleaned_data)}")

print("4. Menyimpan file yang sudah dipadatkan (Minify)...")
with open(file_hasil, 'w', encoding='utf-8') as f:
    json.dump(cleaned_data, f, separators=(',', ':'), ensure_ascii=False)

ukuran_akhir = os.path.getsize(file_hasil) / (1024 * 1024)
print(f"\n✅ SELESAI! Ukuran file baru sekarang: {ukuran_akhir:.2f} MB (Sangat Ringan!)")
