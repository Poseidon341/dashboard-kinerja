import pandas as pd
import re

# 1. Baca file CSV asli
df = pd.read_csv('Dashboard - segmen_data (2).csv')

# 2. Fungsi untuk mengubah string nominal menjadi angka murni
def bersihkan_saldo(s):
    if pd.isna(s): return 0
    s_str = str(s).strip().replace('Rp', '').replace(' ', '')
    # Sesuaikan format koma ribuan
    if ',' in s_str: 
        s_str = s_str.replace('.', '').replace(',', '.')
    # Sisakan hanya angka murni
    s_str = re.sub(r'[^0-9.-]', '', s_str)
    try:
        return float(s_str)
    except:
        return 0

print("Sedang memproses data... Mohon tunggu sebentar.")

# Terapkan pembersihan angka
df['Saldo'] = df['Saldo'].apply(bersihkan_saldo)

# 3. HAPUS SEMUA BARIS DENGAN SALDO 0 (Membuang 82% data tidak berguna)
df = df[df['Saldo'] != 0]

# 4. HAPUS KOLOM YANG TIDAK DIPAKAI (Menghemat ruang teks)
if 'Jumlah Rekening' in df.columns:
    df = df.drop(columns=['Jumlah Rekening'])

# 5. Simpan ke JSON dengan kompresi maksimal (tanpa spasi/enter tambahan)
# Orient 'records' membuat format array of objects standar
df.to_json('segmen_data.json', orient='records', separators=(',', ':'))

print(f"Selesai! File berhasil dikompresi menjadi {len(df)} baris data efektif.")